import { Hono } from 'hono'
import { USERNAME_RE, MIN_PASSWORD_LENGTH, ROLES, HANDLE_RE, GITHUB_LOGIN_RE } from '../lib/validate.js'
import { getUserInfo } from '../live/state.js'

const hashPassword = password => Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })

export function userRoutes({ db, liveState }) {
  const app = new Hono()

  app.get('/', c => {
    const users = db.query('SELECT id, username, role, handle, github_login, created_at FROM users ORDER BY username').all()
    return c.json(users)
  })

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    // New crew defaults to tenant: full access is now something the admin
    // grants on purpose, not what a typo hands out.
    const role = body.role ?? 'tenant'
    const handle = typeof body.handle === 'string' ? body.handle.trim() : ''
    const githubLogin = typeof body.github_login === 'string' ? body.github_login.trim() : ''

    const fields = {}
    if (!ROLES.includes(role)) fields.role = `must be one of ${ROLES.join(', ')}`
    // The handle namespaces the tenant's convoy networks (and later their
    // subdomains) — a tenant without one would share the admin namespace.
    if (role === 'tenant' && !HANDLE_RE.test(handle)) fields.handle = 'required for tenants: lowercase letters, digits, dashes'
    if (handle && !HANDLE_RE.test(handle)) fields.handle = 'lowercase letters, digits, dashes'
    if (handle && db.query('SELECT 1 FROM users WHERE handle = ?').get(handle)) fields.handle = 'already taken'
    if (githubLogin && !GITHUB_LOGIN_RE.test(githubLogin)) fields.github_login = 'not a valid GitHub login'
    if (!USERNAME_RE.test(username)) fields.username = 'letters, digits, . _ @ + -; 1–64 characters'
    if (password.length < MIN_PASSWORD_LENGTH) fields.password = `must be at least ${MIN_PASSWORD_LENGTH} characters`
    if (!fields.username && db.query('SELECT 1 FROM users WHERE username = ?').get(username)) {
      fields.username = 'already taken'
    }
    if (Object.keys(fields).length) return c.json({ error: 'validation failed', fields }, 400)

    const hash = await hashPassword(password)
    const { lastInsertRowid } = db.query('INSERT INTO users (username, password_hash, role, handle, github_login) VALUES (?, ?, ?, ?, ?)')
      .run(username, hash, role, handle, githubLogin)
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

  // Role, handle and GitHub link are editable after the fact — linking a
  // tenant's GitHub account is typically done once they have installed the
  // app. Demoting the last admin would lock everyone out of Rigging.
  app.put('/:id', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid user id' }, 400)
    const existing = db.query('SELECT * FROM users WHERE id = ?').get(id)
    if (!existing) return c.json({ error: 'user not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const role = 'role' in body ? body.role : existing.role
    const handle = 'handle' in body ? (typeof body.handle === 'string' ? body.handle.trim() : '') : existing.handle
    const githubLogin = 'github_login' in body ? (typeof body.github_login === 'string' ? body.github_login.trim() : '') : existing.github_login

    const fields = {}
    if (!ROLES.includes(role)) fields.role = `must be one of ${ROLES.join(', ')}`
    if (role === 'tenant' && !HANDLE_RE.test(handle)) fields.handle = 'required for tenants: lowercase letters, digits, dashes'
    if (handle && !HANDLE_RE.test(handle)) fields.handle = 'lowercase letters, digits, dashes'
    if (handle && db.query('SELECT 1 FROM users WHERE handle = ? AND id != ?').get(handle, id)) fields.handle = 'already taken'
    if (githubLogin && !GITHUB_LOGIN_RE.test(githubLogin)) fields.github_login = 'not a valid GitHub login'
    if (existing.role === 'admin' && role !== 'admin' &&
        !db.query("SELECT 1 FROM users WHERE role = 'admin' AND id != ?").get(id)) {
      fields.role = 'cannot demote the last admin'
    }
    if (Object.keys(fields).length) return c.json({ error: 'validation failed', fields }, 400)

    db.query('UPDATE users SET role = ?, handle = ?, github_login = ? WHERE id = ?').run(role, handle, githubLogin, id)
    const user = getUserInfo(db, id)
    liveState.users[id] = user
    return c.json(user)
  })

  app.delete('/:id', c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid user id' }, 400)
    // Also guarantees the last remaining user can never be removed.
    if (id === c.get('session').user_id) return c.json({ error: 'you cannot remove your own account' }, 400)
    // Their projects would silently become admin-owned orphans otherwise.
    if (db.query('SELECT 1 FROM projects WHERE owner_id = ?').get(id)) {
      return c.json({ error: 'this user still owns projects — delete or reassign them first' }, 400)
    }
    const { changes } = db.query('DELETE FROM users WHERE id = ?').run(id)
    if (!changes) return c.json({ error: 'user not found' }, 404)
    delete liveState.users[id]
    return c.json({ ok: true })
  })

  return app
}
