import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { accountRoutes } from '../src/routes/account.js'

async function setup() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  const hash = await Bun.password.hash('old-password-1', { algorithm: 'bcrypt', cost: 4 })
  db.query("INSERT INTO users (username, password_hash, role, handle, github_login) VALUES ('bob', ?, 'tenant', 'bob', 'bobgh')").run(hash)
  const far = new Date(Date.now() + 3600_000).toISOString()
  for (const id of ['mine', 'laptop', 'phone']) {
    db.query('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 1, ?)').run(id, far)
  }
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('user', { id: 1, role: 'tenant' })
    c.set('session', { id: 'mine', user_id: 1 })
    return next()
  })
  app.route('/', accountRoutes({ db }))
  return { db, app }
}

test('a user sees their own account, never the hash', async () => {
  const { app } = await setup()
  const me = await (await app.request('/')).json()
  expect(me).toMatchObject({ username: 'bob', role: 'tenant', handle: 'bob', github_login: 'bobgh' })
  expect(me.password_hash).toBeUndefined()
})

test('changing the password needs the current one and ends the other sessions', async () => {
  const { db, app } = await setup()
  const put = body => app.request('/password', { method: 'PUT', body: JSON.stringify(body) })

  const wrong = await put({ current: 'nope', password: 'new-password-1' })
  expect(wrong.status).toBe(400)
  expect((await wrong.json()).fields.current).toContain('wrong')

  const short = await put({ current: 'old-password-1', password: 'short' })
  expect(short.status).toBe(400)
  expect((await short.json()).fields.password).toBeDefined()

  const ok = await put({ current: 'old-password-1', password: 'new-password-1' })
  expect(ok.status).toBe(200)
  const row = db.query('SELECT password_hash FROM users WHERE id = 1').get()
  expect(await Bun.password.verify('new-password-1', row.password_hash)).toBe(true)
  expect(db.query('SELECT id FROM sessions ORDER BY id').all().map(s => s.id)).toEqual(['mine'])
})
