import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import {
  managedRef, managedNameFromRef, buildManagedImage,
  materializeImage, createContainerEnsuringImage,
} from '../src/containers/images.js'

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))

function setup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  const addImage = (name, containerfile = 'FROM alpine\n') => {
    const { lastInsertRowid } = db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)')
      .run(name, containerfile)
    return db.query('SELECT * FROM images WHERE id = ?').get(Number(lastInsertRowid))
  }
  return { db, addImage }
}

test('managed refs round-trip; registry refs are not managed', () => {
  expect(managedRef('bun-node')).toBe('localhost/skeppa/bun-node:latest')
  expect(managedNameFromRef('localhost/skeppa/bun-node:latest')).toBe('bun-node')
  expect(managedNameFromRef('docker.io/oven/bun:1')).toBeNull()
  expect(managedNameFromRef('localhost/other/x:latest')).toBeNull()
})

test('buildManagedImage records a successful build on the row', async () => {
  const { db, addImage } = setup()
  const image = addImage('bun-node')
  const engine = {
    async buildImage(tag, tar, onLine) {
      expect(tag).toBe('localhost/skeppa/bun-node:latest')
      expect(tar.length % 512).toBe(0) // a real tar context
      onLine('Step 1/1 : FROM alpine')
    },
  }
  const lines = []
  await buildManagedImage({ db, engine, image, onLine: l => lines.push(l) })
  const row = db.query('SELECT * FROM images WHERE id = ?').get(image.id)
  expect(row.last_build_status).toBe('success')
  expect(row.last_build_log).toContain('Step 1/1')
  expect(row.last_built_at).toBeTruthy()
  expect(lines).toEqual(['Step 1/1 : FROM alpine'])
})

test('buildManagedImage records a failure and rethrows', async () => {
  const { db, addImage } = setup()
  const image = addImage('broken')
  const engine = {
    async buildImage() {
      throw new Error('image build failed: exit code: 127')
    },
  }
  await expect(buildManagedImage({ db, engine, image })).rejects.toThrow('127')
  const row = db.query('SELECT * FROM images WHERE id = ?').get(image.id)
  expect(row.last_build_status).toBe('failed')
  expect(row.last_build_log).toContain('127')
})

test('materializeImage builds managed refs from the DB and pulls everything else', async () => {
  const { db, addImage } = setup()
  addImage('bun-node')
  const calls = []
  const engine = {
    async buildImage(tag) { calls.push(['build', tag]) },
    async pullImage(ref) { calls.push(['pull', ref]) },
  }
  await materializeImage({ engine, db, image: 'localhost/skeppa/bun-node:latest' })
  await materializeImage({ engine, db, image: 'docker.io/oven/bun:1' })
  expect(calls).toEqual([
    ['build', 'localhost/skeppa/bun-node:latest'],
    ['pull', 'docker.io/oven/bun:1'],
  ])
})

test('a managed-looking ref without a Shipyard row is a clear error, not a pull', async () => {
  const { db } = setup()
  const engine = { async pullImage() { throw new Error('should not pull') } }
  await expect(materializeImage({ engine, db, image: 'localhost/skeppa/ghost:latest' }))
    .rejects.toThrow(/not defined in the Shipyard/)
})

test('createContainerEnsuringImage retries the create after materializing', async () => {
  const { db, addImage } = setup()
  addImage('bun-node')
  const calls = []
  let creates = 0
  const engine = {
    async createContainer(name, spec) {
      calls.push(['create', spec.Image])
      if (++creates === 1) throw Object.assign(new Error('no such image'), { status: 404 })
      return 'cid'
    },
    async buildImage(tag) { calls.push(['build', tag]) },
  }
  const id = await createContainerEnsuringImage({
    engine, db, name: 'x',
    spec: { Image: 'localhost/skeppa/bun-node:latest' },
  })
  expect(id).toBe('cid')
  expect(calls.map(c => c[0])).toEqual(['create', 'build', 'create'])
})
