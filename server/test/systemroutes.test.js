import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { systemRoutes } from '../src/routes/system.js'

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
