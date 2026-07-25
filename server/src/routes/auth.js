import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { COOKIE_NAME, SESSION_TTL_S, createSession, getSession, deleteSession } from '../auth/sessions.js'

export function authRoutes({ db, config }) {
  const app = new Hono()

  app.post('/login', async c => {
    const body = await c.req.json().catch(() => null)
    const { username, password } = body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'username and password are required' }, 400)
    }
    const user = db.query('SELECT * FROM users WHERE username = ?').get(username)
    const ok = user && (await Bun.password.verify(password, user.password_hash))
    if (!ok) return c.json({ error: 'invalid credentials' }, 401)

    const sessionId = createSession(db, user.id)
    setCookie(c, COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProd && config.isSecureCookie !== false,
      path: '/',
      maxAge: SESSION_TTL_S,
    })
    return c.json({ id: user.id, username: user.username })
  })

  app.post('/logout', c => {
    deleteSession(db, getCookie(c, COOKIE_NAME))
    deleteCookie(c, COOKIE_NAME, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', c => {
    const session = getSession(db, getCookie(c, COOKIE_NAME))
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const user = db.query('SELECT id, username FROM users WHERE id = ?').get(session.user_id)
    return c.json({ id: user?.id ?? null, username: user?.username ?? null })
  })

  return app
}
