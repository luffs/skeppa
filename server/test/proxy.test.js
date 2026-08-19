import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting } from '../src/db/settings.js'
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

function proxyHarness(db, { adminOk = true, caddyFound = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'skeppa-proxy-'))
  const calls = { fetch: [], startOrReload: [], deleted: [] }
  const proxy = createProxy({
    db,
    config: { dataDir },
    fetchFn: async url => {
      calls.fetch.push(url)
      if (!adminOk) throw new Error('ECONNREFUSED')
      return { ok: true }
    },
    pm2: {
      startOrReload: async file => calls.startOrReload.push(file),
      describe: async () => null,
      deleteProcess: async name => calls.deleted.push(name),
    },
    which: () => (caddyFound ? '/usr/bin/caddy' : null),
  })
  return { proxy, calls, dataDir }
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

test('rejects a subdomain without a port and duplicate routes', async () => {
  const db = makeDb()
  addProject(db, { slug: 'taken', subdomain: 'taken', port: 4001 })
  const app = projectsApp(db, { apply: async () => {} })
  const post = body => app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: body.name, repo_full_name: 'luff/x', branch: 'main', ...body }),
  })

  let res = await post({ name: 'A', subdomain: 'a' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.port).toBeDefined()

  res = await post({ name: 'B', subdomain: 'taken', port: 4002 })
  expect((await res.json()).fields.subdomain).toBe('subdomain already routed')

  res = await post({ name: 'C', subdomain: 'c', port: 4001 })
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
