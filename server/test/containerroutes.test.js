import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { projectRoutes } from '../src/routes/projects.js'
import { createLiveState } from '../src/live/state.js'
import { projectDirs } from '../src/deploy/envfiles.js'
import { appContainerName } from '../src/containers/runtime.js'

function fakeEngine() {
  const calls = []
  return {
    calls,
    async stopContainer(id) { calls.push(['stop', id]) },
    async removeContainer(id) { calls.push(['remove', id]) },
    async createContainer(name, spec) { calls.push(['create', name, spec]); return 'cid' },
    async startContainer(id) { calls.push(['start', id]) },
    async pullImage(ref) { calls.push(['pull', ref]) },
    async tailLogs(id, lines) {
      calls.push(['logs', id, lines])
      return { out: 'hello from app', err: '' }
    },
  }
}

function setup({ runtime = 'container' } = {}) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  const config = {
    appsDir: mkdtempSync(join(tmpdir(), 'skeppa-croutes-')),
    masterKey: 'c'.repeat(64),
    selfPm2Name: 'skeppa',
    containerSocket: '/sock',
    buildImage: 'docker.io/oven/bun:1',
  }
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, start_command, runtime, port)
     VALUES ('capp', 'CApp', 'o/r', 'main', 'capp', 'bun run start', ?, 4100)`
  ).run(runtime)
  const project = db.query('SELECT * FROM projects WHERE id = ?').get(Number(lastInsertRowid))
  const containerClient = fakeEngine()
  const app = projectRoutes({ db, config, liveState: createLiveState(), containerClient })
  return { db, config, project, app, containerClient }
}

test('stop stops the container and clears auto_start', async () => {
  const { db, project, app, containerClient } = setup()
  const res = await app.request(`/${project.id}/pm2/stop`, { method: 'POST' })
  expect(res.status).toBe(200)
  expect(containerClient.calls).toEqual([['stop', appContainerName('capp')]])
  expect(db.query('SELECT auto_start FROM projects').get().auto_start).toBe(0)
})

test('restart recreates the container with freshly decrypted env', async () => {
  const { db, config, project, app, containerClient } = setup()
  mkdirSync(projectDirs(config, project).source, { recursive: true })
  const res = await app.request(`/${project.id}/pm2/restart`, { method: 'POST' })
  expect(res.status).toBe(200)
  const order = containerClient.calls.map(c => c[0])
  // 'logs' first: the outgoing container's tail is saved before the remove.
  expect(order).toEqual(['logs', 'remove', 'create', 'start'])
  expect(readFileSync(join(projectDirs(config, project).root, 'container.prev.log'), 'utf8'))
    .toContain('hello from app')
  const [, , spec] = containerClient.calls.find(c => c[0] === 'create')
  expect(spec.Env).toContain('PORT=4100')
  expect(spec.Env).toContain('NODE_ENV=production')
  expect(db.query('SELECT auto_start FROM projects').get().auto_start).toBe(1)
})

test('restart before the first deploy is refused', async () => {
  const { project, app, containerClient } = setup()
  const res = await app.request(`/${project.id}/pm2/restart`, { method: 'POST' })
  expect(res.status).toBe(400)
  expect(containerClient.calls).toEqual([])
})

test('the logs route serves container logs in the pm2 response shape', async () => {
  const { project, app } = setup()
  const res = await app.request(`/${project.id}/logs?lines=50`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.out.text).toBe('hello from app')
  expect(body.out.missing).toBe(false)
  expect(body.err.text).toBe('')
  expect(body.lines).toBe(50)
})

test('missing container logs report missing instead of failing', async () => {
  const { project, app, containerClient } = setup()
  containerClient.tailLogs = async () => {
    throw Object.assign(new Error('no such container'), { status: 404 })
  }
  const res = await app.request(`/${project.id}/logs`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.out.missing).toBe(true)
})

test('the panel project itself cannot switch to the container runtime', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Panel', repo_full_name: 'o/skeppa', branch: 'main',
      pm2_name: 'skeppa', runtime: 'container',
    }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.runtime).toContain('pm2')
})

test('an unknown runtime value is rejected', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'X', repo_full_name: 'o/x', branch: 'main', runtime: 'firecracker' }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.runtime).toBeDefined()
})
