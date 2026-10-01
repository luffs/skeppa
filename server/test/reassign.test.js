import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting } from '../src/db/settings.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { userRoutes } from '../src/routes/users.js'

// Crew → Remove for someone who still owns projects: move them to another
// crew member first. A move is planned (what changes, what forbids it) and
// only carried out when nothing forbids it.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))

function setup({ github = null } = {}) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrationsDir)
  const addUser = (username, role, extra = {}) => Number(db.query(
    'INSERT INTO users (username, password_hash, role, handle, domain, github_login) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, 'x', role, extra.handle ?? '', extra.domain ?? '', extra.github_login ?? '').lastInsertRowid)
  const cap = addUser('cap', 'admin')
  const old = addUser('old', 'admin')
  const bob = addUser('bob', 'tenant', { handle: 'bob', github_login: 'bobgh' })
  const eve = addUser('eve', 'tenant', { handle: 'eve', domain: 'eve.dev' })
  setSetting(db, 'proxy_base_domain', 'apps.example.com')

  const liveState = createLiveState()
  const addProject = (owner, slug, fields = {}) => {
    const p = {
      repo_full_name: '', git_url: `https://example.com/${slug}.git`, runtime: 'container', subdomain: null,
      host_access: 0, networks: '', network_profile: 'open', deployed_runtime: '', ...fields,
    }
    const id = Number(db.query(
      `INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime, deployed_runtime, subdomain, port, host_access, networks, network_profile)
       VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, slug, owner, p.repo_full_name, p.git_url, slug, p.runtime, p.deployed_runtime, p.subdomain,
      4100 + Number(db.query('SELECT COUNT(*) AS n FROM projects').get().n), p.host_access, p.networks, p.network_profile).lastInsertRowid)
    liveState.projects[id] = projectDefaults(null, getProjectInfo(db, id))
    return id
  }
  const applied = []
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('session', { id: 'sess-cap', user_id: cap })
    return next()
  })
  app.route('/', userRoutes({ db, liveState, github, proxy: { apply: async () => { applied.push(1) } } }))
  const plan = async (from, to) => (await app.request(`/${from}/reassign?to=${to}`)).json()
  const move = (from, to) => app.request(`/${from}/reassign`, { method: 'POST', body: JSON.stringify({ to }) })
  const ownerOf = id => db.query('SELECT owner_id FROM projects WHERE id = ?').get(id).owner_id
  return { db, liveState, app, cap, old, bob, eve, addProject, plan, move, ownerOf, applied }
}

test('between admins nothing but the owner changes, and the old admin can then be removed', async () => {
  const { app, cap, old, addProject, plan, move, ownerOf, liveState } = setup()
  const blog = addProject(old, 'blog', { runtime: 'pm2', deployed_runtime: 'pm2', subdomain: 'blog', host_access: 1 })
  const api = addProject(old, 'api', { subdomain: 'api', networks: 'db' })

  const preview = await plan(old, cap)
  expect(preview.projects.map(p => p.name)).toEqual(['api', 'blog'])
  expect(preview.blockers).toEqual([])
  expect(preview.changes).toEqual([]) // same namespace, same network names

  // removing first is refused, with a pointer to the way out
  const refused = await app.request(`/${old}`, { method: 'DELETE' })
  expect((await refused.json()).error).toContain('move them to someone else first')

  const res = await move(old, cap)
  expect(await res.json()).toEqual({ moved: 2, changes: [] })
  expect([ownerOf(blog), ownerOf(api)]).toEqual([cap, cap])
  expect(liveState.projects[api].info.owner_id).toBe(cap)
  expect((await app.request(`/${old}`, { method: 'DELETE' })).status).toBe(200)
})

test('a move to a tenant follows the tenant rules — no host process, no host access, only their own repos', async () => {
  const github = { getRepoInstallation: async repo => ({ id: 1, account: repo.split('/')[0] }) }
  const { cap, bob, eve, addProject, plan, move, ownerOf } = setup({ github })
  const host = addProject(cap, 'host', { runtime: 'pm2' })
  addProject(cap, 'switching', { runtime: 'container', deployed_runtime: 'pm2' }) // still a pm2 process until deployed
  addProject(cap, 'loopback', { host_access: 1 })
  addProject(cap, 'private', { git_url: '', repo_full_name: 'cap/private' })
  addProject(cap, 'theirs', { git_url: '', repo_full_name: 'bobgh/site' })
  addProject(cap, 'public', {}) // a plain git URL is anyone's to deploy

  const toBob = await plan(cap, bob)
  expect(Object.fromEntries(toBob.blockers.map(b => [b.project, b.reason]))).toEqual({
    host: 'runs as a pm2 process — a tenant gets containers and static sites only; switch it to a container first',
    switching: 'runs as a pm2 process — a tenant gets containers and static sites only; switch it to a container first',
    loopback: 'has host access, which is admin-only',
    private: "is in cap's GitHub installation, not bob's — a tenant deploys only their own repos",
  })

  // eve has no linked GitHub account at all
  const toEve = await plan(cap, eve)
  expect(toEve.blockers.find(b => b.project === 'theirs').reason).toBe('is a GitHub repo, and eve has no linked GitHub account')

  // refused whole: nothing moves when anything is blocked
  const res = await move(cap, bob)
  expect(res.status).toBe(400)
  expect((await res.json()).blockers.length).toBe(4)
  expect(ownerOf(host)).toBe(cap)
})

test('without the GitHub App a GitHub repo cannot be checked, so it cannot move to a tenant', async () => {
  const { cap, bob, addProject, plan } = setup({ github: null })
  addProject(cap, 'private', { git_url: '', repo_full_name: 'bobgh/site' })
  expect((await plan(cap, bob)).blockers[0].reason).toContain('without the GitHub App')
})

test('a move across namespaces shows the new addresses and renamed networks before it happens', async () => {
  const { cap, bob, eve, addProject, plan, move, applied, liveState } = setup()
  const site = addProject(bob, 'site', { subdomain: 'app', networks: 'db' })
  addProject(bob, 'quiet', {}) // unrouted, no networks: nothing to say about it

  const toCap = await plan(bob, cap)
  expect(toCap.blockers).toEqual([])
  expect(toCap.changes).toEqual([
    { project: 'site', kind: 'address', before: 'https://app.bob.apps.example.com', after: 'https://app.apps.example.com' },
    { project: 'site', kind: 'networks', before: 'podman, skeppa-net-bob-db', after: 'podman, skeppa-net-db' },
  ])
  const toEve = await plan(bob, eve)
  expect(toEve.changes[0]).toMatchObject({ before: 'https://app.bob.apps.example.com', after: 'https://app.eve.dev' })

  const res = await move(bob, cap)
  expect((await res.json()).moved).toBe(2)
  expect(liveState.projects[site].info).toMatchObject({ owner_id: cap, owner_role: 'admin', owner_handle: '' })
  expect(applied.length).toBe(1) // the gate re-routes what moved
})

test('a subdomain already routed in the new namespace, or a site at the root of a domain with nowhere to go, blocks the move', async () => {
  const { cap, bob, eve, addProject, plan } = setup()
  addProject(cap, 'capapp', { subdomain: 'app' })
  addProject(bob, 'bobapp', { subdomain: 'app' })
  const toCap = await plan(bob, cap)
  expect(toCap.blockers).toEqual([{ project: 'bobapp', reason: 'its subdomain "app" is already routed for cap by capapp' }])

  addProject(eve, 'root', { subdomain: '@' })
  const toBob = await plan(eve, bob)
  expect(toBob.blockers.find(b => b.project === 'root').reason).toBe('sits at the root of eve.dev, and bob has no domain of their own')
})

test('the request is checked: a real source, a real target, and someone else', async () => {
  const { app, cap, old } = setup()
  expect((await app.request(`/999/reassign?to=${cap}`)).status).toBe(404)
  const noTarget = await app.request(`/${old}/reassign?to=999`)
  expect(noTarget.status).toBe(400)
  expect((await noTarget.json()).fields.to).toBe('pick a crew member')
  const self = await app.request(`/${old}/reassign`, { method: 'POST', body: JSON.stringify({ to: old }) })
  expect((await self.json()).fields.to).toBe('pick someone else')
})
