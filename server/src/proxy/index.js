// The "harbor gate": a deployer-owned Caddy instance that routes
// subdomain.<base_domain> → localhost:<project port>. The system Caddy (run by
// the admin, TLS included) forwards the wildcard to this one with a single
// static site block; everything dynamic happens here, inside the panel's own
// permission domain. This instance speaks plain HTTP on localhost and is
// managed as a pm2 process so it shows up in the Engine room.
import { join } from 'node:path'
import { mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { getSetting } from '../db/settings.js'
import { startOrReload, describe, deleteProcess } from '../deploy/pm2.js'
import { APEX } from '../lib/validate.js'
import { PROXY_PM2_NAME } from '../lib/runtime.js'
import { HASHED_ASSET_PATTERN } from '../deploy/publish.js'
import { systemEnvBase } from '../lib/shell.js'

export const PROXY_PROCESS = PROXY_PM2_NAME

export function proxySettings(db) {
  return {
    baseDomain: getSetting(db, 'proxy_base_domain'),
    httpPort: Number(getSetting(db, 'proxy_http_port') ?? 8100),
    adminPort: Number(getSetting(db, 'proxy_admin_port') ?? 2020),
  }
}

export function proxyRouteRows(db) {
  return db.query(
    // The route follows what is deployed, not what the form says: a project
    // switched to static keeps its proxy route until a deploy has published.
    `SELECT p.id, p.name, p.slug, p.subdomain, p.port, p.spa_fallback, p.gate_files,
            CASE WHEN p.deployed_runtime != '' THEN p.deployed_runtime ELSE p.runtime END AS runtime,
            COALESCE(u.role, '') AS owner_role, COALESCE(u.handle, '') AS owner_handle, COALESCE(u.domain, '') AS owner_domain,
            COALESCE(u.username, '') AS owner_username
     FROM projects p LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.subdomain IS NOT NULL
       AND (p.port IS NOT NULL OR (CASE WHEN p.deployed_runtime != '' THEN p.deployed_runtime ELSE p.runtime END) = 'static')
     ORDER BY p.subdomain`
  ).all()
}

// The public host for a routed project. A tenant with a domain of their own
// routes subdomain.<domain>, or the domain itself for the project whose
// subdomain is '@'. Other tenants live under their handle —
// subdomain.handle.base — so each tenant namespace is one more one-label
// wildcard site block (with its own DNS-01 cert) in the admin's system
// Caddy; admin projects keep the flat names that already have certs.
export function routedHost(row, baseDomain) {
  if (row.owner_role === 'tenant' && row.owner_domain) {
    return row.subdomain === APEX ? row.owner_domain : `${row.subdomain}.${row.owner_domain}`
  }
  const nested = row.owner_role === 'tenant' && row.owner_handle
  return `${row.subdomain}.${nested ? `${row.owner_handle}.` : ''}${baseDomain}`
}

// Where a static project's published snapshot lives (deploy/publish.js) —
// the only directory the gate ever serves files from.
export function staticRoot(config, slug) {
  return join(config.appsDir, slug, 'public')
}

// Serving files from a snapshot, compressed and with caching that fits
// them: HTML is revalidated on every load (file_server sends an ETag, so
// that is a 304, not a download) and so always points at the current build;
// a content-hashed asset never changes under its name and is kept for a
// year. Everything else keeps the browser's own heuristics.
const setCache = value => ({ handler: 'headers', response: { set: { 'Cache-Control': [value] } } })

function fileRoutes(root) {
  return [
    { handle: [{ handler: 'encode', encodings: { zstd: {}, gzip: {} }, prefer: ['zstd', 'gzip'] }] },
    { match: [{ path: ['*.html', '*/'] }], handle: [setCache('no-cache')] },
    { match: [{ path_regexp: { pattern: HASHED_ASSET_PATTERN } }], handle: [setCache('public, max-age=31536000, immutable')] },
    { handle: [{ handler: 'file_server', root }] },
  ]
}

// A static site, served straight from its snapshot. With the fallback on,
// a path that is no file is answered with index.html (the Caddyfile's
// `try_files {path} /index.html`), which is what a client-side router needs
// for a reload on /about to work.
function staticHandlers(root, spaFallback) {
  const routes = []
  if (spaFallback) {
    routes.push({
      match: [{ file: { root, try_files: ['{http.request.uri.path}', '/index.html'] } }],
      handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
    })
  }
  return [{ handler: 'subroute', routes: [...routes, ...fileRoutes(root)] }]
}

// An app whose build output the gate serves (projects.gate_files): a GET or
// HEAD for something that is in the snapshot is a file — a directory path
// only when it has an index.html, so `/` is the build's index.html — and
// everything else, every other method included, goes to the app as before.
// The file matcher counts a try_files entry ending in / as a directory and
// any other as a file, hence the two routes. With no snapshot (not
// deployed with the option yet) nothing matches and this is a plain proxy.
function gateFilesHandlers(root, port) {
  const read = { method: ['GET', 'HEAD'] }
  return [{
    handler: 'subroute',
    routes: [
      {
        match: [{ ...read, path: ['*/'], file: { root, try_files: ['{http.request.uri.path}index.html'] } }],
        handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }, { handler: 'subroute', routes: fileRoutes(root) }],
        terminal: true,
      },
      {
        match: [{ ...read, not: [{ path: ['*/'] }], file: { root, try_files: ['{http.request.uri.path}'] } }],
        handle: [{ handler: 'subroute', routes: fileRoutes(root) }],
        terminal: true,
      },
      { handle: [proxyTo(port)] },
    ],
  }]
}

const proxyTo = port => ({ handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${port}` }] })

// `caddy version` prints e.g. "v2.8.4 h1:…" (distro builds may drop the v).
// null when there is nothing recognizable — a dev build, say.
export function parseCaddyVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${m[1]}.${m[2]}.${m[3]}` } : null
}

// The server's trusted_proxies with an IP-source module is Caddy 2.6.3+
// (tried: 2.6.2 — Debian's and Ubuntu's package — refuses the whole config
// over that one field, 2.6.3 takes it). Unknown counts as too old: the
// gate working matters more than forwarded headers.
export const trustsProxies = version => {
  if (!version) return false
  const { major, minor, patch } = version
  return major > 2 || (major === 2 && (minor > 6 || (minor === 6 && patch >= 3)))
}

// Full Caddy JSON config for the local instance. Returns null when no base
// domain is configured (the feature is off). The admin endpoint must not use
// caddy's default :2019 — that's usually taken by the system instance.
// `config` (for APPS_DIR) is only needed once a static project is routed.
// `trustLoopback` is off for a gate Caddy older than 2.6.3 (trustsProxies).
export function buildCaddyConfig(db, config = {}, { trustLoopback = true } = {}) {
  const { baseDomain, httpPort, adminPort } = proxySettings(db)
  if (!baseDomain) return null

  const routes = proxyRouteRows(db).map(p => ({
    match: [{ host: [routedHost(p, baseDomain)] }],
    handle: p.runtime === 'static'
      ? staticHandlers(staticRoot(config, p.slug), Boolean(p.spa_fallback))
      : p.gate_files
        ? gateFilesHandlers(staticRoot(config, p.slug), p.port)
        : [proxyTo(p.port)],
  }))
  // Unmatched hosts get an explicit 404 instead of caddy's empty default.
  routes.push({
    handle: [{ handler: 'static_response', status_code: 404, body: 'unknown harbor\n' }],
  })

  return {
    admin: { listen: `localhost:${adminPort}` },
    apps: {
      http: {
        servers: {
          skeppa: {
            listen: [`:${httpPort}`],
            routes,
            automatic_https: { disable: true },
            // The system Caddy in front (on this machine) is a proxy to trust:
            // keep the X-Forwarded-For/-Proto/-Host it sends instead of
            // overwriting them with 127.0.0.1 and "http", so an app still sees
            // the client's address and that it came over https (Secure
            // cookies, absolute URLs). Nobody else's headers are kept.
            ...(trustLoopback ? { trusted_proxies: { source: 'static', ranges: ['127.0.0.1/32', '::1/128'] } } : {}),
          },
        },
      },
    },
  }
}

export function createProxy({
  db,
  config,
  pm2 = { startOrReload, describe, deleteProcess },
  fetchFn = fetch,
  which = exe => Bun.which(exe),
  run = runCaddy,
}) {
  const dir = join(config.dataDir, 'proxy')
  // Always the last config the gate accepted, so a crash or a reboot
  // brings back routes that work. A new one is tried as caddy.next.json.
  const configPath = join(dir, 'caddy.json')
  const candidatePath = join(dir, 'caddy.next.json')
  const ecosystemPath = join(dir, 'ecosystem.config.cjs')
  let lastError = null
  let lastAppliedAt = null

  // Asked once per binary — a new mtime means Caddy was upgraded in place.
  const versions = new Map()
  function caddyVersion(bin) {
    if (!bin) return null
    let key = bin
    try {
      key = `${bin}:${statSync(bin).mtimeMs}`
    } catch {
      // not stat-able (a test double, a vanished binary): cache by path
    }
    if (!versions.has(key)) {
      let version = null
      try {
        version = parseCaddyVersion(run([bin, 'version']).stdout)
      } catch {
        // could not run it — unknown
      }
      versions.set(key, version)
    }
    return versions.get(key)
  }

  // Regenerate the config from the DB and make the running instance match it:
  // hot-reload through the admin API when the instance is up, otherwise
  // (re)start it under pm2 — caddy reads the config file at startup.
  //
  // A running gate that REFUSES the config is not a gate that is down: it
  // keeps serving the old routes, and restarting it would only make it read
  // a config it cannot load and crash-loop with every site down. So a
  // refusal is reported and nothing else happens; only an unreachable
  // admin API leads to a (re)start, and then only with a config `caddy
  // validate` has accepted.
  async function apply() {
    try {
      const caddyBin = which('caddy')
      const version = caddyVersion(caddyBin)
      const caddyConfig = buildCaddyConfig(db, config, { trustLoopback: trustsProxies(version) })
      if (!caddyConfig) return { applied: false, reason: 'no base domain configured' }

      mkdirSync(dir, { recursive: true })
      writeFileSync(candidatePath, JSON.stringify(caddyConfig, null, 2) + '\n')
      const accept = () => renameSync(candidatePath, configPath)
      const caddyName = `caddy${version ? ` ${version.text}` : ''}`

      const { adminPort } = proxySettings(db)
      let res = null
      try {
        res = await fetchFn(`http://localhost:${adminPort}/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(caddyConfig),
          signal: AbortSignal.timeout(3000),
        })
      } catch {
        res = null // not reachable: started below
      }
      if (res && !res.ok) {
        const detail = await res.text().catch(() => '')
        rmSync(candidatePath, { force: true })
        throw new Error(`the harbor gate (${caddyName}) refused the new config and keeps serving the previous one: ${res.status} ${detail}`.trim())
      }
      if (res) {
        accept()
      } else {
        if (!caddyBin) {
          rmSync(candidatePath, { force: true })
          throw new Error('caddy binary not found on PATH — install caddy for the panel user')
        }
        const check = run([caddyBin, 'validate', '--config', candidatePath])
        if (check.exitCode !== 0) {
          rmSync(candidatePath, { force: true })
          const why = `${check.stderr}\n${check.stdout}`.split('\n').map(l => l.trim()).find(l => /^(Error|validate):/.test(l)) ?? `exit ${check.exitCode}`
          throw new Error(`${caddyName} cannot load the generated config, so the harbor gate was not started: ${why}`)
        }
        accept()
        const eco = {
          apps: [{
            name: PROXY_PROCESS,
            script: caddyBin,
            args: `run --config ${configPath}`,
            interpreter: 'none',
            autorestart: true,
            max_restarts: 10,
          }],
        }
        writeFileSync(ecosystemPath, `module.exports = ${JSON.stringify(eco, null, 2)}\n`)
        await pm2.startOrReload(ecosystemPath)
      }

      lastError = null
      lastAppliedAt = new Date().toISOString()
      return { applied: true, routes: caddyConfig.apps.http.servers.skeppa.routes.length - 1 }
    } catch (err) {
      lastError = err.message
      throw err
    }
  }

  // Called when the base domain is cleared: stop routing entirely.
  async function stop() {
    await pm2.deleteProcess(PROXY_PROCESS)
    lastError = null
  }

  async function status() {
    const settings = proxySettings(db)
    let proc = null
    try {
      proc = await pm2.describe(PROXY_PROCESS)
    } catch {
      // pm2 unreachable — reported as "not running", which is true enough
    }
    return {
      base_domain: settings.baseDomain,
      http_port: settings.httpPort,
      admin_port: settings.adminPort,
      caddy_available: !!which('caddy'),
      // '' when unknown. Below 2.6.3 the gate cannot trust the system Caddy's
      // forwarded headers, and the UI says what that costs.
      caddy_version: caddyVersion(which('caddy'))?.text ?? '',
      forwarded_headers: trustsProxies(caddyVersion(which('caddy'))),
      process_status: proc?.pm2_env?.status ?? null,
      routes: proxyRouteRows(db).map(p => ({
        project_id: p.id,
        name: p.name,
        subdomain: p.subdomain,
        // The host the gate actually routes — built by the same function as
        // the Caddy config, so a tenant's handle or domain shows as it is.
        host: settings.baseDomain ? routedHost(p, settings.baseDomain) : `${p.subdomain}.…`,
        owner: p.owner_username,
        owner_role: p.owner_role,
        // A static route serves files; there is no port to dial.
        static: p.runtime === 'static',
        // An app route that answers with the build's files first.
        files: p.runtime !== 'static' && Boolean(p.gate_files),
        port: p.port,
      })),
      config_path: configPath,
      last_error: lastError,
      last_applied_at: lastAppliedAt,
    }
  }

  return { apply, stop, status }
}

// Runs the caddy binary for `version` and `validate`, with the minimal
// environment everything the panel spawns gets.
function runCaddy(args) {
  const res = Bun.spawnSync(args, { env: systemEnvBase(), stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() }
}
