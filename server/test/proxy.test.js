import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, getSetting } from '../src/db/settings.js'
import { buildCaddyConfig, createProxy, PROXY_PROCESS } from '../src/proxy/index.js'
import { proxyApiRoutes } from '../src/routes/proxy.js'
import { projectRoutes } from '../src/routes/projects.js'
import { writeEcosystem, runtimeEnv, decryptedEnv } from '../src/deploy/envfiles.js'
import { createLiveState } from '../src/live/state.js'

function makeDb() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  return db
}

function addProject(db, { slug, subdomain = null, port = null, start = '' }) {
  return Number(db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, start_command, subdomain, port)
     VALUES (?, ?, 'luff/app', 'main', ?, ?, ?, ?)`
  ).run(slug, slug, slug, start, subdomain, port).lastInsertRowid)
}

// --- config generation ------------------------------------------------------

test('no base domain → no config', () => {
  const db = makeDb()
  addProject(db, { slug: 'app', subdomain: 'app', port: 4001 })
  expect(buildCaddyConfig(db)).toBe(null)
})

test('builds host routes plus a 404 fallback', () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  addProject(db, { slug: 'app', subdomain: 'app', port: 4001 })
  addProject(db, { slug: 'blog', subdomain: 'blog', port: 4002 })
  addProject(db, { slug: 'unrouted' })

  const cfg = buildCaddyConfig(db)
  expect(cfg.admin.listen).toBe('localhost:2020')
  const server = cfg.apps.http.servers.skeppa
  expect(server.listen).toEqual([':8100'])
  expect(server.automatic_https.disable).toBe(true)
  // The system Caddy on loopback is trusted to say who asked and over what
  expect(server.trusted_proxies).toEqual({ source: 'static', ranges: ['127.0.0.1/32', '::1/128'] })
  expect(server.routes).toHaveLength(3) // 2 projects + fallback
  expect(server.routes[0].match[0].host).toEqual(['app.apps.example.com'])
  expect(server.routes[0].handle[0].upstreams).toEqual([{ dial: 'localhost:4001' }])
  expect(server.routes.at(-1).handle[0].handler).toBe('static_response')
})

test('honors custom ports from settings', () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  setSetting(db, 'proxy_http_port', '9000')
  setSetting(db, 'proxy_admin_port', '2021')
  const cfg = buildCaddyConfig(db)
  expect(cfg.apps.http.servers.skeppa.listen).toEqual([':9000'])
  expect(cfg.admin.listen).toBe('localhost:2021')
})

// --- apply ------------------------------------------------------------------

// adminOk: true (accepts), false (unreachable) or a status the running gate
// answers with. `version` is what `caddy version` prints; `valid` what
// `caddy validate` decides.
// A second harness writing into an existing data dir.
function createProxyLike(harness, dataDir) {
  const calls = { fetch: [], startOrReload: [], deleted: [], run: [] }
  const proxy = createProxy({
    db: harness.db,
    config: { dataDir },
    fetchFn: async () => ({ ok: false, status: 400, text: async () => 'unknown field' }),
    run: args => (args[1] === 'version' ? { exitCode: 0, stdout: 'v2.8.4', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
    pm2: { startOrReload: async file => calls.startOrReload.push(file), describe: async () => null, deleteProcess: async () => {} },
    which: () => '/usr/bin/caddy',
  })
  return { proxy, calls }
}

function proxyHarness(db, { adminOk = true, caddyFound = true, version = 'v2.8.4 h1:abc=', valid = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'skeppa-proxy-'))
  const calls = { fetch: [], startOrReload: [], deleted: [], run: [] }
  const proxy = createProxy({
    db,
    config: { dataDir },
    fetchFn: async url => {
      calls.fetch.push(url)
      if (adminOk === false) throw new Error('ECONNREFUSED')
      if (adminOk === true) return { ok: true }
      return { ok: false, status: adminOk, text: async () => '{"error":"loading new config: unknown field \\"trusted_proxies\\""}' }
    },
    run: args => {
      calls.run.push(args.slice(1, 2)[0])
      if (args[1] === 'version') return { exitCode: 0, stdout: version, stderr: '' }
      return valid
        ? { exitCode: 0, stdout: '', stderr: 'Valid configuration' }
        : { exitCode: 1, stdout: '', stderr: '{"level":"info"}\nError: loading http app module: unknown field "trusted_proxies"' }
    },
    pm2: {
      startOrReload: async file => calls.startOrReload.push(file),
      describe: async () => null,
      deleteProcess: async name => calls.deleted.push(name),
    },
    which: () => (caddyFound ? '/usr/bin/caddy' : null),
  })
  return { proxy, calls, dataDir, db }
}

test('apply hot-reloads through the admin API and writes the config file', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  addProject(db, { slug: 'app', subdomain: 'app', port: 4001 })

  const { proxy, calls, dataDir } = proxyHarness(db)
  const result = await proxy.apply()
  expect(result).toMatchObject({ applied: true, routes: 1 })
  expect(calls.fetch).toEqual(['http://localhost:2020/load'])
  expect(calls.startOrReload).toEqual([])
  const written = JSON.parse(readFileSync(join(dataDir, 'proxy', 'caddy.json'), 'utf8'))
  expect(written.apps.http.servers.skeppa.routes[0].match[0].host).toEqual(['app.apps.example.com'])
})

test('apply cold-starts caddy under pm2 when the admin API is down', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const { proxy, calls, dataDir } = proxyHarness(db, { adminOk: false })
  await proxy.apply()
  const ecoPath = join(dataDir, 'proxy', 'ecosystem.config.cjs')
  expect(calls.startOrReload).toEqual([ecoPath])
  expect(readFileSync(ecoPath, 'utf8')).toContain(PROXY_PROCESS)
})

test('a running gate that refuses the config keeps it: no restart, the accepted file stays', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const { proxy, dataDir } = proxyHarness(db)
  await proxy.apply()
  const accepted = readFileSync(join(dataDir, 'proxy', 'caddy.json'), 'utf8')

  addProject(db, { slug: 'app', subdomain: 'app', port: 4001 })
  const refusing = proxyHarness(db, { adminOk: 400 })
  // same data dir: the file the gate would come back with after a crash
  const again = createProxyLike(refusing, dataDir)
  await expect(again.proxy.apply()).rejects.toThrow(/refused the new config and keeps serving the previous one: 400/)
  expect(again.calls.startOrReload).toEqual([]) // restarting would crash-loop it with every site down
  expect(readFileSync(join(dataDir, 'proxy', 'caddy.json'), 'utf8')).toBe(accepted)
  expect(existsSync(join(dataDir, 'proxy', 'caddy.next.json'))).toBe(false)
  expect((await again.proxy.status()).last_error).toMatch(/refused/)
})

test('a cold start only happens with a config caddy validates', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const { proxy, calls, dataDir } = proxyHarness(db, { adminOk: false, valid: false })
  await expect(proxy.apply()).rejects.toThrow('caddy 2.8.4 cannot load the generated config, so the harbor gate was not started: Error: loading http app module: unknown field "trusted_proxies"')
  expect(calls.run).toEqual(['version', 'validate'])
  expect(calls.startOrReload).toEqual([])
  expect(existsSync(join(dataDir, 'proxy', 'caddy.json'))).toBe(false)
})

test('the gate trusts the system Caddy only on Caddy 2.6.3 or later', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const written = async version => {
    const { proxy, dataDir } = proxyHarness(db, { version })
    await proxy.apply()
    const server = JSON.parse(readFileSync(join(dataDir, 'proxy', 'caddy.json'), 'utf8')).apps.http.servers.skeppa
    const { caddy_version, forwarded_headers } = await proxy.status()
    return { trusted: 'trusted_proxies' in server, caddy_version, forwarded_headers }
  }
  expect(await written('v2.4.6 h1:x=')).toEqual({ trusted: false, caddy_version: '2.4.6', forwarded_headers: false })
  expect(await written('v2.5.2 h1:x=')).toEqual({ trusted: false, caddy_version: '2.5.2', forwarded_headers: false })
  // Debian's and Ubuntu's package: refuses the field (tried against the real binary)
  expect(await written('v2.6.2 h1:x=')).toEqual({ trusted: false, caddy_version: '2.6.2', forwarded_headers: false })
  expect(await written('v2.6.3 h1:x=')).toEqual({ trusted: true, caddy_version: '2.6.3', forwarded_headers: true })
  expect(await written('2.7.6')).toEqual({ trusted: true, caddy_version: '2.7.6', forwarded_headers: true }) // distro builds drop the v
  expect(await written('v2.11.7 h1:x=')).toEqual({ trusted: true, caddy_version: '2.11.7', forwarded_headers: true })
  expect(await written('(devel)')).toEqual({ trusted: false, caddy_version: '', forwarded_headers: false })
})

test('apply fails clearly when caddy is not installed', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const { proxy } = proxyHarness(db, { adminOk: false, caddyFound: false })
  await expect(proxy.apply()).rejects.toThrow(/caddy binary not found/)
  expect((await proxy.status()).last_error).toMatch(/caddy binary not found/)
})

test('apply is a no-op without a base domain', async () => {
  const db = makeDb()
  const { proxy, calls, dataDir } = proxyHarness(db)
  expect(await proxy.apply()).toMatchObject({ applied: false })
  expect(calls.fetch).toEqual([])
  expect(existsSync(join(dataDir, 'proxy', 'caddy.json'))).toBe(false)
})

// --- /api/proxy -------------------------------------------------------------

test('PUT saves settings, applies, and clearing the domain stops the proxy', async () => {
  const db = makeDb()
  const { proxy, calls } = proxyHarness(db)
  const app = proxyApiRoutes({ db, proxy })
  const put = body => app.request('/', { method: 'PUT', body: JSON.stringify(body) })

  let res = await put({ base_domain: 'Apps.Example.COM', http_port: 9000 })
  expect(res.status).toBe(200)
  let status = await res.json()
  expect(status.base_domain).toBe('apps.example.com')
  expect(status.http_port).toBe(9000)
  expect(calls.fetch).toHaveLength(1)

  res = await put({ base_domain: '' })
  status = await res.json()
  expect(status.base_domain).toBe(null)
  expect(calls.deleted).toEqual([PROXY_PROCESS])
})

test('PUT pushes the base domain into LiveState for open clients', async () => {
  const db = makeDb()
  const liveState = createLiveState()
  const app = proxyApiRoutes({ db, proxy: proxyHarness(db).proxy, liveState })
  const put = body => app.request('/', { method: 'PUT', body: JSON.stringify(body) })

  await put({ base_domain: 'apps.example.com' })
  expect(liveState.proxy).toEqual({ baseDomain: 'apps.example.com' })

  // Clearing must reach clients too — hence '' rather than null, which
  // lazy-watch would read as "key removed" and drop from the diff.
  await put({ base_domain: '' })
  expect(liveState.proxy).toEqual({ baseDomain: '' })
})

// A rejected field must leave nothing behind: settings used to be written as
// they were parsed, so a bad port after a good domain saved the domain but
// skipped both the LiveState push and the Caddy reload.
test('PUT writes nothing when a later field fails validation', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'old.example.com')
  const liveState = createLiveState()
  liveState.proxy = { baseDomain: 'old.example.com' }
  const { proxy, calls } = proxyHarness(db)
  const app = proxyApiRoutes({ db, proxy, liveState })

  const res = await app.request('/', {
    method: 'PUT',
    body: JSON.stringify({ base_domain: 'new.example.com', http_port: 0 }),
  })
  expect(res.status).toBe(400)
  expect(getSetting(db, 'proxy_base_domain')).toBe('old.example.com')
  expect(liveState.proxy).toEqual({ baseDomain: 'old.example.com' })
  expect(calls.fetch).toEqual([]) // no reload attempted
  expect(calls.startOrReload).toEqual([])
})

// Same guarantee for the clear-the-domain path, which also stops the proxy.
test('PUT does not clear the domain when a later field fails validation', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const { proxy, calls } = proxyHarness(db)
  const app = proxyApiRoutes({ db, proxy })

  const res = await app.request('/', {
    method: 'PUT',
    body: JSON.stringify({ base_domain: '', admin_port: 70000 }),
  })
  expect(res.status).toBe(400)
  expect(getSetting(db, 'proxy_base_domain')).toBe('apps.example.com')
  expect(calls.deleted).toEqual([]) // proxy.stop() never ran
})

test('PUT rejects bad domains and ports', async () => {
  const db = makeDb()
  const app = proxyApiRoutes({ db, proxy: proxyHarness(db).proxy })
  const put = body => app.request('/', { method: 'PUT', body: JSON.stringify(body) })
  expect((await put({ base_domain: 'not a domain' })).status).toBe(400)
  expect((await put({ base_domain: 'no-dots' })).status).toBe(400)
  expect((await put({ http_port: 0 })).status).toBe(400)
  expect((await put({ admin_port: 70000 })).status).toBe(400)
})

// --- project routing fields -------------------------------------------------

function projectsApp(db, proxy) {
  return projectRoutes({ db, config: { appsDir: '/srv/apps' }, liveState: createLiveState(), proxy })
}

test('projects accept subdomain+port and trigger a proxy apply', async () => {
  const db = makeDb()
  const applies = []
  const app = projectsApp(db, { apply: async () => applies.push(1) })
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'App', repo_full_name: 'luff/app', branch: 'main',
      subdomain: 'App', port: 4001,
    }),
  })
  expect(res.status).toBe(201)
  const created = await res.json()
  expect(created.subdomain).toBe('app') // normalized to lowercase
  expect(created.port).toBe(4001)
  expect(applies).toHaveLength(1)
})

test('auto-assigns a port to a routed subdomain and rejects duplicate routes', async () => {
  const db = makeDb()
  addProject(db, { slug: 'taken', subdomain: 'taken', port: 4001 })
  const app = projectsApp(db, { apply: async () => {} })
  const post = body => app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: body.name, repo_full_name: 'luff/x', branch: 'main', ...body }),
  })

  // No port typed: the route gets the project's auto port instead of a 400.
  let res = await post({ name: 'A', subdomain: 'a' })
  expect(res.status).toBe(201)
  const a = await res.json()
  expect(a.port).toBe(8100 + a.id) // harbor gate listen port (default 8100) + id

  res = await post({ name: 'B', subdomain: 'taken' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.subdomain).toBe('subdomain already routed')

  res = await post({ name: 'C', subdomain: 'c', port: 4001 })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.port).toBe('port already used by another project')
})

// --- PORT injection ---------------------------------------------------------

test('the routed port reaches the app as PORT via the runtime env, not the ecosystem file', () => {
  const db = makeDb()
  const appsDir = mkdtempSync(join(tmpdir(), 'skeppa-eco-'))
  const config = { appsDir, masterKey: '0'.repeat(64) }
  const id = addProject(db, { slug: 'app', subdomain: 'app', port: 4001, start: 'bun run start' })
  const project = db.query('SELECT * FROM projects WHERE id = ?').get(id)

  const env = runtimeEnv(project, decryptedEnv(db, config, project.id))
  expect(env.PORT).toBe('4001')

  const eco = readFileSync(writeEcosystem(config, project), 'utf8')
  expect(JSON.parse(eco.replace('module.exports = ', '')).apps[0].env).toBeUndefined()
})

test('status lists each route under the host the gate actually routes: handle, own domain, apex', async () => {
  const db = makeDb()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle, domain) VALUES ('eve', 'x', 'tenant', 'eve', 'eve.dev')").run()
  const own = (id, owner) => db.query('UPDATE projects SET owner_id = ? WHERE id = ?').run(owner, id)
  own(addProject(db, { slug: 'adm', subdomain: 'adm', port: 4001 }), 1)
  own(addProject(db, { slug: 'bobapp', subdomain: 'app', port: 4002 }), 2)
  own(addProject(db, { slug: 'evesite', subdomain: 'www', port: 4003 }), 3)
  own(addProject(db, { slug: 'everoot', subdomain: '@', port: 4004 }), 3)
  const { proxy } = proxyHarness(db)
  const routes = (await proxy.status()).routes
  const byHost = Object.fromEntries(routes.map(r => [r.host, r.owner_role === 'tenant' ? r.owner : '']))
  expect(byHost).toEqual({ 'adm.apps.example.com': '', 'app.bob.apps.example.com': 'bob', 'www.eve.dev': 'eve', 'eve.dev': 'eve' })
  // the list and the Caddy config agree host for host
  const routed = buildCaddyConfig(db).apps.http.servers.skeppa.routes.flatMap(r => r.match?.[0]?.host ?? [])
  expect(routes.map(r => r.host).sort()).toEqual(routed.sort())
})
