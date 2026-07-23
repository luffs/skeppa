import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, projectDefaults } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'

function setup(github) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name)
     VALUES ('app', 'App', 'luff/app', 'release/v2', 'app')`
  ).run()
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults()
  return projectRoutes({ db, config: {}, liveState, runner: {}, github })
}

test('clone-command wraps the installation token in a git clone command', async () => {
  const app = setup({
    getInstallationTokenInfo: async () => ({ token: 'ghs_testtoken', expiresAt: 1753268400000 }),
  })
  const res = await app.request('/1/clone-command', { method: 'POST' })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.command).toBe(
    'git clone --branch release/v2 https://x-access-token:ghs_testtoken@github.com/luff/app.git'
  )
  expect(body.expiresAt).toBe(1753268400000)
})

test('clone-command reports GitHub failures as 502', async () => {
  const app = setup({
    getInstallationTokenInfo: async () => { throw new Error('GitHub App is not configured') },
  })
  const res = await app.request('/1/clone-command', { method: 'POST' })
  expect(res.status).toBe(502)
  expect((await res.json()).error).toContain('not configured')
})

test('clone-command 404s for unknown projects', async () => {
  const app = setup({ getInstallationTokenInfo: async () => ({ token: 't', expiresAt: null }) })
  const res = await app.request('/99/clone-command', { method: 'POST' })
  expect(res.status).toBe(404)
})
