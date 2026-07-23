import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, initLiveState } from '../src/live/state.js'

function makeDb() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  return db
}

test('initLiveState carries project info, head commit and deployed sha', () => {
  const db = makeDb()
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, auto_deploy,
                           head_sha, head_message, head_pushed_at)
     VALUES ('app', 'App', 'luff/app', 'main', 'app', 0, 'headsha', 'wip', '2026-07-23T10:00:00Z')`
  ).run()
  db.query(
    `INSERT INTO deployments (project_id, status, "trigger", commit_sha, finished_at)
     VALUES (1, 'success', 'manual', 'oldsha', 't1'), (1, 'failed', 'webhook', 'newsha', 't2')`
  ).run()

  const liveState = createLiveState()
  initLiveState(liveState, db)
  const live = liveState.projects[1]

  expect(live.info).toMatchObject({
    id: 1, slug: 'app', name: 'App', repo_full_name: 'luff/app', branch: 'main', auto_deploy: 0,
  })
  expect(live.info.head_sha).toBeUndefined() // head lives in headCommit, not info
  expect(live.headCommit).toEqual({ sha: 'headsha', message: 'wip', pushedAt: '2026-07-23T10:00:00Z' })
  expect(live.lastDeployment).toMatchObject({ status: 'failed', commitSha: 'newsha' })
  expect(live.deployedSha).toBe('oldsha') // last SUCCESSFUL deploy, not the failed one
})

test('initLiveState handles a fresh project without deploys or pushes', () => {
  const db = makeDb()
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name)
     VALUES ('new', 'New', 'luff/new', 'main', 'new')`
  ).run()
  const liveState = createLiveState()
  initLiveState(liveState, db)
  const live = liveState.projects[1]
  expect(live.info.name).toBe('New')
  expect(live.headCommit).toBeNull()
  expect(live.deployedSha).toBeNull()
  expect(live.lastDeployment).toBeNull()
})
