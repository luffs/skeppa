import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { DeployRunner, DeployError, recoverInterrupted } from '../src/deploy/runner.js'
import { createLiveState, RECENT_DEPLOYMENTS_LIMIT } from '../src/live/state.js'

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const tick = () => new Promise(r => setTimeout(r, 0))

function setup(execute) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrationsDir)
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name) VALUES ('p', 'P', 'o/r', 'main', 'p')`
  ).run()
  const liveState = createLiveState()
  const runner = new DeployRunner({
    db,
    config: { appsDir: '/tmp/apps', masterKey: 'a'.repeat(64), deployTimeoutMs: 1000, selfPm2Name: 'skeppa' },
    liveState,
    logs: { openLog() {}, appendLog() {}, closeLog() {} },
    github: null,
    execute,
  })
  return { db, runner, liveState, projectId: Number(lastInsertRowid) }
}

// Executor whose completion the test controls.
function manualExecutor() {
  const pending = []
  const execute = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  return { execute, pending }
}

const statuses = db =>
  db.query('SELECT id, status FROM deployments ORDER BY id').all().map(r => r.status)

test('a single deploy runs to success', async () => {
  const { execute, pending } = manualExecutor()
  const { db, runner, projectId } = setup(execute)
  const id = runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  expect(db.query('SELECT status FROM deployments WHERE id = ?').get(id).status).toBe('running')
  pending[0].resolve()
  await tick(); await tick()
  const row = db.query('SELECT * FROM deployments WHERE id = ?').get(id)
  expect(row.status).toBe('success')
  expect(row.exit_code).toBe(0)
  expect(row.started_at).toBeTruthy()
  expect(row.finished_at).toBeTruthy()
})

test('a failing deploy is marked failed with the exit code', async () => {
  const { execute, pending } = manualExecutor()
  const { db, runner, projectId } = setup(execute)
  const id = runner.enqueue(projectId, { trigger: 'webhook' })
  await tick()
  pending[0].reject(Object.assign(new Error('boom'), { exitCode: 7 }))
  await tick(); await tick()
  const row = db.query('SELECT * FROM deployments WHERE id = ?').get(id)
  expect(row.status).toBe('failed')
  expect(row.log).toContain('boom')
})

test('a deploy enqueued while one runs waits, then runs', async () => {
  const { execute, pending } = manualExecutor()
  const { db, runner, projectId } = setup(execute)
  runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  const second = runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  expect(pending.length).toBe(1) // second not started yet
  expect(db.query('SELECT status FROM deployments WHERE id = ?').get(second).status).toBe('queued')
  pending[0].resolve()
  await tick(); await tick()
  expect(pending.length).toBe(2) // now it started
  pending[1].resolve()
  await tick(); await tick()
  expect(statuses(db)).toEqual(['success', 'success'])
})

test('a newer enqueue replaces the waiting deploy (max 1 queued)', async () => {
  const { execute, pending } = manualExecutor()
  const { db, runner, projectId } = setup(execute)
  runner.enqueue(projectId, { trigger: 'webhook' })
  await tick()
  const waiting = runner.enqueue(projectId, { trigger: 'webhook' })
  const replacement = runner.enqueue(projectId, { trigger: 'webhook' })
  pending[0].resolve()
  await tick(); await tick()
  pending[1].resolve()
  await tick(); await tick()
  expect(db.query('SELECT status FROM deployments WHERE id = ?').get(waiting).status).toBe('cancelled')
  expect(db.query('SELECT status FROM deployments WHERE id = ?').get(replacement).status).toBe('success')
  expect(pending.length).toBe(2) // the cancelled one never executed
})

test('deploys for different projects run in parallel', async () => {
  const { execute, pending } = manualExecutor()
  const { db, runner, projectId } = setup(execute)
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name) VALUES ('q', 'Q', 'o/r2', 'main', 'q')`
  ).run()
  runner.enqueue(projectId, { trigger: 'manual' })
  runner.enqueue(Number(lastInsertRowid), { trigger: 'manual' })
  await tick()
  expect(pending.length).toBe(2) // both started without waiting on each other
  pending.forEach(p => p.resolve())
  await tick(); await tick()
  expect(statuses(db)).toEqual(['success', 'success'])
})

// The dashboard renders its log from LiveState, so every status change has to
// land there — otherwise the log silently freezes at whatever the last
// snapshot held.
test('recentDeployments follows a deploy through queued, running and success', async () => {
  const { execute, pending } = manualExecutor()
  const { runner, liveState, projectId } = setup(execute)
  const recent = () => liveState.projects[projectId].recentDeployments

  const id = runner.enqueue(projectId, { trigger: 'manual' })
  expect(recent().length).toBe(1)
  expect(recent()[0]).toMatchObject({ id, status: 'queued', trigger: 'manual' })

  await tick()
  expect(recent()[0]).toMatchObject({ id, status: 'running' })
  expect(recent()[0].startedAt).toBeTruthy()

  pending[0].resolve()
  await tick(); await tick()
  expect(recent()[0]).toMatchObject({ id, status: 'success' })
  expect(recent()[0].finishedAt).toBeTruthy()
})

test('a replaced waiting deploy shows up as cancelled in recentDeployments', async () => {
  const { execute, pending } = manualExecutor()
  const { runner, liveState, projectId } = setup(execute)
  runner.enqueue(projectId, { trigger: 'webhook' })
  await tick()
  const waiting = runner.enqueue(projectId, { trigger: 'webhook' })
  runner.enqueue(projectId, { trigger: 'webhook' })

  const recent = liveState.projects[projectId].recentDeployments
  expect(recent.length).toBe(3) // newest first
  expect(recent.find(d => d.id === waiting).status).toBe('cancelled')
  pending[0].resolve()
  await tick(); await tick()
})

test('recentDeployments keeps only the newest few', async () => {
  const { execute, pending } = manualExecutor()
  const { runner, liveState, projectId } = setup(execute)
  for (let i = 0; i < RECENT_DEPLOYMENTS_LIMIT + 3; i++) {
    runner.enqueue(projectId, { trigger: 'manual' })
    await tick()
    pending.at(-1)?.resolve()
    await tick(); await tick()
  }
  const recent = liveState.projects[projectId].recentDeployments
  expect(recent.length).toBe(RECENT_DEPLOYMENTS_LIMIT)
  expect(recent[0].id).toBeGreaterThan(recent.at(-1).id)
})

test('recoverInterrupted fails queued and running deployments on startup', () => {
  const { db, projectId } = setup(() => {})
  db.query(`INSERT INTO deployments (project_id, status, "trigger") VALUES (?, 'running', 'manual')`).run(projectId)
  db.query(`INSERT INTO deployments (project_id, status, "trigger") VALUES (?, 'queued', 'webhook')`).run(projectId)
  db.query(`INSERT INTO deployments (project_id, status, "trigger", finished_at) VALUES (?, 'success', 'manual', 'x')`).run(projectId)
  expect(recoverInterrupted(db)).toBe(2)
  expect(statuses(db)).toEqual(['failed', 'failed', 'success'])
})

test('a failed deploy fires the notifier; a successful one stays quiet', async () => {
  const notes = []
  const { execute, pending } = manualExecutor()
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query(`INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name) VALUES ('p', 'Mageek', 'o/r', 'main', 'p')`).run()
  const runner = new DeployRunner({
    db,
    config: { appsDir: '/tmp/apps', masterKey: 'a'.repeat(64), deployTimeoutMs: 1000, selfPm2Name: 'skeppa' },
    liveState: createLiveState(),
    logs: { openLog() {}, appendLog() {}, closeLog() {} },
    github: null,
    execute,
    notify: text => notes.push(text),
  })

  runner.enqueue(1, { trigger: 'manual' })
  await tick()
  pending[0].resolve()
  await tick(); await tick()
  expect(notes).toEqual([])

  runner.enqueue(1, { trigger: 'webhook', commitSha: 'deadbeefcafe' })
  await tick()
  pending[1].reject(new DeployError('boom', 7))
  await tick(); await tick()
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Mageek')
  expect(notes[0]).toContain('deadbee')
  expect(notes[0]).toContain('exit 7')
})

// The apps-dir disk gauge is invalidated by the one event that changes the
// tree the panel owns: a deploy landing — failed ones included, since the
// checkout is on disk before the script's exit code is known.
test('a finished deploy invalidates the disk gauge, success or not', async () => {
  const invalidations = []
  const rebases = []
  const { execute, pending } = manualExecutor()
  const { db, runner, projectId } = (() => {
    const base = setup(execute)
    base.runner.poller = {
      diskChanged: () => invalidations.push(1),
      expectRestart: id => rebases.push(id),
    }
    return base
  })()

  runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  expect(invalidations.length).toBe(0) // still running — nothing landed yet
  pending[0].resolve()
  await tick(); await tick()
  expect(invalidations.length).toBe(1)
  // ...and told the crash watch the restart it caused is not a crash.
  expect(rebases).toEqual([projectId])

  runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  pending[1].reject(new DeployError('script blew up', 3))
  await tick(); await tick()
  expect(invalidations.length).toBe(2)
  // A failed deploy usually never reached the reload step — keep the
  // crash history it may be evidence of.
  expect(rebases).toEqual([projectId])
  expect(statuses(db)).toEqual(['success', 'failed'])
})
