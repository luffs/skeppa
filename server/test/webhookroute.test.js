import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSecretSetting } from '../src/db/settings.js'
import { createLiveState, projectDefaults } from '../src/live/state.js'
import { webhookRoutes } from '../src/routes/webhooks.js'

const SECRET = 'wh-secret'
const MASTER_KEY = randomBytes(32).toString('hex')
const sign = payload => 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')
const tick = () => new Promise(r => setTimeout(r, 0))

function setup({ autoDeploy = 1 } = {}) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  setSecretSetting(db, MASTER_KEY, 'github_webhook_secret', SECRET)
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, auto_deploy)
     VALUES ('app', 'App', 'luff/app', 'main', 'app', ?)`
  ).run(autoDeploy)
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults()
  const enqueued = []
  const runner = { enqueue: (id, opts) => enqueued.push({ id, ...opts }) }
  const app = webhookRoutes({ db, config: { masterKey: MASTER_KEY }, runner, liveState })
  return { db, liveState, enqueued, app }
}

function push(app, payload) {
  const raw = JSON.stringify(payload)
  return app.request('/github', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw), 'x-github-event': 'push' },
  })
}

const PAYLOAD = {
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  repository: { full_name: 'luff/app' },
  head_commit: { message: 'fix: the bug\n\ndetails', timestamp: '2026-07-23T10:00:00Z' },
}

test('push records the head commit and deploys when auto_deploy is on', async () => {
  const { db, liveState, enqueued, app } = setup({ autoDeploy: 1 })
  const res = await push(app, PAYLOAD)
  expect(res.status).toBe(202)
  expect(await res.json()).toEqual({ matched: 1, queued: 1 })
  await tick()

  const row = db.query('SELECT head_sha, head_message, head_pushed_at FROM projects WHERE id = 1').get()
  expect(row.head_sha).toBe(PAYLOAD.after)
  expect(row.head_message).toBe('fix: the bug')
  expect(row.head_pushed_at).toBe('2026-07-23T10:00:00Z')
  expect(liveState.projects[1].headCommit.sha).toBe(PAYLOAD.after)
  expect(enqueued).toEqual([
    { id: 1, trigger: 'webhook', commitSha: PAYLOAD.after, commitMessage: 'fix: the bug' },
  ])
})

test('push records the head commit but does not deploy when auto_deploy is off', async () => {
  const { db, liveState, enqueued, app } = setup({ autoDeploy: 0 })
  const res = await push(app, PAYLOAD)
  expect(await res.json()).toEqual({ matched: 1, queued: 0 })
  await tick()

  expect(db.query('SELECT head_sha FROM projects WHERE id = 1').get().head_sha).toBe(PAYLOAD.after)
  expect(liveState.projects[1].headCommit.message).toBe('fix: the bug')
  expect(enqueued).toEqual([])
})

test('pushes to other branches or repos do not touch the project', async () => {
  const { db, enqueued, app } = setup()
  await push(app, { ...PAYLOAD, ref: 'refs/heads/feature' })
  await push(app, { ...PAYLOAD, repository: { full_name: 'luff/other' } })
  await tick()
  expect(db.query('SELECT head_sha FROM projects WHERE id = 1').get().head_sha).toBeNull()
  expect(enqueued).toEqual([])
})

test('branch deletion pushes are ignored', async () => {
  const { db, enqueued, app } = setup()
  const res = await push(app, { ...PAYLOAD, deleted: true, after: '0'.repeat(40) })
  expect((await res.json()).ignored).toBe('branch deleted')
  await tick()
  expect(db.query('SELECT head_sha FROM projects WHERE id = 1').get().head_sha).toBeNull()
  expect(enqueued).toEqual([])
})
