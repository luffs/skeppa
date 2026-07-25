import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { authRoutes } from '../src/routes/auth.js'
import { settingsRoutes } from '../src/routes/github.js'
import { setSetting, getFirebaseConfig } from '../src/db/settings.js'

const EMAIL = 'rb.luff@gmail.com'
const verified = (email, emailVerified = true) => async () => ({ users: [{ email, emailVerified }] })

function setup({ configured = true, lookup = verified(EMAIL) } = {}) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  db.query("INSERT INTO users (username, password_hash) VALUES (?, 'not-used-here')").run(EMAIL)
  if (configured) setSetting(db, 'firebase_config', JSON.stringify({ apiKey: 'AIzaSyFakeKeyForTests' }))
  const app = authRoutes({ db, config: { isProd: false }, getFirebaseUser: lookup })
  return { db, app }
}

const firebaseLogin = (app, body = { idToken: 'tok' }) =>
  app.request('/firebase', { method: 'POST', body: JSON.stringify(body) })

test('signs in when the verified Google email matches a username', async () => {
  const { db, app } = await setup()
  const res = await firebaseLogin(app)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ username: EMAIL })
  expect(res.headers.get('set-cookie')).toContain('skeppa_session=')
  expect(db.query('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(1)
})

test('matches the email case-insensitively', async () => {
  const { app } = setup({ lookup: verified('RB.Luff@Gmail.com') })
  const res = await firebaseLogin(app)
  expect(res.status).toBe(200)
  expect((await res.json()).username).toBe(EMAIL)
})

test('rejects a Google account with no matching crew member', async () => {
  const { db, app } = setup({ lookup: verified('stranger@gmail.com') })
  const res = await firebaseLogin(app)
  expect(res.status).toBe(401)
  expect(db.query('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0)
})

test('rejects an unverified email', async () => {
  const { app } = setup({ lookup: verified(EMAIL, false) })
  expect((await firebaseLogin(app)).status).toBe(401)
})

test('rejects an invalid or expired token', async () => {
  const { app } = setup({ lookup: async () => ({}) })
  expect((await firebaseLogin(app)).status).toBe(401)
})

test('400 when Google sign-in is not configured', async () => {
  const { app } = setup({ configured: false })
  expect((await firebaseLogin(app)).status).toBe(400)
})

test('400 without an idToken', async () => {
  const { app } = setup()
  expect((await firebaseLogin(app, {})).status).toBe(400)
})

test('502 when the identity service is unreachable', async () => {
  const { app } = setup({ lookup: async () => { throw new Error('boom') } })
  expect((await firebaseLogin(app)).status).toBe(502)
})

test('firebase-config endpoint serves the stored config, null otherwise', async () => {
  const { app } = setup()
  expect(await (await app.request('/firebase-config')).json()).toEqual({ apiKey: 'AIzaSyFakeKeyForTests' })
  const bare = setup({ configured: false })
  expect(await (await bare.app.request('/firebase-config')).json()).toBe(null)
})

// -- settings API --

function settingsSetup() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  return { db, app: settingsRoutes({ db, config: {}, github: { reset() {} } }) }
}

test('settings round-trips firebase_config, strips unknown keys, and clears it', async () => {
  const { db, app } = settingsSetup()
  const put = body => app.request('/', { method: 'PUT', body: JSON.stringify(body) })

  const res = await put({
    firebase_config: { apiKey: 'AIzaSyFakeKeyForTests', authDomain: 'x.firebaseapp.com', evil: 'nope' },
  })
  expect(res.status).toBe(200)
  expect(getFirebaseConfig(db)).toEqual({ apiKey: 'AIzaSyFakeKeyForTests', authDomain: 'x.firebaseapp.com' })
  expect((await (await app.request('/')).json()).firebase_config.apiKey).toBe('AIzaSyFakeKeyForTests')

  expect((await put({ firebase_config: null })).status).toBe(200)
  expect(getFirebaseConfig(db)).toBe(null)
})

test('settings rejects a malformed firebase_config', async () => {
  const { app } = settingsSetup()
  const put = body => app.request('/', { method: 'PUT', body: JSON.stringify(body) })
  expect((await put({ firebase_config: { apiKey: 'nope"; DROP' } })).status).toBe(400)
  expect((await put({ firebase_config: [1, 2] })).status).toBe(400)
  expect((await put({ firebase_config: {} })).status).toBe(400)
})
