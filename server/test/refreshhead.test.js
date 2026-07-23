import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, projectDefaults } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'

const HEAD = { sha: 'b'.repeat(40), message: 'feat: new thing', pushedAt: '2026-07-23T11:00:00Z' }

function setup(github) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name)
     VALUES ('app', 'App', 'luff/app', 'main', 'app')`
  ).run()
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults()
  const app = projectRoutes({ db, config: {}, liveState, runner: {}, github })
  return { db, liveState, app }
}

test('refresh-head stores the fetched head in DB and LiveState', async () => {
  const calls = []
  const github = {
    getBranchHead: async (repo, branch) => {
      calls.push([repo, branch])
      return HEAD
    },
  }
  const { db, liveState, app } = setup(github)

  const res = await app.request('/1/refresh-head', { method: 'POST' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual(HEAD)
  expect(calls).toEqual([['luff/app', 'main']])

  const row = db.query('SELECT head_sha, head_message, head_pushed_at FROM projects WHERE id = 1').get()
  expect(row).toEqual({ head_sha: HEAD.sha, head_message: HEAD.message, head_pushed_at: HEAD.pushedAt })
  expect(liveState.projects[1].headCommit).toEqual(HEAD)
})

test('refresh-head reports GitHub failures as 502 and leaves state untouched', async () => {
  const github = { getBranchHead: async () => { throw new Error('GitHub API GET failed (401)') } }
  const { db, liveState, app } = setup(github)

  const res = await app.request('/1/refresh-head', { method: 'POST' })
  expect(res.status).toBe(502)
  expect((await res.json()).error).toContain('401')
  expect(db.query('SELECT head_sha FROM projects WHERE id = 1').get().head_sha).toBeNull()
  expect(liveState.projects[1].headCommit).toBeNull()
})

test('refresh-head 404s for unknown projects', async () => {
  const { app } = setup({ getBranchHead: async () => HEAD })
  const res = await app.request('/99/refresh-head', { method: 'POST' })
  expect(res.status).toBe(404)
})
