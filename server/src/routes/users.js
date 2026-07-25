import { Hono } from 'hono'
import { USERNAME_RE, MIN_PASSWORD_LENGTH } from '../lib/validate.js'
import { getUserInfo } from '../live/state.js'

const hashPassword = password => Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })

export function userRoutes({ db, liveState }) {
  const app = new Hono()

  app.get('/', c => {
    const users = db.query('SELECT id, username, created_at FROM users ORDER BY username').all()
    return c.json(users)
  })

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    const fields = {}
    if (!USERNAME_RE.test(username)) fields.username = 'letters, digits, . _ @ + -; 1–64 characters'
    if (password.length < MIN_PASSWORD_LENGTH) fields.password = `must be at least ${MIN_PASSWORD_LENGTH} characters`
    if (!fields.username && db.query('SELECT 1 FROM users WHERE username = ?').get(username)) {
      fields.username = 'already taken'
    }
    if (Object.keys(fields).length) return c.json({ error: 'validation failed', fields }, 400)

    const hash = await hashPassword(password)
    const { lastInsertRowid } = db.query('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash)
    const user = getUserInfo(db, Number(lastInsertRowid))
    liveState.users[user.id] = user
    return c.json(user, 201)
  })

  app.put('/:id/password', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid user id' }, 400)
    const body = await c.req.json().catch(() => ({}))
    const password = typeof body.password === 'string' ? body.password : ''
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: 'validation failed', fields: { password: `must be at least ${MIN_PASSWORD_LENGTH} characters` } }, 400)
    }
    if (!db.query('SELECT 1 FROM users WHERE id = ?').get(id)) return c.json({ error: 'user not found' }, 404)

    const hash = await hashPassword(password)
    const session = c.get('session')
    db.transaction(() => {
      db.query('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id)
      // Old sessions must not outlive the old password; the caller's own session survives.
      db.query('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(id, session.id)
    })()
    return c.json({ ok: true })
  })

  app.delete('/:id', c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid user id' }, 400)
    // Also guarantees the last remaining user can never be removed.
    if (id === c.get('session').user_id) return c.json({ error: 'you cannot remove your own account' }, 400)
    const { changes } = db.query('DELETE FROM users WHERE id = ?').run(id)
    if (!changes) return c.json({ error: 'user not found' }, 404)
    delete liveState.users[id]
    return c.json({ ok: true })
  })

  return app
}
