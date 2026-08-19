import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, initLiveState } from '../src/live/state.js'
import { syncImages, syncManagedImages } from '../src/live/images.js'

function makeDb() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  return db
}

const fakeEngine = images => ({ async listImages() { return images } })

test('initLiveState carries the image definitions and the default image', () => {
  const db = makeDb()
  db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)').run('bun-node', 'FROM alpine\n')

  const liveState = createLiveState()
  initLiveState(liveState, db, { buildImage: 'docker.io/oven/bun:1' })

  expect(liveState.images.defaultImage).toBe('docker.io/oven/bun:1')
  expect(liveState.images.managed).toHaveLength(1)
  const managed = liveState.images.managed[0]
  expect(managed.name).toBe('bun-node')
  expect(managed.ref).toBe('localhost/skeppa/bun-node:latest')
  expect(managed.containerfile).toBe('FROM alpine\n')
  expect(managed.used_by).toEqual([])
  // The engine half needs the poller — boot must not wait on the socket.
  expect(liveState.images.local).toEqual([])
  expect(liveState.images.storeListed).toBe(false)
})

test('syncImages publishes the engine store next to the definitions', async () => {
  const db = makeDb()
  db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)').run('bun-node', '')
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, run_image, runtime)
     VALUES ('capp', 'CApp', 'o/r', 'main', 'capp', 'localhost/skeppa/bun-node:latest', 'container')`
  ).run()

  const liveState = createLiveState()
  initLiveState(liveState, db, {})
  await syncImages(db, liveState, fakeEngine([
    { Id: 'sha256:aaa', RepoTags: ['localhost/skeppa/bun-node:latest'], Size: 90_000_000 },
    { Id: 'sha256:ccc', RepoTags: null, Size: 5_000_000 },
  ]))

  expect(liveState.images.storeListed).toBe(true)
  expect(liveState.images.engineError).toBe('')
  expect(liveState.images.managed[0].used_by).toEqual(['capp'])
  const built = liveState.images.local.find(l => l.id === 'sha256:aaa')
  expect(built.size).toBe(90_000_000)
  expect(built.managed).toBe(true)
  expect(built.used_by).toEqual(['capp'])
  expect(liveState.images.local.find(l => l.id === 'sha256:ccc').dangling).toBe(true)
})

// The client tells "not built" from "engine unreachable" by this flag alone:
// a lazy-watch diff cannot carry a null inside an array, so the definitions
// deliberately hold no exists/size of their own.
test('an unreachable engine clears the store listing and records the error', async () => {
  const db = makeDb()
  db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)').run('bun-node', '')
  const liveState = createLiveState()
  initLiveState(liveState, db, {})

  await syncImages(db, liveState, fakeEngine([
    { Id: 'sha256:aaa', RepoTags: ['localhost/skeppa/bun-node:latest'], Size: 1 },
  ]))
  expect(liveState.images.storeListed).toBe(true)

  await syncImages(db, liveState, { async listImages() { throw new Error('connect ENOENT') } })
  expect(liveState.images.engineError).toContain('ENOENT')
  expect(liveState.images.storeListed).toBe(false)
  expect(liveState.images.local).toEqual([])
  expect(liveState.images.managed).toHaveLength(1) // definitions survive

  await syncImages(db, liveState, null) // no socket configured at all
  expect(liveState.images.engineError).toContain('no container engine socket')
})

// A project edit changes used_by without touching the engine, so this half
// must refresh on its own — without a listing call.
test('syncManagedImages refreshes used_by without touching the engine', async () => {
  const db = makeDb()
  db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)').run('bun-node', '')
  const liveState = createLiveState()
  initLiveState(liveState, db, {})
  await syncImages(db, liveState, fakeEngine([
    { Id: 'sha256:aaa', RepoTags: ['localhost/skeppa/bun-node:latest'], Size: 90_000_000 },
  ]))

  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, build_image)
     VALUES ('app', 'App', 'o/r', 'main', 'app', 'localhost/skeppa/bun-node:latest')`
  ).run()
  syncManagedImages(db, liveState)

  expect(liveState.images.managed[0].used_by).toEqual(['app'])
  expect(liveState.images.local).toHaveLength(1) // the listing is left alone
  expect(liveState.images.storeListed).toBe(true)
})
