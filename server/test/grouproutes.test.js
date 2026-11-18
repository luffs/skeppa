import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, initLiveState } from '../src/live/state.js'
import { groupRoutes } from '../src/routes/groups.js'
import { projectRoutes } from '../src/routes/projects.js'
import { userRoutes } from '../src/routes/users.js'
import { planReassign, applyReassign, reassignUsers } from '../src/lib/reassign.js'
import { normalizeGroupName } from '../src/lib/validate.js'

// Piers: project groups. Organization only, owned per user, and a project
// joins only a pier of its own owner.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))

function asUser(routes, user) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('user', user)
    c.set('session', { id: 'sess', user_id: user.id })
    return next()
  })
  app.route('/', routes)
  return app
}

const json = body => ({ method: 'POST', body: JSON.stringify(body) })
const patch = body => ({ method: 'PATCH', body: JSON.stringify(body) })

function setup() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('eve', 'x', 'tenant', 'eve')").run()
  const user = id => db.query('SELECT * FROM users WHERE id = ?').get(id)
  const addProject = (owner, slug, extra = {}) => Number(db.query(
    `INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime, start_command, port)
     VALUES (?, ?, ?, '', ?, 'main', ?, ?, 'bun start', ?)`
  ).run(slug, slug, owner, `https://example.com/${slug}.git`, extra.pm2_name ?? slug, extra.runtime ?? 'container',
    4100 + Number(db.query('SELECT COUNT(*) AS n FROM projects').get().n) + 1).lastInsertRowid)
  const adm = addProject(1, 'adm')
  const bobapp = addProject(2, 'bobapp')
  const bobapi = addProject(2, 'bobapi')
  const panel = addProject(1, 'skeppa', { runtime: 'pm2', pm2_name: 'skeppa' })
  const liveState = createLiveState()
  initLiveState(liveState, db, {})
  const enqueued = []
  const runner = { enqueue: (id, opts) => (enqueued.push({ id, ...opts }), 100 + enqueued.length) }
  const config = { appsDir: '/tmp/apps', masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa' }
  const groups = groupRoutes({ db, config, liveState, runner })
  const projects = projectRoutes({ db, config, liveState })
  return { db, liveState, config, groups, projects, user, enqueued, ids: { adm, bobapp, bobapi, panel } }
}

test('names are a readable line: trimmed, whitespace collapsed, 1–40 characters', () => {
  expect(normalizeGroupName('  Kunder   och  vänner ')).toBe('Kunder och vänner')
  expect(normalizeGroupName('')).toBeNull()
  expect(normalizeGroupName('   ')).toBeNull()
  expect(normalizeGroupName('x'.repeat(41))).toBeNull()
  expect(normalizeGroupName('a\u0007b')).toBeNull()
  expect(normalizeGroupName(42)).toBeNull()
})

test('a tenant makes piers for themselves, and sees only their own', async () => {
  const { groups, user, liveState } = setup()
  const bob = asUser(groups, user(2))
  const res = await bob.request('/', json({ name: 'Kunder', owner_id: 1 })) // owner_id is ignored for a tenant
  expect(res.status).toBe(201)
  const pier = await res.json()
  expect(pier.owner_id).toBe(2)
  expect(liveState.groups[pier.id].name).toBe('Kunder')

  await asUser(groups, user(1)).request('/', json({ name: 'Mine' }))
  expect((await (await bob.request('/')).json()).map(g => g.name)).toEqual(['Kunder'])
  expect((await (await asUser(groups, user(1)).request('/')).json()).map(g => g.name).sort()).toEqual(['Kunder', 'Mine'])
})

test('names are unique per owner, case-insensitively — not across owners', async () => {
  const { groups, user } = setup()
  const bob = asUser(groups, user(2))
  expect((await bob.request('/', json({ name: 'Kunder' }))).status).toBe(201)
  const clash = await bob.request('/', json({ name: 'kunder' }))
  expect(clash.status).toBe(400)
  expect((await clash.json()).fields.name).toMatch(/already/)
  expect((await asUser(groups, user(3)).request('/', json({ name: 'Kunder' }))).status).toBe(201)
  expect((await bob.request('/', json({ name: '  ' }))).status).toBe(400)
})

test('an admin may make a pier in someone else\'s fleet, for a crew member that exists', async () => {
  const { groups, user } = setup()
  const cap = asUser(groups, user(1))
  const made = await (await cap.request('/', json({ name: 'Sorted', owner_id: 2 }))).json()
  expect(made.owner_id).toBe(2)
  expect((await cap.request('/', json({ name: 'X', owner_id: 99 }))).status).toBe(400)
})

test("someone else's pier is a 404 for a tenant, on every route", async () => {
  const { groups, user } = setup()
  const eves = await (await asUser(groups, user(3)).request('/', json({ name: 'Eve' }))).json()
  const bob = asUser(groups, user(2))
  expect((await bob.request(`/${eves.id}`, patch({ name: 'mine now' }))).status).toBe(404)
  expect((await bob.request(`/${eves.id}`, { method: 'DELETE' })).status).toBe(404)
  expect((await bob.request(`/${eves.id}/deploy`, { method: 'POST' })).status).toBe(404)
  // the admin passes
  expect((await asUser(groups, user(1)).request(`/${eves.id}`, patch({ name: 'Eves' }))).status).toBe(200)
})

test('a project joins only a pier of its own owner, whoever edits it', async () => {
  const { groups, projects, user, liveState, ids } = setup()
  const bobsPier = await (await asUser(groups, user(2)).request('/', json({ name: 'Kunder' }))).json()
  const capsPier = await (await asUser(groups, user(1)).request('/', json({ name: 'Mine' }))).json()
  const bob = asUser(projects, user(2))
  const cap = asUser(projects, user(1))

  const joined = await bob.request(`/${ids.bobapp}`, patch({ group_id: bobsPier.id }))
  expect(joined.status).toBe(200)
  expect((await joined.json()).group_id).toBe(bobsPier.id)
  expect(liveState.projects[ids.bobapp].info.group_id).toBe(bobsPier.id)

  // Not into someone else's pier — not even when the admin edits it
  const wrong = await cap.request(`/${ids.bobapi}`, patch({ group_id: capsPier.id }))
  expect(wrong.status).toBe(400)
  expect((await wrong.json()).fields.group_id).toMatch(/no such pier/)
  expect((await bob.request(`/${ids.bobapi}`, patch({ group_id: 9999 }))).status).toBe(400)
  expect((await bob.request(`/${ids.bobapi}`, patch({ group_id: 'abc' }))).status).toBe(400)

  // '' leaves the pier; an unrelated edit keeps it
  expect((await (await bob.request(`/${ids.bobapp}`, patch({ name: 'renamed' }))).json()).group_id).toBe(bobsPier.id)
  expect((await (await bob.request(`/${ids.bobapp}`, patch({ group_id: '' }))).json()).group_id).toBeNull()
})

test('removing a pier leaves its projects ungrouped, live info too', async () => {
  const { db, groups, projects, user, liveState, ids } = setup()
  const pier = await (await asUser(groups, user(2)).request('/', json({ name: 'Kunder' }))).json()
  await asUser(projects, user(2)).request(`/${ids.bobapp}`, patch({ group_id: pier.id }))
  const res = await asUser(groups, user(2)).request(`/${pier.id}`, { method: 'DELETE' })
  expect(await res.json()).toEqual({ ok: true, released: 1 })
  expect(db.query('SELECT group_id FROM projects WHERE id = ?').get(ids.bobapp).group_id).toBeNull()
  expect(db.query('SELECT 1 FROM projects WHERE id = ?').get(ids.bobapp)).toBeTruthy()
  expect(liveState.projects[ids.bobapp].info.group_id).toBeUndefined() // null is a deletion in LiveState
  expect(liveState.groups[pier.id]).toBeUndefined()
})

test('deploying a pier enqueues every vessel at it — except the panel itself', async () => {
  const { db, groups, user, enqueued, ids } = setup()
  const cap = asUser(groups, user(1))
  const pier = await (await cap.request('/', json({ name: 'Mine' }))).json()
  db.query('UPDATE projects SET group_id = ? WHERE id IN (?, ?)').run(pier.id, ids.adm, ids.panel)
  const res = await cap.request(`/${pier.id}/deploy`, { method: 'POST' })
  expect(res.status).toBe(202)
  const body = await res.json()
  expect(enqueued).toEqual([{ id: ids.adm, trigger: 'manual' }])
  expect(body.deployments).toEqual([{ project_id: ids.adm, id: 101 }])
  expect(body.skipped.map(s => s.project_id)).toEqual([ids.panel])
})

test('a Crew move takes projects out of their piers, says so, and the piers stay behind', async () => {
  const { db, groups, projects, user, liveState, ids } = setup()
  const pier = await (await asUser(groups, user(2)).request('/', json({ name: 'Kunder' }))).json()
  await asUser(projects, user(2)).request(`/${ids.bobapp}`, patch({ group_id: pier.id }))
  const { from, to } = reassignUsers(db, 2, 3)
  const plan = await planReassign({ db }, from, to)
  expect(plan.changes).toContainEqual({ project: 'bobapp', kind: 'pier', before: 'Kunder', after: '' })
  applyReassign({ db, liveState }, plan)
  expect(db.query('SELECT owner_id, group_id FROM projects WHERE id = ?').get(ids.bobapp)).toEqual({ owner_id: 3, group_id: null })
  expect(liveState.projects[ids.bobapp].info.group_id).toBeUndefined() // null is a deletion in LiveState
  expect(db.query('SELECT owner_id FROM project_groups WHERE id = ?').get(pier.id).owner_id).toBe(2)
})

test('removing a crew member takes their empty piers along, live state too', async () => {
  const { db, groups, user, liveState } = setup()
  db.query('DELETE FROM projects WHERE owner_id = 3').run()
  const pier = await (await asUser(groups, user(3)).request('/', json({ name: 'Eve' }))).json()
  const users = asUser(userRoutes({ db, liveState }), user(1))
  expect((await users.request('/3', { method: 'DELETE' })).status).toBe(200)
  expect(db.query('SELECT 1 FROM project_groups WHERE id = ?').get(pier.id)).toBeNull()
  expect(liveState.groups[pier.id]).toBeUndefined()
})

test('a project can be moored straight into a pier', async () => {
  const { groups, projects, user } = setup()
  const pier = await (await asUser(groups, user(1)).request('/', json({ name: 'Mine' }))).json()
  const res = await asUser(projects, user(1)).request('/', json({
    name: 'fresh', git_url: 'https://example.com/fresh.git', runtime: 'container', start_command: 'bun start', group_id: pier.id,
  }))
  expect(res.status).toBe(201)
  expect((await res.json()).group_id).toBe(pier.id)
})
