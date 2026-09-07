import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { deploymentRoutes } from '../src/routes/deployments.js'
import { userRoutes } from '../src/routes/users.js'
import { githubRoutes } from '../src/routes/github.js'
import { requireAdmin } from '../src/auth/sessions.js'
import { projectEngineNetworks } from '../src/containers/networks.js'
import { DeployRunner } from '../src/deploy/runner.js'
import { Hub } from '../src/live/hub.js'
import { buildCaddyConfig } from '../src/proxy/index.js'
import { setSetting } from '../src/db/settings.js'
import { LazyWatch } from 'lazy-watch'

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const tick = () => new Promise(r => setTimeout(r, 0))

// Routes read the user the session middleware attaches; tests attach it here.
function asUser(routes, user, session = null) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('user', user)
    c.set('session', session ?? { id: 'sess', user_id: user.id })
    return next()
  })
  app.route('/', routes)
  return app
}

function setup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle, github_login) VALUES ('bob', 'x', 'tenant', 'bob', 'bobgh')").run()
  const admin = db.query('SELECT * FROM users WHERE id = 1').get()
  const bob = db.query('SELECT * FROM users WHERE id = 2').get()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port)
            VALUES ('adm', 'Adm', 1, 'cap/adm', 'main', 'adm', 'container', 'bun start', 4101)`).run()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port)
            VALUES ('bobapp', 'BobApp', 2, 'bobgh/app', 'main', 'bobapp', 'container', 'bun start', 4102)`).run()
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults(null, getProjectInfo(db, 1))
  liveState.projects[2] = projectDefaults(null, getProjectInfo(db, 2))
  const config = { appsDir: '/tmp/apps', masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa' }
  return { db, liveState, config, admin, bob }
}

test('a tenant lists only their own projects; the admin sees all', async () => {
  const { db, liveState, config, admin, bob } = setup()
  const routes = projectRoutes({ db, config, liveState })
  const mine = await (await asUser(routes, bob).request('/')).json()
  expect(mine.map(p => p.slug)).toEqual(['bobapp'])
  const all = await (await asUser(routes, admin).request('/')).json()
  expect(all.map(p => p.slug).sort()).toEqual(['adm', 'bobapp'])
})

test("someone else's project is a 404, not a 403 — ids must not leak", async () => {
  const { db, liveState, config, bob } = setup()
  const routes = projectRoutes({ db, config, liveState })
  const app = asUser(routes, bob)
  expect((await app.request('/1')).status).toBe(404)
  expect((await app.request('/2')).status).toBe(200)
  expect((await app.request('/1', { method: 'PATCH', body: JSON.stringify({ name: 'stolen' }) })).status).toBe(404)
})

test('a tenant creation is owned, container-forced, and host access is refused', async () => {
  const { db, liveState, config, bob } = setup()
  const routes = projectRoutes({ db, config, liveState })
  const app = asUser(routes, bob)

  const created = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bobs Site', git_url: 'https://example.com/site.git' }),
  })
  expect(created.status).toBe(201)
  const body = await created.json()
  expect(body.owner_id).toBe(2)
  expect(body.runtime).toBe('container')

  const pm2Try = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sneaky', git_url: 'https://example.com/s.git', runtime: 'pm2' }),
  })
  expect(pm2Try.status).toBe(400)
  expect((await pm2Try.json()).fields.runtime).toContain('containers only')

  const hostTry = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'Hosty', git_url: 'https://example.com/h.git', host_access: true }),
  })
  expect(hostTry.status).toBe(400)
  expect((await hostTry.json()).fields.host_access).toBeDefined()
})

test('a tenant moors GitHub repos only from their own installation', async () => {
  const { db, liveState, config, bob } = setup()
  const github = {
    getRepoInstallation: async repo =>
      repo.startsWith('bobgh/') ? { id: 22, account: 'bobgh' } : { id: 11, account: 'cap' },
  }
  const routes = projectRoutes({ db, config, liveState, github })
  const app = asUser(routes, bob)

  const foreign = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'Not Mine', repo_full_name: 'cap/private' }),
  })
  expect(foreign.status).toBe(400)
  expect((await foreign.json()).fields.repo_full_name).toContain('linked GitHub account')

  const own = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'Mine', repo_full_name: 'bobgh/thing' }),
  })
  expect(own.status).toBe(201)
})

test("deploy logs are owner-only — a tenant cannot read another's deployment", async () => {
  const { db, bob, admin } = setup()
  db.query(`INSERT INTO deployments (project_id, "trigger", log) VALUES (1, 'manual', 'SECRET=hunter2')`).run()
  const routes = deploymentRoutes({ db, runner: { getActiveLog: () => null } })
  expect((await asUser(routes, bob).request('/1')).status).toBe(404)
  expect((await asUser(routes, admin).request('/1')).status).toBe(200)
})

test('tenant deploys refuse to run without the podman sandbox', async () => {
  const { db, liveState, config } = setup()
  const pending = []
  const runner = new DeployRunner({
    db, config: { ...config, sandbox: 'host', deployTimeoutMs: 1000 }, liveState,
    hub: { sendLog() {} }, github: null,
    execute: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  })
  const id = runner.enqueue(2, { trigger: 'manual' }) // bob's project
  await tick(); await tick()
  const row = db.query('SELECT status, log FROM deployments WHERE id = ?').get(id)
  expect(row.status).toBe('failed')
  expect(row.log).toContain('podman build sandbox')
  expect(pending.length).toBe(0) // the script never ran
})

test('tenant deploys run when the sandbox is on', async () => {
  const { db, liveState, config } = setup()
  const pending = []
  const runner = new DeployRunner({
    db, config: { ...config, sandbox: 'podman', deployTimeoutMs: 1000 }, liveState,
    hub: { sendLog() {} }, github: null,
    execute: () => new Promise(resolve => pending.push(resolve)),
  })
  runner.enqueue(2, { trigger: 'manual' })
  await tick()
  expect(pending.length).toBe(1)
  pending[0]()
})

test('tenant convoys are namespaced by handle; admin convoys stay plain', () => {
  const tenantProject = {
    runtime: 'container', slug: 'bobapp', networks: 'db',
    network_profile: 'open', owner_role: 'tenant', owner_handle: 'bob',
  }
  expect(projectEngineNetworks(tenantProject)).toEqual(['podman', 'skeppa-net-bob-db'])
  expect(projectEngineNetworks({ ...tenantProject, network_profile: 'restricted', networks: '' }))
    .toEqual(['skeppa-net-bobapp'.replace('bobapp', 'bob-bobapp')])
  const adminProject = { ...tenantProject, owner_role: 'admin', owner_handle: '' }
  expect(projectEngineNetworks(adminProject)).toEqual(['podman', 'skeppa-net-db'])
})

test('crew rules: tenants need handles, the last admin stays, owners keep their users', async () => {
  const { db, liveState, admin } = setup()
  const routes = userRoutes({ db, liveState })
  const app = asUser(routes, admin)

  const noHandle = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ username: 'eve', password: 'longenough1', role: 'tenant' }),
  })
  expect(noHandle.status).toBe(400)
  expect((await noHandle.json()).fields.handle).toContain('required')

  const demote = await app.request('/1', { method: 'PUT', body: JSON.stringify({ role: 'tenant', handle: 'cap' }) })
  expect(demote.status).toBe(400)
  expect((await demote.json()).fields.role).toContain('last admin')

  const del = await app.request('/2', { method: 'DELETE' })
  expect(del.status).toBe(400)
  expect((await del.json()).error).toContain('still owns projects')
})

test('the repo picker is scoped to the linked GitHub account', async () => {
  const { db, config, admin, bob } = setup()
  const seen = []
  const github = { listRepos: async login => (seen.push(login), []) }
  const routes = githubRoutes({ db, config, github })

  await asUser(routes, admin).request('/repos')
  await asUser(routes, bob).request('/repos')
  expect(seen).toEqual([null, 'bobgh'])

  const unlinked = { ...bob, github_login: '' }
  const none = await (await asUser(routes, unlinked).request('/repos')).json()
  expect(none).toEqual([])

  // everything past /repos in this group is admin space
  expect((await asUser(routes, bob).request('/setup')).status).toBe(403)
})

test('requireAdmin turns tenants away from panel configuration', async () => {
  const app = new Hono()
  app.use('*', (c, next) => { c.set('user', { id: 2, role: 'tenant' }); return next() })
  app.use('*', requireAdmin())
  app.get('/x', c => c.json({ ok: true }))
  expect((await app.request('/x')).status).toBe(403)
})

test('the live log stream is owner-gated at subscribe time', () => {
  const { db, liveState, admin, bob } = setup()
  db.query(`INSERT INTO deployments (project_id, "trigger", log) VALUES (1, 'manual', '')`).run() // admin project
  db.query(`INSERT INTO deployments (project_id, "trigger", log) VALUES (2, 'manual', '')`).run() // bob project
  const hub = new Hub({ liveState })
  hub.getLogBacklog = () => 'backlog'
  // wired exactly as index.js wires it
  hub.canReadDeployment = (user, deploymentId) => {
    if (!user || user.role === 'admin') return true
    const row = db.query('SELECT p.owner_id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.id = ?').get(deploymentId)
    return row?.owner_id === user.id
  }
  const sock = () => ({ sent: [], send(s) { this.sent.push(JSON.parse(s)) } })
  const bobSock = sock()
  const adminSock = sock()
  hub.add(bobSock, { id: bob.id, role: 'tenant' })
  hub.add(adminSock, { id: admin.id, role: 'admin' })

  hub.handleMessage(bobSock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 1 })) // not his — denied
  hub.handleMessage(bobSock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 2 }))
  hub.handleMessage(adminSock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 1 }))
  hub.sendLog(1, 'ADMIN_SECRET=x')
  hub.sendLog(2, 'bob line')

  expect(bobSock.sent.filter(m => m.type === 'logs:line'))
    .toEqual([{ type: 'logs:line', deploymentId: 2, line: 'bob line' }])
  expect(bobSock.sent.filter(m => m.type === 'logs:backlog').map(m => m.deploymentId)).toEqual([2])
  expect(adminSock.sent.some(m => m.type === 'logs:line' && m.line === 'ADMIN_SECRET=x')).toBe(true)
})

test('subdomains collide per namespace: two tenants may both be app.<handle>', async () => {
  const { db, liveState, config, admin, bob } = setup()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('eve', 'x', 'tenant', 'eve')").run()
  const eve = db.query('SELECT * FROM users WHERE username = ' + String.fromCharCode(39) + 'eve' + String.fromCharCode(39)).get()
  const routes = projectRoutes({ db, config, liveState })
  const make = (user, name, subdomain) => asUser(routes, user).request('/', {
    method: 'POST',
    body: JSON.stringify({ name, git_url: 'https://example.com/x.git', subdomain }),
  })

  expect((await make(bob, 'Bob Site', 'app')).status).toBe(201)
  expect((await make(eve, 'Eve Site', 'app')).status).toBe(201) // different namespace
  const dupe = await make(bob, 'Bob Again', 'app')
  expect(dupe.status).toBe(400) // same namespace
  expect((await dupe.json()).fields.subdomain).toContain('already routed')
  expect((await make(admin, 'Admin Site', 'app')).status).toBe(201) // flat namespace is its own
  expect((await make(admin, 'Admin Again', 'app')).status).toBe(400)
})

test('the harbor gate routes tenant projects under their handle', () => {
  const { db } = setup()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  db.query("UPDATE projects SET subdomain = 'adm' WHERE id = 1").run()
  db.query("UPDATE projects SET subdomain = 'app' WHERE id = 2").run()
  const cfg = buildCaddyConfig(db)
  const hosts = cfg.apps.http.servers.skeppa.routes.flatMap(r => r.match?.[0]?.host ?? [])
  expect(hosts.sort()).toEqual(['adm.apps.example.com', 'app.bob.apps.example.com'])
})

test('the live stream is scoped per socket: tenants get their projects and the proxy domain, nothing else', async () => {
  const { liveState, admin, bob } = setup()
  liveState.proxy = { baseDomain: 'apps.example.com' }
  liveState.system = { loadavg: [1] }
  LazyWatch.flush(liveState); await tick() // settle before the hub subscribes
  const hub = new Hub({ liveState })
  const sock = () => ({ sent: [], send(s) { this.sent.push(JSON.parse(s)) } })
  const bobSock = sock()
  const adminSock = sock()
  hub.add(bobSock, { id: bob.id, role: 'tenant' })
  hub.add(adminSock, { id: admin.id, role: 'admin' })

  const full = bobSock.sent.find(m => m.type === 'state:full').state
  expect(Object.keys(full.projects)).toEqual(['2'])
  expect(full.system).toEqual({}) // branches exist for the client mirror, but empty
  expect(full.users).toEqual({})
  expect(full.proxy.baseDomain).toBe('apps.example.com')
  expect(adminSock.sent.find(m => m.type === 'state:full').state.projects[1]).toBeDefined()

  // one batched diff touching both projects and system: bob sees only his slice
  liveState.projects[1].deployedSha = 'admin-sha'
  liveState.projects[2].deployedSha = 'bob-sha'
  liveState.system.loadavg = [2]
  LazyWatch.flush(liveState); await tick()
  const bobDiffs = bobSock.sent.filter(m => m.type === 'state').map(m => m.diff)
  expect(bobDiffs.length).toBe(1)
  expect(Object.keys(bobDiffs[0])).toEqual(['projects'])
  expect(Object.keys(bobDiffs[0].projects)).toEqual(['2'])
  const adminDiff = adminSock.sent.filter(m => m.type === 'state').at(-1).diff
  expect(adminDiff.system).toBeDefined()
  expect(Object.keys(adminDiff.projects).sort()).toEqual(['1', '2'])

  // a change that is only the admin's produces no message for bob at all
  liveState.projects[1].deployedSha = 'admin-again'
  LazyWatch.flush(liveState); await tick()
  expect(bobSock.sent.filter(m => m.type === 'state').length).toBe(1)

  // deletions: bob's reaches him (owner remembered past the delete), the admin's does not
  delete liveState.projects[2]
  delete liveState.projects[1]
  LazyWatch.flush(liveState); await tick()
  expect(bobSock.sent.filter(m => m.type === 'state').at(-1).diff).toEqual({ projects: { 2: null } })
})
