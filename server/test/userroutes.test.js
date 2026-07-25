import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { userRoutes } from '../src/routes/users.js'

// The routes run behind requireSession in app.js; here a stub middleware plays
// that part so tests can pick who the caller is.
async function setup() {
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

  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('session', { id: 'sess-captain', user_id: 1 })
    return next()
  })
  app.route('/', userRoutes({ db }))
  return { db, app }
}

const sessionIds = db => db.query('SELECT id FROM sessions ORDER BY id').all().map(r => r.id)

test('lists users without password hashes', async () => {
  const { app } = await setup()
  const res = await app.request('/')
  expect(res.status).toBe(200)
  const users = await res.json()
  expect(users.map(u => u.username)).toEqual(['bosun', 'captain'])
  expect(Object.keys(users[0]).sort()).toEqual(['created_at', 'id', 'username'])
})

test('creates a user with a hashed password', async () => {
  const { db, app } = await setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ username: 'deckhand', password: 'seaworthy1' }),
  })
  expect(res.status).toBe(201)
  expect((await res.json()).username).toBe('deckhand')
  const row = db.query("SELECT password_hash FROM users WHERE username = 'deckhand'").get()
  expect(await Bun.password.verify('seaworthy1', row.password_hash)).toBe(true)
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

test('deletes another user and cascades their sessions', async () => {
  const { db, app } = await setup()
  const res = await app.request('/2', { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(db.query('SELECT COUNT(*) AS n FROM users').get().n).toBe(1)
  expect(sessionIds(db)).toEqual(['sess-captain', 'sess-captain-phone'])
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
