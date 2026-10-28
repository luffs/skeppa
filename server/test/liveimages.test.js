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

// A floating tag says nothing about which image it currently points at. These
// three facts ride along in the listing the poller already makes, so the
// Shipyard can name the copy without a second call per image.
test('carries the image own identity: digest, build date and version label', async () => {
  const db = makeDb()
  const liveState = createLiveState()
  initLiveState(liveState, db, {})

  await syncImages(db, liveState, fakeEngine([
    {
      Id: 'sha256:aaa',
      RepoTags: ['docker.io/oven/bun:1'],
      RepoDigests: ['docker.io/oven/bun@sha256:dddeeefff'],
      Labels: { 'org.opencontainers.image.version': '1.4.4', other: 'x' },
      Created: 1_700_000_000,
      Size: 1,
    },
    // Built here from a Containerfile: no registry digest, no labels at all.
    { Id: 'sha256:bbb', RepoTags: ['localhost/skeppa/bun-node:latest'], Labels: null, Size: 2 },
  ]))

  const pulled = liveState.images.local.find(l => l.id === 'sha256:aaa')
  expect(pulled.digest).toBe('sha256:dddeeefff')
  expect(pulled.version).toBe('1.4.4')
  expect(pulled.createdAt).toBe(1_700_000_000_000)

  // Unknown is '' for the strings — a null would reach the stores as a
  // deletion, which the client cannot tell from a key that never arrived.
  const built = liveState.images.local.find(l => l.id === 'sha256:bbb')
  expect(built.digest).toBe('')
  expect(built.version).toBe('')
  // And the number simply vanishes: assigning null to the proxy is a deletion,
  // which is the sanctioned way to say "unknown" for a number — `img.createdAt`
  // is falsy either way at the other end.
  expect(built.createdAt).toBeUndefined()
})

// The panel's default build image is the one nearly every project actually
// uses, and almost none of them name it — an empty field is not "no image".
// Counting only the explicit ones left the busiest image in the store listed
// as used by nobody, with nothing in the way of deleting it.
test('used_by counts the projects that inherit the default image', async () => {
  const db = makeDb()
  const add = (slug, cols) => {
    const keys = Object.keys(cols)
    db.query(
      `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name${keys.map(k => ', ' + k).join('')})
       VALUES (?, ?, 'o/r', 'main', ?${keys.map(() => ', ?').join('')})`
    ).run(slug, slug, slug, ...keys.map(k => cols[k]))
  }
  // Names nothing: builds in the default, and runs it too (resolveRunImage
  // falls through run_image and build_image to the same value).
  add('inherits', { runtime: 'container' })
  // A host process still builds in the default — the sandbox is panel-wide.
  add('pm2-app', { runtime: 'pm2' })
  // Runs something else, but still builds in the default.
  add('other-run', { runtime: 'container', run_image: 'docker.io/library/node:22' })
  // Named the default explicitly: counted once, not twice.
  add('explicit', { runtime: 'pm2', build_image: 'docker.io/oven/bun:1' })
  // Builds elsewhere, so the default is nothing to it.
  add('elsewhere', { runtime: 'pm2', build_image: 'docker.io/library/node:22' })
  // A run_image left behind by a switch back to pm2 is not a use: nothing
  // will ever run it, and counting it would block the image's delete.
  add('switched', { runtime: 'pm2', build_image: 'docker.io/library/node:22', run_image: 'docker.io/oven/bun:1' })

  const liveState = createLiveState()
  initLiveState(liveState, db, { buildImage: 'docker.io/oven/bun:1' })
  await syncImages(db, liveState, fakeEngine([
    { Id: 'sha256:aaa', RepoTags: ['docker.io/oven/bun:1'], Size: 1 },
    { Id: 'sha256:bbb', RepoTags: ['docker.io/library/node:22'], Size: 1 },
  ]))

  const byTag = ref => liveState.images.local.find(l => l.tags.includes(ref)).used_by
  expect(byTag('docker.io/oven/bun:1')).toEqual(['explicit', 'inherits', 'other-run', 'pm2-app'])
  expect(byTag('docker.io/library/node:22')).toEqual(['elsewhere', 'other-run', 'switched'])
})

// Without a default configured, an empty field resolves to nothing at all —
// and must not therefore match every image in the store.
test('an empty default image matches nothing', async () => {
  const db = makeDb()
  db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, runtime)
     VALUES ('bare', 'Bare', 'o/r', 'main', 'bare', 'container')`
  ).run()
  const liveState = createLiveState()
  initLiveState(liveState, db, {}) // no BUILD_IMAGE
  await syncImages(db, liveState, fakeEngine([
    { Id: 'sha256:aaa', RepoTags: ['docker.io/oven/bun:1'], Size: 1 },
  ]))
  expect(liveState.images.local[0].used_by).toEqual([])
})
