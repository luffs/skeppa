import { randomBytes } from 'node:crypto'
import { getCookie } from 'hono/cookie'

export const COOKIE_NAME = 'skeppa_session'
export const SESSION_TTL_S = 60 * 60 * 24 * 7 // 7 days

export function createSession(db, userId) {
  const id = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_S * 1000).toISOString()
  db.query('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt)
  return id
}

export function getSession(db, id) {
  if (!id) return null
  const row = db.query('SELECT * FROM sessions WHERE id = ?').get(id)
  if (!row) return null
  if (row.expires_at <= new Date().toISOString()) {
    deleteSession(db, id)
    return null
  }
  return row
}

export function deleteSession(db, id) {
  if (id) db.query('DELETE FROM sessions WHERE id = ?').run(id)
}

export function pruneSessions(db) {
  db.query('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString())
}

// The session behind a cookie value and its user, or null. The user row is
// what ownership checks and role gates read; never the password hash.
export function sessionUser(db, cookie) {
  const session = getSession(db, cookie)
  if (!session) return null
  const user = db.query('SELECT id, username, role, handle, github_login FROM users WHERE id = ?').get(session.user_id)
  if (!user) {
    deleteSession(db, session.id) // the account is gone — so is the session
    return null
  }
  return { session, user }
}

// One cookie's value out of a raw Cookie header, for callers outside Hono
// (the live stores authenticate a bare Request at upgrade).
export function cookieFromHeader(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

// Hono middleware protecting /api/* (login + webhooks are mounted before it).
// Also attaches the user row: ownership checks and role gates downstream
// read c.get('user') rather than re-querying.
export function requireSession(db) {
  return async (c, next) => {
    const found = sessionUser(db, getCookie(c, COOKIE_NAME))
    if (!found) return c.json({ error: 'unauthorized' }, 401)
    c.set('session', found.session)
    c.set('user', found.user)
    await next()
  }
}

// The panel's own configuration, engine, images, crew and proxy are admin
// space — tenants operate on their projects only.
export function requireAdmin() {
  return async (c, next) => {
    if (c.get('user')?.role !== 'admin') return c.json({ error: 'admins only' }, 403)
    await next()
  }
}
