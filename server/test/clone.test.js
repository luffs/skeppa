import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../src/db/migrate.js'
import { DeployRunner, DeployError } from '../src/deploy/runner.js'
import { createLiveState, initLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'

// Clone: the code onto the server without a voyage — the same git sync a
// deploy runs, and nothing after it. Against a real repository on disk, so
// the git half is what production runs.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const tick = () => new Promise(r => setTimeout(r, 0))
let tmp, origin

const git = (args, cwd) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`)
  return r.stdout.toString().trim()
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skeppa-clone-'))
  origin = join(tmp, 'origin')
  git(['init', '-b', 'main', origin])
  writeFileSync(join(origin, 'README.md'), '# hello\n')
  git(['add', '.'], origin)
  git(['commit', '-m', 'first commit'], origin)
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function setup({ execute = async () => {}, owner = 'admin' } = {}) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  const appsDir = mkdtempSync(join(tmp, 'apps-'))
  // A local path as the git URL: the route validation would refuse it, but
  // the runner reads the row, and git clones a path as it clones https.
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime)
     VALUES ('app', 'App', ?, '', ?, 'main', 'app', 'container')`
  ).run(owner === 'admin' ? 1 : 2, origin)
  const projectId = Number(lastInsertRowid)
  const liveState = createLiveState()
  liveState.projects[projectId] = projectDefaults(null, getProjectInfo(db, projectId))
  // sandbox: a tenant's deploy is refused at once without it, and the route
  // test needs one actually under way
  const config = { appsDir, masterKey: 'a'.repeat(64), deployTimeoutMs: 1000, selfPm2Name: 'skeppa', sandbox: 'podman' }
  const runner = new DeployRunner({
    db, config, liveState, github: null, execute,
    logs: { openLog() {}, appendLog() {}, closeLog() {} },
  })
  return { db, runner, liveState, config, projectId, source: join(appsDir, 'app', 'source') }
}

test('a clone checks the code out, says so live, and is no voyage', async () => {
  const { db, runner, liveState, projectId, source } = setup()
  expect(liveState.projects[projectId].checkedOut).toBe(false)
  const head = await runner.clone(projectId)
  expect(head.sha).toBe(git(['rev-parse', 'HEAD'], origin))
  expect(head.message).toBe('first commit')
  expect(existsSync(join(source, 'README.md'))).toBe(true)
  expect(liveState.projects[projectId].checkedOut).toBe(true)
  expect(db.query('SELECT COUNT(*) AS n FROM deployments').get().n).toBe(0)
  // a second Clone fetches instead
  expect((await runner.clone(projectId)).sha).toBe(head.sha)
})

test('refused while a deploy is under way — that deploy checks the code out itself', async () => {
  let finish
  const { runner, projectId } = setup({ execute: () => new Promise(r => (finish = r)) })
  runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  await expect(runner.clone(projectId)).rejects.toBeInstanceOf(DeployError)
  finish()
})

test('a deploy asked for during a clone waits, then sets out', async () => {
  const ran = []
  const { db, runner, projectId } = setup({ execute: async () => ran.push('deploy') })
  const cloning = runner.clone(projectId)
  const id = runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  expect(ran).toEqual([]) // git still has the directory
  expect(db.query('SELECT status FROM deployments WHERE id = ?').get(id).status).toBe('queued')
  await cloning
  for (let i = 0; i < 5 && !ran.length; i++) await tick()
  expect(ran).toEqual(['deploy'])
})

test('a git failure is the error, and the queue is free afterwards', async () => {
  const { db, runner, projectId } = setup()
  db.query("UPDATE projects SET branch = 'no-such-branch' WHERE id = ?").run(projectId)
  await expect(runner.clone(projectId)).rejects.toThrow(/git clone failed/)
  expect(runner.queues.get(projectId).runningId).toBeNull()
})

test('boot reads whether each project has a checkout', async () => {
  const { db, runner, config, projectId } = setup()
  const before = createLiveState()
  initLiveState(before, db, config)
  expect(before.projects[projectId].checkedOut).toBe(false)
  await runner.clone(projectId)
  const after = createLiveState()
  initLiveState(after, db, config)
  expect(after.projects[projectId].checkedOut).toBe(true)
})

test('the route: the checkout for the owner, 404 for anyone else, 409 mid-deploy', async () => {
  let finish
  const { db, runner, liveState, config, projectId } = setup({ owner: 'tenant', execute: () => new Promise(r => (finish = r)) })
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => (c.set('user', user), next()))
    app.route('/', projectRoutes({ db, config, liveState, runner }))
    return app
  }
  const bob = as(db.query('SELECT * FROM users WHERE id = 2').get())
  const eve = as({ id: 99, role: 'tenant' })
  expect((await eve.request(`/${projectId}/clone`, { method: 'POST' })).status).toBe(404)
  const ok = await bob.request(`/${projectId}/clone`, { method: 'POST' })
  expect(ok.status).toBe(200)
  expect((await ok.json()).message).toBe('first commit')

  runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  const busy = await bob.request(`/${projectId}/clone`, { method: 'POST' })
  expect(busy.status).toBe(409)
  expect((await busy.json()).error).toMatch(/deploy is under way/)
  finish()
})
