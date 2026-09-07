import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { getSetting, setSetting, getSecretSetting } from '../src/db/settings.js'
import { settingsRoutes } from '../src/routes/github.js'

function setup(notifyFn) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  // The PUT handler resets the GitHub token cache after credential changes.
  const app = settingsRoutes({ db, config: { masterKey: 'a'.repeat(64) }, github: { reset() {} }, notifyFn })
  return { db, app }
}

const put = (app, body) => app.request('/', { method: 'PUT', body: JSON.stringify(body) })

test('the webhook URL round-trips and clears', async () => {
  const { db, app } = setup()
  expect((await put(app, { notify_url: 'https://ntfy.sh/topic' })).status).toBe(200)
  // encrypted at rest; the API reports presence and host, never the URL
  expect(getSetting(db, 'notify_url')).not.toContain('ntfy.sh')
  expect(getSecretSetting(db, 'a'.repeat(64), 'notify_url')).toBe('https://ntfy.sh/topic')
  const status = await (await app.request('/')).json()
  expect(status.has_notify_url).toBe(true)
  expect(status.notify_url_host).toBe('ntfy.sh')
  expect(status.notify_url).toBeUndefined()

  await put(app, { notify_url: null })
  expect(getSetting(db, 'notify_url')).toBe(null)
})

test('garbage and non-http URLs are rejected', async () => {
  const { db, app } = setup()
  expect((await put(app, { notify_url: 'not a url' })).status).toBe(400)
  expect((await put(app, { notify_url: 'ftp://files.example' })).status).toBe(400)
  expect(getSetting(db, 'notify_url')).toBe(null)
})

test('the test endpoint sends through the notifier and reports the outcome', async () => {
  const sent = []
  const { db, app } = setup(async (db_, key_, text) => (sent.push(text), true))
  // without a URL there is nothing to test against
  expect((await app.request('/notify/test', { method: 'POST' })).status).toBe(400)

  setSetting(db, 'notify_url', 'https://ntfy.sh/topic')
  const res = await app.request('/notify/test', { method: 'POST' })
  expect(res.status).toBe(200)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Test notification')
})
