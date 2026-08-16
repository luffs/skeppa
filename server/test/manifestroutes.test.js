import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { githubRoutes } from '../src/routes/github.js'
import { getSetting, getSecretSetting } from '../src/db/settings.js'

const MASTER_KEY = 'a'.repeat(64)

// What GitHub's POST /app-manifests/{code}/conversions returns (fields we use).
const CONVERTED = {
  id: 4242,
  slug: 'skeppa-deploy-example-com',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n',
  webhook_secret: 'hook-secret-from-github',
  html_url: 'https://github.com/apps/skeppa-deploy-example-com',
}

// The routes run behind requireSession in app.js; these tests hit them bare.
function setup(github = {}) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  const app = new Hono()
  app.route('/', githubRoutes({ db, config: { masterKey: MASTER_KEY }, github }))
  return { db, app }
}

const start = (app, body) => app.request('/manifest', { method: 'POST', body: JSON.stringify(body) })
const convert = (app, body) => app.request('/manifest/convert', { method: 'POST', body: JSON.stringify(body) })

test('prepares a manifest wired to the panel origin', async () => {
  const { app } = setup()
  const res = await start(app, { origin: 'https://deploy.example.com' })
  expect(res.status).toBe(200)
  const { action, state, manifest } = await res.json()
  expect(state).toMatch(/^[0-9a-f]{32}$/)
  expect(action).toBe(`https://github.com/settings/apps/new?state=${state}`)
  expect(manifest.name).toBe('skeppa-deploy-example-com')
  expect(manifest.url).toBe('https://deploy.example.com')
  expect(manifest.hook_attributes).toEqual({ url: 'https://deploy.example.com/api/webhooks/github' })
  expect(manifest.redirect_url).toBe('https://deploy.example.com/settings')
  expect(manifest.setup_url).toBe('https://deploy.example.com/settings')
  expect(manifest.public).toBe(false)
  expect(manifest.default_permissions).toEqual({ contents: 'read', metadata: 'read' })
  expect(manifest.default_events).toEqual(['push'])
})

test('suggested app names respect the 34-char GitHub limit', async () => {
  const { app } = setup()
  const res = await start(app, { origin: 'https://a-very-long-subdomain-name-here.example.com' })
  const { manifest } = await res.json()
  expect(manifest.name.length).toBeLessThanOrEqual(34)
  expect(manifest.name.startsWith('skeppa-')).toBe(true)
  expect(manifest.name.endsWith('-')).toBe(false)
})

test('targets the organization endpoint when one is given', async () => {
  const { app } = setup()
  const res = await start(app, { origin: 'https://deploy.example.com', organization: 'My-Org' })
  const { action, state } = await res.json()
  expect(action).toBe(`https://github.com/organizations/My-Org/settings/apps/new?state=${state}`)
})

test('rejects bad origins and organization names', async () => {
  const { app } = setup()
  expect((await start(app, {})).status).toBe(400)
  expect((await start(app, { origin: 'not a url' })).status).toBe(400)
  expect((await start(app, { origin: 'ftp://deploy.example.com' })).status).toBe(400)
  expect((await start(app, { origin: 'https://ok.example.com', organization: 'evil/../org' })).status).toBe(400)
  expect((await start(app, { origin: 'https://ok.example.com', organization: '-leading' })).status).toBe(400)
})

test('converts the callback code and stores the credentials encrypted', async () => {
  let seenCode = null
  let resets = 0
  const github = {
    convertManifestCode: async code => ((seenCode = code), CONVERTED),
    reset: () => resets++,
  }
  const { db, app } = setup(github)

  const { state } = await (await start(app, { origin: 'https://deploy.example.com' })).json()
  const res = await convert(app, { code: 'abc123', state })
  expect(res.status).toBe(200)
  expect(seenCode).toBe('abc123')
  expect(resets).toBe(1)
  expect(await res.json()).toEqual({
    app_id: '4242',
    slug: CONVERTED.slug,
    install_url: `https://github.com/apps/${CONVERTED.slug}/installations/new`,
  })
  expect(getSetting(db, 'github_app_id')).toBe('4242')
  expect(getSecretSetting(db, MASTER_KEY, 'github_private_key')).toBe(CONVERTED.pem)
  expect(getSecretSetting(db, MASTER_KEY, 'github_webhook_secret')).toBe(CONVERTED.webhook_secret)

  // The state is single-use: replaying the callback must fail.
  expect((await convert(app, { code: 'abc123', state })).status).toBe(400)
})

test('rejects a convert without a known state', async () => {
  const { db, app } = setup({ convertManifestCode: async () => CONVERTED, reset: () => {} })
  const res = await convert(app, { code: 'abc123', state: 'f'.repeat(32) })
  expect(res.status).toBe(400)
  expect(getSetting(db, 'github_app_id')).toBeNull()
})

test('a malformed code does not burn the pending state', async () => {
  const { app } = setup({ convertManifestCode: async () => CONVERTED, reset: () => {} })
  const { state } = await (await start(app, { origin: 'https://deploy.example.com' })).json()
  expect((await convert(app, { code: 'not valid!', state })).status).toBe(400)
  expect((await convert(app, { code: 'abc123', state })).status).toBe(200)
})

test('passes GitHub conversion failures through without saving', async () => {
  const github = {
    convertManifestCode: async () => {
      throw new Error('GitHub app-manifest conversion failed (404): expired')
    },
    reset: () => {},
  }
  const { db, app } = setup(github)
  const { state } = await (await start(app, { origin: 'https://deploy.example.com' })).json()
  const res = await convert(app, { code: 'abc123', state })
  expect(res.status).toBe(502)
  expect((await res.json()).error).toContain('404')
  expect(getSetting(db, 'github_app_id')).toBeNull()
  expect(getSetting(db, 'github_private_key')).toBeNull()
})

test('rejects an incomplete conversion response without saving', async () => {
  const github = { convertManifestCode: async () => ({ id: 1, slug: 'x' }), reset: () => {} }
  const { db, app } = setup(github)
  const { state } = await (await start(app, { origin: 'https://deploy.example.com' })).json()
  const res = await convert(app, { code: 'abc123', state })
  expect(res.status).toBe(502)
  expect(getSetting(db, 'github_app_id')).toBeNull()
})
