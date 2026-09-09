// The "harbor gate": a deployer-owned Caddy instance that routes
// subdomain.<base_domain> → localhost:<project port>. The system Caddy (run by
// the admin, TLS included) forwards the wildcard to this one with a single
// static site block; everything dynamic happens here, inside the panel's own
// permission domain. This instance speaks plain HTTP on localhost and is
// managed as a pm2 process so it shows up in the Engine room.
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getSetting } from '../db/settings.js'
import { startOrReload, describe, deleteProcess } from '../deploy/pm2.js'
import { APEX } from '../lib/validate.js'

export const PROXY_PROCESS = 'skeppa-proxy'

export function proxySettings(db) {
  return {
    baseDomain: getSetting(db, 'proxy_base_domain'),
    httpPort: Number(getSetting(db, 'proxy_http_port') ?? 8100),
    adminPort: Number(getSetting(db, 'proxy_admin_port') ?? 2020),
  }
}

export function proxyRouteRows(db) {
  return db.query(
    `SELECT p.id, p.name, p.slug, p.subdomain, p.port,
            COALESCE(u.role, '') AS owner_role, COALESCE(u.handle, '') AS owner_handle, COALESCE(u.domain, '') AS owner_domain
     FROM projects p LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.subdomain IS NOT NULL AND p.port IS NOT NULL ORDER BY p.subdomain`
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

// Full Caddy JSON config for the local instance. Returns null when no base
// domain is configured (the feature is off). The admin endpoint must not use
// caddy's default :2019 — that's usually taken by the system instance.
export function buildCaddyConfig(db) {
  const { baseDomain, httpPort, adminPort } = proxySettings(db)
  if (!baseDomain) return null

  const routes = proxyRouteRows(db).map(p => ({
    match: [{ host: [routedHost(p, baseDomain)] }],
    handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${p.port}` }] }],
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
}) {
  const dir = join(config.dataDir, 'proxy')
  const configPath = join(dir, 'caddy.json')
  const ecosystemPath = join(dir, 'ecosystem.config.cjs')
  let lastError = null
  let lastAppliedAt = null

  // Regenerate the config from the DB and make the running instance match it:
  // hot-reload through the admin API when the instance is up, otherwise
  // (re)start it under pm2 — caddy reads the config file at startup.
  async function apply() {
    try {
      const caddyConfig = buildCaddyConfig(db)
      if (!caddyConfig) return { applied: false, reason: 'no base domain configured' }

      mkdirSync(dir, { recursive: true })
      writeFileSync(configPath, JSON.stringify(caddyConfig, null, 2) + '\n')

      const { adminPort } = proxySettings(db)
      try {
        const res = await fetchFn(`http://localhost:${adminPort}/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(caddyConfig),
          signal: AbortSignal.timeout(3000),
        })
        if (!res.ok) throw new Error(`caddy admin API: ${res.status} ${await res.text()}`)
      } catch {
        const caddyBin = which('caddy')
        if (!caddyBin) {
          throw new Error('caddy binary not found on PATH — install caddy for the panel user')
        }
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
      process_status: proc?.pm2_env?.status ?? null,
      routes: proxyRouteRows(db).map(p => ({
        project_id: p.id,
        name: p.name,
        subdomain: p.subdomain,
        host: `${p.subdomain}.${settings.baseDomain ?? '…'}`,
        port: p.port,
      })),
      config_path: configPath,
      last_error: lastError,
      last_applied_at: lastAppliedAt,
    }
  }

  return { apply, stop, status }
}
