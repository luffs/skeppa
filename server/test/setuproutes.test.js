import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { githubRoutes } from '../src/routes/github.js'

const CREDS = { appId: '123', privateKey: 'pem', webhookSecret: 'secret' }
const APP_INFO = { name: 'skeppa-deploy', slug: 'skeppa-deploy', html_url: 'https://github.com/apps/skeppa-deploy', extra: 'dropped' }

// The routes run behind requireSession in app.js; these tests hit them bare.
function setup(github) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  const app = new Hono()
  app.route('/', githubRoutes({ db, config: { masterKey: 'a'.repeat(64) }, github }))
  return { app }
}

test('setup reports unconfigured without calling GitHub', async () => {
  let calls = 0
  const { app } = setup({
    credentials: () => ({ appId: null, privateKey: null, webhookSecret: null }),
    getApp: async () => (calls++, APP_INFO),
  })
  const res = await app.request('/setup')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    configured: false, app: null, install_url: null, installed: false, repos: null, error: null,
  })
  expect(calls).toBe(0)
})

test('setup reports a configured but uninstalled app with its install link', async () => {
  const { app } = setup({
    credentials: () => CREDS,
    getApp: async () => APP_INFO,
    listInstallations: async () => [],
  })
  const body = await (await app.request('/setup')).json()
  expect(body.configured).toBe(true)
  expect(body.app).toEqual({ name: 'skeppa-deploy', slug: 'skeppa-deploy', html_url: APP_INFO.html_url })
  expect(body.install_url).toBe('https://github.com/apps/skeppa-deploy/installations/new')
  expect(body.installed).toBe(false)
  expect(body.repos).toBeNull()
  expect(body.error).toBeNull()
})

test('setup counts repos once the app is installed', async () => {
  const { app } = setup({
    credentials: () => CREDS,
    getApp: async () => APP_INFO,
    listInstallations: async () => [{ id: 1 }],
    listRepos: async () => [{ full_name: 'a/b' }, { full_name: 'a/c' }],
  })
  const body = await (await app.request('/setup')).json()
  expect(body.installed).toBe(true)
  expect(body.repos).toBe(2)
})

test('setup surfaces GitHub failures in error instead of failing', async () => {
  const { app } = setup({
    credentials: () => CREDS,
    getApp: async () => {
      throw new Error('GitHub API GET /app failed (401): bad credentials')
    },
  })
  const res = await app.request('/setup')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.configured).toBe(true)
  expect(body.error).toContain('401')
})

test('webhook deliveries pass through, failures become 502', async () => {
  const rows = [{ id: 9, event: 'push', status: 'OK', status_code: 200 }]
  const { app } = setup({ listWebhookDeliveries: async () => rows })
  const res = await app.request('/webhook-deliveries')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(rows)

  const { app: failing } = setup({
    listWebhookDeliveries: async () => {
      throw new Error('GitHub API GET /app/hook/deliveries failed (404): no hook')
    },
  })
  const bad = await failing.request('/webhook-deliveries')
  expect(bad.status).toBe(502)
  expect((await bad.json()).error).toContain('404')
})

test('redeliver validates the id and forwards it', async () => {
  let redelivered = null
  const { app } = setup({ redeliverWebhookDelivery: async id => (redelivered = id) })

  const bad = await app.request('/webhook-deliveries/evil-id/redeliver', { method: 'POST' })
  expect(bad.status).toBe(400)
  expect(redelivered).toBeNull()

  const ok = await app.request('/webhook-deliveries/424242/redeliver', { method: 'POST' })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ ok: true })
  expect(redelivered).toBe('424242')
})

test('redeliver passes GitHub failures through as 502', async () => {
  const { app } = setup({
    redeliverWebhookDelivery: async () => {
      throw new Error('GitHub API POST /app/hook/deliveries/1/attempts failed (422): cannot redeliver')
    },
  })
  const res = await app.request('/webhook-deliveries/1/redeliver', { method: 'POST' })
  expect(res.status).toBe(502)
  expect((await res.json()).error).toContain('422')
})
