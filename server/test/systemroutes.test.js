import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { systemRoutes } from '../src/routes/system.js'
import { projectDirs } from '../src/deploy/envfiles.js'
import { appContainerName, prevLogPath } from '../src/containers/runtime.js'

// A fake pm2 module: records what the route asked for and reports a fixed
// process list, so the whitelist logic is exercised without a live daemon.
function fakePm2(procs) {
  const calls = []
  return {
    calls,
    jlist: async () => procs,
    applyAction: async (act, name, ecosystemFile, appEnv) => calls.push({ act, name, ecosystemFile, appEnv }),
  }
}

function setup(pm2, { withProject = false } = {}) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  if (withProject) {
    db.query(
      `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name)
       VALUES ('app', 'App', 'luff/app', 'main', 'app')`
    ).run()
  }
  return systemRoutes({ db, config: { appsDir: '/srv/apps' }, poller: null, pm2 })
}

const proc = (name, extra = {}) => ({ name, pm2_env: { status: 'online', ...extra } })

test('acts on a process pm2 already reports', async () => {
  const pm2 = fakePm2([proc('mageek')])
  const res = await setup(pm2).request('/pm2/mageek/restart', { method: 'POST' })
  expect(res.status).toBe(200)
  expect(pm2.calls).toEqual([{ act: 'restart', name: 'mageek', ecosystemFile: null, appEnv: null }])
})

test('passes the ecosystem file and env for Skeppa-managed processes', async () => {
  const pm2 = fakePm2([proc('app')])
  const res = await setup(pm2, { withProject: true }).request('/pm2/app/start', { method: 'POST' })
  expect(res.status).toBe(200)
  expect(pm2.calls[0].ecosystemFile).toBe(join('/srv/apps', 'app', 'ecosystem.config.cjs'))
  expect(pm2.calls[0].appEnv).toEqual({ NODE_ENV: 'production' })
})

test('stop clears auto_start and start restores it for Skeppa-managed processes', async () => {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name)
     VALUES ('app', 'App', 'luff/app', 'main', 'app')`
  ).run()
  const app = systemRoutes({ db, config: { appsDir: '/srv/apps' }, poller: null, pm2: fakePm2([proc('app')]) })
  const autoStart = () => db.query('SELECT auto_start FROM projects').get().auto_start

  expect(autoStart()).toBe(1) // column default
  await app.request('/pm2/app/stop', { method: 'POST' })
  expect(autoStart()).toBe(0)
  await app.request('/pm2/app/start', { method: 'POST' })
  expect(autoStart()).toBe(1)
})

test('refuses a name pm2 does not report', async () => {
  const pm2 = fakePm2([proc('mageek')])
  const res = await setup(pm2).request('/pm2/ghost/stop', { method: 'POST' })
  expect(res.status).toBe(404)
  expect(pm2.calls).toEqual([])
})

test('rejects a malformed process name before touching pm2', async () => {
  const pm2 = fakePm2([proc('mageek')])
  const res = await setup(pm2).request('/pm2/rm%20-rf%20%2F/stop', { method: 'POST' })
  expect(res.status).toBe(400)
  expect(pm2.calls).toEqual([])
})

test('rejects an unknown action', async () => {
  const pm2 = fakePm2([proc('mageek')])
  const res = await setup(pm2).request('/pm2/mageek/delete', { method: 'POST' })
  expect(res.status).toBe(400)
  expect(pm2.calls).toEqual([])
})

test('tails both log streams for a process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-syslogs-'))
  const outPath = join(dir, 'out.log')
  const errPath = join(dir, 'err.log')
  writeFileSync(outPath, 'boot\nlistening on 3000\n')
  writeFileSync(errPath, 'a warning\n')

  const pm2 = fakePm2([proc('mageek', { pm_out_log_path: outPath, pm_err_log_path: errPath })])
  const res = await setup(pm2).request('/pm2/mageek/logs?lines=1')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.lines).toBe(1)
  expect(body.out.text).toBe('listening on 3000')
  expect(body.out.truncated).toBe(true)
  expect(body.err.text).toBe('a warning')
})

test('reports missing log files without failing the request', async () => {
  const pm2 = fakePm2([proc('mageek', { pm_out_log_path: join(tmpdir(), 'skeppa-nope.log') })])
  const res = await setup(pm2).request('/pm2/mageek/logs')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.out.missing).toBe(true)
  expect(body.err.missing).toBe(true)
  expect(body.err.path).toBe(null)
})

test('clamps the requested line count', async () => {
  const pm2 = fakePm2([proc('mageek')])
  const res = await setup(pm2).request('/pm2/mageek/logs?lines=99999')
  expect((await res.json()).lines).toBe(2000)
})

// --- containers --------------------------------------------------------------

// A fake container engine: records the calls and reports a fixed listing, so
// the whitelist and the owned/external split are exercised without a daemon.
function fakeEngine(names) {
  const calls = []
  return {
    calls,
    listContainers: async () => names.map(n => ({ Names: [`/${n}`] })),
    stopContainer: async id => calls.push(['stop', id]),
    startContainer: async id => calls.push(['start', id]),
    restartContainer: async id => calls.push(['restart', id]),
    removeContainer: async id => calls.push(['remove', id]),
    createContainer: async (name, spec) => (calls.push(['create', name, spec]), 'cid'),
    tailLogs: async (id, lines) => (calls.push(['logs', id, lines]), { out: 'serving', err: '' }),
  }
}

function containerSetup(names = ['skeppa-app-capp', 'postgres']) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, runtime, start_command, port)
     VALUES ('capp', 'CApp', 'luff/capp', 'main', 'capp', 'container', 'bun run start', 4100)`
  ).run()
  const config = {
    appsDir: mkdtempSync(join(tmpdir(), 'skeppa-syscontainers-')),
    masterKey: 'd'.repeat(64),
    containerSocket: '/sock',
    buildImage: 'docker.io/oven/bun:1',
  }
  const engine = fakeEngine(names)
  const app = systemRoutes({ db, config, poller: null, pm2: fakePm2([]), containerClient: engine })
  const project = db.query('SELECT * FROM projects').get()
  return { db, config, app, engine, project }
}

test('restarting a panel-owned container recreates it and restores auto_start', async () => {
  const { db, config, app, engine, project } = containerSetup()
  mkdirSync(projectDirs(config, project).source, { recursive: true })
  db.query('UPDATE projects SET auto_start = 0').run()

  const res = await app.request(`/containers/${appContainerName('capp')}/restart`, { method: 'POST' })
  expect(res.status).toBe(200)
  expect(engine.calls.map(c => c[0])).toEqual(['logs', 'remove', 'create', 'start'])
  expect(db.query('SELECT auto_start FROM projects').get().auto_start).toBe(1)
})

test('stopping a panel-owned container clears auto_start', async () => {
  const { db, app, engine } = containerSetup()
  const res = await app.request(`/containers/${appContainerName('capp')}/stop`, { method: 'POST' })
  expect(res.status).toBe(200)
  expect(engine.calls).toEqual([['stop', 'skeppa-app-capp']])
  expect(db.query('SELECT auto_start FROM projects').get().auto_start).toBe(0)
})

test('recreating a panel-owned container before its first deploy is refused', async () => {
  const { app, engine } = containerSetup()
  const res = await app.request(`/containers/${appContainerName('capp')}/start`, { method: 'POST' })
  expect(res.status).toBe(400)
  expect(engine.calls).toEqual([])
})

test('a container Skeppa does not own gets a plain engine action', async () => {
  const { db, app, engine } = containerSetup()
  expect((await app.request('/containers/postgres/start', { method: 'POST' })).status).toBe(200)
  expect((await app.request('/containers/postgres/restart', { method: 'POST' })).status).toBe(200)
  expect(engine.calls).toEqual([['start', 'postgres'], ['restart', 'postgres']])
  // Nobody else's lifecycle is Skeppa's business to remember.
  expect(db.query('SELECT auto_start FROM projects').get().auto_start).toBe(1)
})

test('refuses a container the engine does not report', async () => {
  const { app, engine } = containerSetup()
  const res = await app.request('/containers/ghost/stop', { method: 'POST' })
  expect(res.status).toBe(404)
  expect(engine.calls).toEqual([])
})

test('rejects a malformed container name before touching the engine', async () => {
  const { app, engine } = containerSetup()
  const res = await app.request('/containers/rm%20-rf%20%2F/stop', { method: 'POST' })
  expect(res.status).toBe(400)
  expect(engine.calls).toEqual([])
})

test('serves container logs in the pm2 response shape', async () => {
  const { app } = containerSetup()
  const res = await app.request('/containers/postgres/logs?lines=50')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({
    name: 'postgres',
    lines: 50,
    out: { path: null, text: 'serving', truncated: false, missing: false },
    err: { path: null, text: '', truncated: false, missing: false },
  })
})

test('refuses logs for a container the engine does not report', async () => {
  const { app } = containerSetup()
  expect((await app.request('/containers/ghost/logs')).status).toBe(404)
})

// --- previous-container log -------------------------------------------------

test('the Engine room serves the post-mortem for a panel-owned container', async () => {
  const { config, app, engine, project } = containerSetup()
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(prevLogPath(dirs), 'segfault\n')

  const res = await app.request(`/containers/${appContainerName('capp')}/logs/previous?lines=25`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.prev.text).toBe('segfault')
  expect(body.prev.path).toBe(prevLogPath(dirs))
  expect(body.lines).toBe(25)
  // the container is gone by definition — reading its post-mortem must not
  // send the engine looking for one
  expect(engine.calls).toEqual([])
})

// Reported missing rather than 404, so the tab renders the same way it does
// for a project that simply has not been redeployed yet.
test('a container the panel does not own reports no post-mortem', async () => {
  const { app } = containerSetup()
  const res = await app.request('/containers/postgres/logs/previous')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.prev.missing).toBe(true)
  expect(body.prev.path).toBe(null)
})

// The path is built from the project row's slug, never from the URL, so a
// hostile name cannot escape APPS_DIR — it simply matches no project.
test('the post-mortem route rejects a malformed container name', async () => {
  const { app } = containerSetup()
  const res = await app.request('/containers/..%2F..%2Fetc/logs/previous')
  expect(res.status).toBe(400)
})

// Removing a container without recreating it (a stopped or deleted project)
// leaves the file behind — that is exactly when it is worth reading.
test('the post-mortem survives the container disappearing from the engine', async () => {
  const { config, app, project } = containerSetup(['postgres'])
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(prevLogPath(dirs), 'last words\n')

  const res = await app.request(`/containers/${appContainerName('capp')}/logs/previous`)
  expect(res.status).toBe(200)
  expect((await res.json()).prev.text).toBe('last words')
})
