import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { COOKIE_NAME, SESSION_TTL_S, createSession, getSession, deleteSession } from '../auth/sessions.js'
import { getFirebaseUser as lookupFirebaseUser } from '../auth/firebase.js'
import { getFirebaseConfig } from '../db/settings.js'

export function authRoutes({ db, config, getFirebaseUser = lookupFirebaseUser }) {
  const app = new Hono()

  const issueSession = (c, userId) => {
    const sessionId = createSession(db, userId)
    setCookie(c, COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProd && config.isSecureCookie !== false,
      path: '/',
      maxAge: SESSION_TTL_S,
    })
  }

  app.post('/login', async c => {
    const body = await c.req.json().catch(() => null)
    const { username, password } = body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string') {
      return c.json({ error: 'username and password are required' }, 400)
    }
    const user = db.query('SELECT * FROM users WHERE username = ?').get(username)
    const ok = user && (await Bun.password.verify(password, user.password_hash))
    if (!ok) return c.json({ error: 'invalid credentials' }, 401)

    issueSession(c, user.id)
    return c.json({ id: user.id, username: user.username, role: user.role, handle: user.handle })
  })

  // Public: the login page needs this to initialize Firebase before anyone is
  // signed in. A Firebase web config is not a secret — it ships in every
  // client bundle of any Firebase app.
  app.get('/firebase-config', c => c.json(getFirebaseConfig(db)))

  app.post('/firebase', async c => {
    const firebaseConfig = getFirebaseConfig(db)
    if (!firebaseConfig) return c.json({ error: 'Google sign-in is not configured' }, 400)

    const body = await c.req.json().catch(() => null)
    const idToken = body?.idToken
    if (typeof idToken !== 'string' || !idToken) return c.json({ error: 'idToken is required' }, 400)

    let result
    try {
      result = await getFirebaseUser({ idToken, apiKey: firebaseConfig.apiKey })
    } catch {
      return c.json({ error: 'could not reach the Google identity service' }, 502)
    }
    const account = result?.users?.[0]
    if (!account?.email) return c.json({ error: 'invalid or expired Google sign-in' }, 401)
    // Unverified addresses would let anyone who can register that email in the
    // Firebase project (e.g. via the email/password provider) impersonate it.
    if (account.emailVerified !== true) return c.json({ error: 'Google account email is not verified' }, 401)

    const user = db.query('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(account.email)
    if (!user) return c.json({ error: `no crew member named ${account.email}` }, 401)

    issueSession(c, user.id)
    return c.json({ id: user.id, username: user.username, role: user.role, handle: user.handle })
  })

  app.post('/logout', c => {
    deleteSession(db, getCookie(c, COOKIE_NAME))
    deleteCookie(c, COOKIE_NAME, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', c => {
    const session = getSession(db, getCookie(c, COOKIE_NAME))
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const user = db.query('SELECT id, username, role, handle FROM users WHERE id = ?').get(session.user_id)
    return c.json({ id: user?.id ?? null, username: user?.username ?? null, role: user?.role ?? null, handle: user?.handle ?? null })
  })

  return app
}
