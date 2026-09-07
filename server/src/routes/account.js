import { Hono } from 'hono'
import { MIN_PASSWORD_LENGTH } from '../lib/validate.js'

// The signed-in user's own account. Tenants cannot reach /api/users (admin
// space), so this is their one way to a password change — and deliberately
// the only self-service there is. Handle and GitHub login stay admin-set: the
// linked login is what the repo picker and moor validation trust, so a tenant
// who could claim the admin's login would see, and clone into their own
// containers, the admin's private repos.
export function accountRoutes({ db }) {
  const app = new Hono()

  app.get('/', c => {
    const { id } = c.get('user')
    return c.json(db.query('SELECT id, username, role, handle, github_login, created_at FROM users WHERE id = ?').get(id))
  })

  app.put('/password', async c => {
    const { id } = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    const current = typeof body.current === 'string' ? body.current : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: 'validation failed', fields: { password: `must be at least ${MIN_PASSWORD_LENGTH} characters` } }, 400)
    }
    const row = db.query('SELECT password_hash FROM users WHERE id = ?').get(id)
    if (!row || !(await Bun.password.verify(current, row.password_hash))) {
      return c.json({ error: 'validation failed', fields: { current: 'current password is wrong' } }, 400)
    }

    const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })
    const session = c.get('session')
    db.transaction(() => {
      db.query('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id)
      // Every other session of this account ends; the one doing this stays.
      db.query('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(id, session.id)
    })()
    return c.json({ ok: true })
  })

  return app
}
