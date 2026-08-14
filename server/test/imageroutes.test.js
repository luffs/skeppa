import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { imageRoutes } from '../src/routes/images.js'
import { managedRef } from '../src/containers/images.js'

function setup({ engine = fakeEngine() } = {}) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  const config = { containerSocket: '/sock', buildImage: 'docker.io/oven/bun:1' }
  const app = imageRoutes({ db, config, containerClient: engine })
  return { db, app, engine }
}

function fakeEngine({ images = [] } = {}) {
  const calls = []
  return {
    calls,
    async listImages() { return images },
    async buildImage(tag, tar, onLine, opts = {}) {
      calls.push(['build', tag, opts])
      onLine('Step 1/1 : FROM alpine')
    },
    async pullImage(ref) { calls.push(['pull', ref]) },
    async removeImage(ref) { calls.push(['removeImage', ref]) },
    async pruneImages() {
      calls.push(['prune'])
      return { ImagesDeleted: [{ Deleted: 'a' }, { Deleted: 'b' }], SpaceReclaimed: 12345 }
    },
  }
}

const create = (app, body) => app.request('/', { method: 'POST', body: JSON.stringify(body) })

test('creates, lists and updates a managed image', async () => {
  const { app } = setup()
  let res = await create(app, { name: 'Bun-Node', containerfile: 'FROM alpine\n' })
  expect(res.status).toBe(201)
  const created = await res.json()
  expect(created.name).toBe('bun-node') // normalized to lowercase

  res = await app.request(`/${created.id}`, { method: 'PATCH', body: JSON.stringify({ containerfile: 'FROM debian\n' }) })
  expect((await res.json()).containerfile).toBe('FROM debian\n')

  res = await app.request('/')
  const list = await res.json()
  expect(list.managed).toHaveLength(1)
  expect(list.managed[0].ref).toBe('localhost/skeppa/bun-node:latest')
  expect(list.managed[0].exists).toBe(false)
  expect(list.default_image).toBe('docker.io/oven/bun:1')
})

test('rejects invalid and duplicate names', async () => {
  const { app } = setup()
  expect((await create(app, { name: 'Not A Slug!' })).status).toBe(400)
  await create(app, { name: 'dup' })
  const res = await create(app, { name: 'dup' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.name).toContain('in use')
})

test('the list annotates engine images: size, dangling, managed, used-by', async () => {
  const engine = fakeEngine({
    images: [
      { Id: 'sha256:aaa', RepoTags: ['localhost/skeppa/bun-node:latest'], Size: 90_000_000, Created: 1 },
      { Id: 'sha256:bbb', RepoTags: ['docker.io/oven/bun:1'], Size: 120_000_000, Created: 2 },
      { Id: 'sha256:ccc', RepoTags: null, Size: 5_000_000, Created: 3 },
    ],
  })
  const { db, app } = setup({ engine })
  db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)').run('bun-node', 'FROM alpine\n')
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, run_image, runtime)
     VALUES ('capp', 'CApp', 'o/r', 'main', 'capp', 'localhost/skeppa/bun-node:latest', 'container')`
  ).run()

  const list = await (await app.request('/')).json()
  expect(list.managed[0].exists).toBe(true)
  expect(list.managed[0].size).toBe(90_000_000)
  expect(list.managed[0].used_by).toEqual(['capp'])
  const dangling = list.local.find(l => l.id === 'sha256:ccc')
  expect(dangling.dangling).toBe(true)
  const managedLocal = list.local.find(l => l.id === 'sha256:aaa')
  expect(managedLocal.managed).toBe(true)
  expect(managedLocal.used_by).toEqual(['capp'])
})

test('an unreachable engine still lists definitions, with engine_error set', async () => {
  const engine = { async listImages() { throw new Error('connect ENOENT') } }
  const { db, app } = setup({ engine })
  db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)').run('bun-node', '')
  const list = await (await app.request('/')).json()
  expect(list.engine_error).toContain('ENOENT')
  expect(list.managed).toHaveLength(1)
  expect(list.managed[0].exists).toBeNull()
})

test('build streams the log and stores the result on the row', async () => {
  const { db, app, engine } = setup()
  const { id } = await (await create(app, { name: 'bun-node', containerfile: 'FROM alpine\n' })).json()

  const res = await app.request(`/${id}/build`, { method: 'POST' })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('Step 1/1 : FROM alpine')
  expect(text).toContain('✔ build finished')
  // Manual builds refresh FROM bases (pull), unlike self-heal rebuilds.
  expect(engine.calls).toEqual([['build', managedRef('bun-node'), { pull: true }]])
  expect(db.query('SELECT last_build_status FROM images WHERE id = ?').get(id).last_build_status).toBe('success')
})

test('pull refreshes a registry image and refuses managed refs', async () => {
  const { app, engine } = setup()
  const pull = ref => app.request('/pull', { method: 'POST', body: JSON.stringify({ ref }) })

  expect((await pull('docker.io/oven/bun:1')).status).toBe(200)
  expect(engine.calls).toEqual([['pull', 'docker.io/oven/bun:1']])

  const managed = await pull('localhost/skeppa/bun-node:latest')
  expect(managed.status).toBe(400)
  expect((await managed.json()).error).toContain('built from their Containerfile')

  expect((await pull('not a ref!')).status).toBe(400)
  expect(engine.calls).toHaveLength(1)
})

test('a failing build streams the error and records the failure', async () => {
  const engine = fakeEngine()
  engine.buildImage = async (tag, tar, onLine) => {
    onLine('Step 1/1 : RUN nope')
    throw new Error('image build failed: exit code: 127')
  }
  const { db, app } = setup({ engine })
  const { id } = await (await create(app, { name: 'broken' })).json()

  const text = await (await app.request(`/${id}/build`, { method: 'POST' })).text()
  expect(text).toContain('✖ build failed')
  expect(db.query('SELECT last_build_status FROM images WHERE id = ?').get(id).last_build_status).toBe('failed')
})

test('delete is refused while a project references the image', async () => {
  const { db, app } = setup()
  const { id } = await (await create(app, { name: 'bun-node' })).json()
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, build_image)
     VALUES ('app', 'App', 'o/r', 'main', 'app', 'localhost/skeppa/bun-node:latest')`
  ).run()

  const res = await app.request(`/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(400)
  expect((await res.json()).error).toContain('app')
  expect(db.query('SELECT COUNT(*) AS n FROM images').get().n).toBe(1)
})

test('delete removes the row and the engine image when unused', async () => {
  const { db, app, engine } = setup()
  const { id } = await (await create(app, { name: 'bun-node' })).json()
  const res = await app.request(`/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(engine.calls).toContainEqual(['removeImage', managedRef('bun-node')])
  expect(db.query('SELECT COUNT(*) AS n FROM images').get().n).toBe(0)
})

test('prune reports what was reclaimed', async () => {
  const { app } = setup()
  const res = await app.request('/prune', { method: 'POST' })
  const body = await res.json()
  expect(body.deleted).toBe(2)
  expect(body.reclaimed).toBe(12345)
})
