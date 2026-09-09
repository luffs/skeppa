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
import { buildCaddyConfig } from '../src/proxy/index.js'
import { setSetting } from '../src/db/settings.js'

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
    logs: { openLog() {}, appendLog() {}, closeLog() {} }, github: null,
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
    logs: { openLog() {}, appendLog() {}, closeLog() {} }, github: null,
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

// The live log stream is a store per deployment, owner-gated — see livestores.test.js.

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

// Live-state scoping per user is store layout now — see livestores.test.js.

test('build-time ENV defaults off for tenants, on for admins, and is editable', async () => {
  const { db, liveState, config, admin, bob } = setup()
  const routes = projectRoutes({ db, config, liveState })
  const make = (user, name, extra = {}) => asUser(routes, user).request('/', {
    method: 'POST',
    body: JSON.stringify({ name, git_url: 'https://example.com/x.git', ...extra }),
  })
  expect((await (await make(bob, 'Bob Build')).json()).build_env).toBe(0)
  expect((await (await make(admin, 'Admin Build')).json()).build_env).toBe(1)
  expect((await (await make(bob, 'Bob Trusts', { build_env: true })).json()).build_env).toBe(1)

  const created = await (await make(bob, 'Bob Later')).json()
  const flipped = await asUser(routes, bob).request(`/${created.id}`, {
    method: 'PATCH', body: JSON.stringify({ build_env: true }),
  })
  expect((await flipped.json()).build_env).toBe(1)
})

test('a tenant with a domain of their own routes there, apex included; the apex needs a domain', async () => {
  const { db, liveState, config, admin, bob } = setup()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  db.query("UPDATE users SET domain = 'bob.dev' WHERE id = 2").run()
  db.query("UPDATE projects SET subdomain = 'app' WHERE id = 2").run()
  const routes = projectRoutes({ db, config, liveState })
  const make = (user, name, subdomain) => asUser(routes, user).request('/', {
    method: 'POST',
    body: JSON.stringify({ name, git_url: 'https://example.com/x.git', subdomain }),
  })
  const apex = await make(bob, 'Bob Root', '@')
  expect(apex.status).toBe(201)
  expect((await apex.json()).owner_domain).toBe('bob.dev')
  const adminApex = await make(admin, 'Admin Root', '@')
  expect(adminApex.status).toBe(400)
  expect((await adminApex.json()).fields.subdomain).toContain('domain of your own')
  // bob's namespace is his domain now: the admin's "app" is a different host
  expect((await make(admin, 'Admin App', 'app')).status).toBe(201)
  expect((await make(bob, 'Bob Again', 'app')).status).toBe(400)
  const hosts = buildCaddyConfig(db).apps.http.servers.skeppa.routes.flatMap(r => r.match?.[0]?.host ?? [])
  expect(hosts.sort()).toEqual(['app.apps.example.com', 'app.bob.dev', 'bob.dev'])
})
