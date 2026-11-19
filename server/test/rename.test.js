import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { DeployRunner, DeployError } from '../src/deploy/runner.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { writeEcosystem } from '../src/deploy/envfiles.js'

// A new slug moves the berth (APPS_DIR/<slug>) and renames the container,
// taking the app down and bringing it back under the new name.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const tick = () => new Promise(r => setTimeout(r, 0))

// An engine that keeps containers and networks by name and records calls.
function fakeEngine({ running = [], failCreate = false } = {}) {
  const containers = new Map(running.map(name => [name, { running: true }]))
  const networks = new Set()
  const calls = []
  return {
    containers, networks, calls,
    async inspectContainer(name) {
      const c = containers.get(name)
      return c ? { State: { Running: c.running } } : null
    },
    async tailLogs() { return { out: 'last words\n', err: '' } },
    async stopContainer(name) {
      calls.push(['stop', name])
      if (!containers.has(name)) throw Object.assign(new Error('no such container'), { status: 404 })
      containers.get(name).running = false
    },
    async removeContainer(name) { calls.push(['remove', name]); containers.delete(name) },
    async createContainer(name, spec) {
      if (failCreate) throw new Error('image is gone')
      calls.push(['create', name, spec])
      containers.set(name, { running: false, spec })
      return name
    },
    async startContainer(name) { containers.get(name).running = true },
    async hasNetwork(name) { return networks.has(name) },
    async createNetwork(name) { networks.add(name) },
    async removeNetwork(name) { calls.push(['removeNetwork', name]); networks.delete(name) },
  }
}

function fakePm2(online = []) {
  const procs = new Map(online.map(n => [n, 'online']))
  const calls = []
  return {
    calls,
    describe: async name => (procs.has(name) ? { name, pm2_env: { status: procs.get(name) } } : null),
    deleteProcess: async name => { calls.push(['delete', name]); procs.delete(name) },
    startOrReload: async file => { calls.push(['start', file]) },
  }
}

function setup({ runtime = 'container', engine = fakeEngine(), pm2 = fakePm2(), owner = 1, slug = 'app', pm2Name = 'app', network = 'open' } = {}) {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  const appsDir = mkdtempSync(join(tmpdir(), 'skeppa-rename-'))
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, deployed_runtime, start_command, run_image, port, network_profile)
     VALUES (?, 'App', ?, 'o/r', 'main', ?, ?, ?, 'bun start', 'oven/bun', 4100, ?)`
  ).run(slug, owner, pm2Name, runtime, runtime, network)
  const projectId = Number(lastInsertRowid)
  db.query(`INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name) VALUES ('taken', 'Other', 'o/x', 'main', 'taken')`).run()
  // A berth with something in each part.
  const root = join(appsDir, slug)
  for (const dir of ['source', 'shared', 'public']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'source', 'index.js'), 'serve()\n')
  writeFileSync(join(root, 'shared', 'data.db'), 'rows')
  const liveState = createLiveState()
  liveState.projects[projectId] = projectDefaults(null, getProjectInfo(db, projectId))
  const config = { appsDir, masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa', containerSocket: '/run/fake.sock', buildImage: 'oven/bun' }
  let finish = null
  const runner = new DeployRunner({
    db, config, liveState, github: null, pm2,
    execute: () => new Promise(r => (finish = r)),
    logs: { openLog() {}, appendLog() {}, closeLog() {} },
  })
  const rename = slug => runner.renameSlug(projectId, slug, { engine: () => engine })
  return { db, config, liveState, runner, engine, pm2, projectId, appsDir, rename, finishDeploy: () => finish?.() }
}

test('a running container moves: berth renamed, row changed, container recreated under the new name', async () => {
  const engine = fakeEngine({ running: ['skeppa-app-app'] })
  const { db, liveState, projectId, appsDir, rename } = setup({ engine })
  const result = await rename('blog')
  expect(result).toEqual({ slug: 'blog', restarted: true, warning: '' })
  expect(db.query('SELECT slug FROM projects WHERE id = ?').get(projectId).slug).toBe('blog')
  expect(existsSync(join(appsDir, 'app'))).toBe(false)
  expect(readFileSync(join(appsDir, 'blog', 'shared', 'data.db'), 'utf8')).toBe('rows')
  // the old container's last logs moved along with the berth
  expect(readFileSync(join(appsDir, 'blog', 'container.prev.log'), 'utf8')).toContain('last words')
  expect(engine.containers.has('skeppa-app-app')).toBe(false)
  expect(engine.containers.get('skeppa-app-blog').running).toBe(true)
  const spec = engine.calls.find(c => c[0] === 'create')[2]
  expect(spec.HostConfig.Binds[0]).toBe(`${join(appsDir, 'blog', 'source')}:/app:ro`)
  expect(spec.Labels['skeppa.project']).toBe('blog')
  expect(liveState.projects[projectId].info.slug).toBe('blog')
})

test('a stopped container is removed and stays down; start recreates it later', async () => {
  const engine = fakeEngine({ running: ['skeppa-app-app'] })
  engine.containers.get('skeppa-app-app').running = false
  const { rename } = setup({ engine })
  expect((await rename('blog')).restarted).toBe(false)
  expect([...engine.containers.keys()]).toEqual([])
})

test("a restricted project's own network goes with its old name", async () => {
  const engine = fakeEngine({ running: ['skeppa-app-app'] })
  engine.networks.add('skeppa-net-app')
  const { rename } = setup({ engine, network: 'restricted' })
  await rename('blog')
  expect(engine.networks.has('skeppa-net-blog')).toBe(true)
  expect(engine.networks.has('skeppa-net-app')).toBe(false)
})

test('a pm2 app is deleted, its ecosystem rewritten to the new path, and started from it', async () => {
  const pm2 = fakePm2(['app'])
  const { db, config, projectId, appsDir, rename } = setup({ runtime: 'pm2', pm2 })
  writeEcosystem(config, db.query('SELECT * FROM projects WHERE id = ?').get(projectId))
  await rename('blog')
  const eco = join(appsDir, 'blog', 'ecosystem.config.cjs')
  expect(readFileSync(eco, 'utf8')).toContain(JSON.stringify(join(appsDir, 'blog', 'source')))
  expect(pm2.calls).toEqual([['delete', 'app'], ['start', eco]])
})

test('a static site just moves', async () => {
  const engine = fakeEngine()
  const { appsDir, rename } = setup({ runtime: 'static', engine })
  await rename('site')
  expect(existsSync(join(appsDir, 'site', 'public'))).toBe(true)
  expect(engine.calls).toEqual([])
})

test('refusals: bad shape, taken, a leftover directory, the panel itself — nothing touched', async () => {
  const engine = fakeEngine({ running: ['skeppa-app-app'] })
  const { appsDir, rename } = setup({ engine })
  await expect(rename('Bad Slug')).rejects.toThrow(/lowercase/)
  await expect(rename('taken')).rejects.toThrow(/already used/)
  mkdirSync(join(appsDir, 'old-leftover'))
  await expect(rename('old-leftover')).rejects.toThrow(/already exists on disk/)
  expect(engine.calls).toEqual([])
  expect(existsSync(join(appsDir, 'app', 'source', 'index.js'))).toBe(true)

  const self = setup({ runtime: 'pm2', pm2Name: 'skeppa' })
  await expect(self.rename('panel')).rejects.toThrow(/panel's own/)
})

test('an app that does not come back still has its new slug, and says why', async () => {
  const engine = fakeEngine({ running: ['skeppa-app-app'], failCreate: true })
  const { db, projectId, rename } = setup({ engine })
  const result = await rename('blog')
  expect(result.restarted).toBe(false)
  expect(result.warning).toMatch(/did not start again: image is gone/)
  expect(db.query('SELECT slug FROM projects WHERE id = ?').get(projectId).slug).toBe('blog')
})

test('refused mid-deploy; a deploy asked for during a rename waits for it', async () => {
  const { runner, projectId, rename, finishDeploy } = setup()
  runner.enqueue(projectId, { trigger: 'manual' })
  await tick()
  await expect(rename('blog')).rejects.toBeInstanceOf(DeployError)
  finishDeploy()
  for (let i = 0; i < 5 && runner.queues.get(projectId).runningId != null; i++) await tick()

  const renaming = rename('blog')
  runner.enqueue(projectId, { trigger: 'manual' })
  expect(runner.queues.get(projectId).queuedId).not.toBeNull()
  await renaming
  for (let i = 0; i < 5 && runner.queues.get(projectId).queuedId != null; i++) await tick()
  expect(runner.queues.get(projectId).queuedId).toBeNull()
  finishDeploy()
})

test('the route: the owner renames, others get 404, refusals are field errors, the gate reloads', async () => {
  const engine = fakeEngine()
  const s = setup({ engine, owner: 2 })
  let applied = 0
  const proxy = { apply: async () => { applied++ } }
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => (c.set('user', user), next()))
    app.route('/', projectRoutes({ db: s.db, config: s.config, liveState: s.liveState, runner: s.runner, proxy, containerClient: engine }))
    return app
  }
  const post = (app, slug) => app.request(`/${s.projectId}/slug`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }),
  })
  const bob = as(s.db.query('SELECT * FROM users WHERE id = 2').get())
  const eve = as({ id: 99, role: 'tenant' })
  expect((await post(eve, 'blog')).status).toBe(404)
  const bad = await post(bob, 'taken')
  expect(bad.status).toBe(400)
  expect((await bad.json()).fields.slug).toMatch(/already used/)
  expect(applied).toBe(0)
  const ok = await post(bob, 'blog')
  expect(ok.status).toBe(200)
  const body = await ok.json()
  expect(body.slug).toBe('blog')
  expect(body.warning).toBe('')
  expect(applied).toBe(1)
})
