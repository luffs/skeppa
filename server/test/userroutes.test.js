import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, initLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { setSetting } from '../src/db/settings.js'
import { userRoutes } from '../src/routes/users.js'

// The routes run behind requireSession in app.js; here a stub middleware plays
// that part so tests can pick who the caller is.
async function setup(proxy = null) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))

  const hash = await Bun.password.hash('anchors aweigh', { algorithm: 'bcrypt', cost: 4 })
  db.query("INSERT INTO users (username, password_hash) VALUES ('captain', ?)").run(hash)
  db.query("INSERT INTO users (username, password_hash) VALUES ('bosun', ?)").run(hash)
  const addSession = (id, userId) =>
    db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(id, userId)
  addSession('sess-captain', 1)
  addSession('sess-captain-phone', 1)
  addSession('sess-bosun', 2)

  const liveState = createLiveState()
  initLiveState(liveState, db)

  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('session', { id: 'sess-captain', user_id: 1 })
    return next()
  })
  app.route('/', userRoutes({ db, liveState, proxy }))
  return { db, app, liveState }
}

const sessionIds = db => db.query('SELECT id FROM sessions ORDER BY id').all().map(r => r.id)

test('lists users without password hashes', async () => {
  const { app } = await setup()
  const res = await app.request('/')
  expect(res.status).toBe(200)
  const users = await res.json()
  expect(users.map(u => u.username)).toEqual(['bosun', 'captain'])
  expect(Object.keys(users[0]).sort()).toEqual(['created_at', 'domain', 'github_login', 'handle', 'id', 'role', 'username'])
})

test('initLiveState mirrors existing users without password hashes', async () => {
  const { liveState } = await setup()
  expect(Object.values(liveState.users).map(u => u.username).sort()).toEqual(['bosun', 'captain'])
  expect(Object.keys(liveState.users[1]).sort()).toEqual(['created_at', 'domain', 'handle', 'id', 'role', 'username'])
})

test('creates a user with a hashed password and mirrors it into LiveState', async () => {
  const { db, app, liveState } = await setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ username: 'deckhand', password: 'seaworthy1', role: 'tenant', handle: 'deckhand' }),
  })
  expect(res.status).toBe(201)
  const created = await res.json()
  expect(created.username).toBe('deckhand')
  const row = db.query("SELECT password_hash FROM users WHERE username = 'deckhand'").get()
  expect(await Bun.password.verify('seaworthy1', row.password_hash)).toBe(true)
  expect(liveState.users[created.id]).toEqual(created)
})

test('rejects invalid usernames, short passwords, and duplicates', async () => {
  const { app } = await setup()
  const post = body => app.request('/', { method: 'POST', body: JSON.stringify(body) })

  let res = await post({ username: 'no spaces', password: 'seaworthy1' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.username).toBeDefined()

  res = await post({ username: 'deckhand', password: 'short' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.password).toBeDefined()

  res = await post({ username: 'captain', password: 'seaworthy1' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.username).toBe('already taken')
})

test('changing your own password keeps the current session, drops the rest', async () => {
  const { db, app } = await setup()
  const res = await app.request('/1/password', {
    method: 'PUT',
    body: JSON.stringify({ password: 'new password 1' }),
  })
  expect(res.status).toBe(200)
  expect(sessionIds(db)).toEqual(['sess-bosun', 'sess-captain'])
  const row = db.query('SELECT password_hash FROM users WHERE id = 1').get()
  expect(await Bun.password.verify('new password 1', row.password_hash)).toBe(true)
})

test("changing another user's password drops all their sessions", async () => {
  const { db, app } = await setup()
  const res = await app.request('/2/password', {
    method: 'PUT',
    body: JSON.stringify({ password: 'new password 1' }),
  })
  expect(res.status).toBe(200)
  expect(sessionIds(db)).toEqual(['sess-captain', 'sess-captain-phone'])
})

test('rejects a too-short new password', async () => {
  const { app } = await setup()
  const res = await app.request('/2/password', { method: 'PUT', body: JSON.stringify({ password: 'short' }) })
  expect(res.status).toBe(400)
})

test('deletes another user, cascades their sessions, and drops them from LiveState', async () => {
  const { db, app, liveState } = await setup()
  const res = await app.request('/2', { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(db.query('SELECT COUNT(*) AS n FROM users').get().n).toBe(1)
  expect(sessionIds(db)).toEqual(['sess-captain', 'sess-captain-phone'])
  expect(liveState.users[2]).toBeUndefined()
})

test('refuses to delete your own account', async () => {
  const { db, app } = await setup()
  const res = await app.request('/1', { method: 'DELETE' })
  expect(res.status).toBe(400)
  expect(db.query('SELECT COUNT(*) AS n FROM users').get().n).toBe(2)
})

test('404s on an unknown user', async () => {
  const { app } = await setup()
  expect((await app.request('/99', { method: 'DELETE' })).status).toBe(404)
  expect((await app.request('/99/password', { method: 'PUT', body: JSON.stringify({ password: 'seaworthy1' }) })).status).toBe(404)
})

test('a tenant may bring a domain of their own: validated, unique, tenant-only, never under the base domain', async () => {
  const { db, app, liveState } = await setup()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const post = body => app.request('/', { method: 'POST', body: JSON.stringify(body) })
  const tenant = { username: 'bob', password: 'anchors aweigh', role: 'tenant', handle: 'bob' }
  expect((await (await post({ ...tenant, domain: 'not a domain' })).json()).fields.domain).toBe('not a valid domain name')
  expect((await (await post({ ...tenant, domain: 'bob.apps.example.com' })).json()).fields.domain).toContain('base domain')
  expect((await (await post({ ...tenant, role: 'admin', handle: '', domain: 'bob.dev' })).json()).fields.domain).toContain('only tenants')
  const created = await post({ ...tenant, domain: ' Bob.DEV ' })
  expect(created.status).toBe(201)
  const bob = await created.json()
  expect(bob.domain).toBe('bob.dev')
  expect(liveState.users[bob.id].domain).toBe('bob.dev')
  expect((await (await post({ ...tenant, username: 'eve', handle: 'eve', domain: 'bob.dev' })).json()).fields.domain).toBe('already taken')
})

test("changing a tenant's domain reroutes their projects: live info follows and the proxy is re-applied", async () => {
  const applied = []
  const { db, app, liveState } = await setup({ apply: async () => applied.push(1) })
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  const bobId = db.query("SELECT id FROM users WHERE username = 'bob'").get().id
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port, subdomain)
            VALUES ('site', 'Site', ?, '', 'main', 'site', 'container', '', 4101, 'www')`).run(bobId)
  const projectId = db.query("SELECT id FROM projects WHERE slug = 'site'").get().id
  liveState.projects[projectId] = projectDefaults(null, getProjectInfo(db, projectId))
  expect(liveState.projects[projectId].info.owner_domain).toBe('')

  const res = await app.request(`/${bobId}`, { method: 'PUT', body: JSON.stringify({ domain: 'bob.dev' }) })
  expect(res.status).toBe(200)
  expect(liveState.projects[projectId].info.owner_domain).toBe('bob.dev')
  expect(liveState.users[bobId].domain).toBe('bob.dev')
  expect(applied.length).toBe(1)
  // an edit that leaves the hosts alone does not touch the proxy
  await app.request(`/${bobId}`, { method: 'PUT', body: JSON.stringify({ github_login: 'bobgh' }) })
  expect(applied.length).toBe(1)
})
