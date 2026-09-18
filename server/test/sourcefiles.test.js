import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { readSourcePath, openSourceDownload, parseRelPath, looksBinary, TEXT_MAX } from '../src/lib/sourcefiles.js'

// apps/<slug>/source with a few files, and a secret next to it that nothing
// may ever reach.
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'skeppa-files-'))
  const source = join(root, 'source')
  mkdirSync(join(source, 'docs'), { recursive: true })
  mkdirSync(join(source, '.git'), { recursive: true })
  writeFileSync(join(root, 'master.key'), 'TOP SECRET')
  writeFileSync(join(source, 'README.md'), '# Hello\n')
  writeFileSync(join(source, '.env.example'), 'TOKEN=\n')
  writeFileSync(join(source, '.env'), 'TOKEN=sekret\n')
  writeFileSync(join(source, '.git', 'config'), '[core]\n')
  writeFileSync(join(source, 'docs', 'api.md'), 'api på svenska\n')
  writeFileSync(join(source, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  return { root, source }
}

// Creating symlinks needs a privilege on Windows that dev machines rarely
// have; the server is Linux, where these always run.
function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type)
    return true
  } catch {
    return false
  }
}

const rejects = async (promise, status) => {
  const err = await promise.then(() => null, e => e)
  expect(err?.status).toBe(status)
}

test('paths are whitelist-parsed: no dot segments, backslashes or NULs', () => {
  expect(parseRelPath('')).toEqual([])
  expect(parseRelPath('docs//api.md')).toEqual(['docs', 'api.md'])
  for (const bad of ['..', '../master.key', 'docs/../../master.key', 'docs\\api.md', 'a\0b', './x', 'x'.repeat(2000)]) {
    expect(() => parseRelPath(bad)).toThrow()
  }
})

test('the root lists folders first, hides .git and marks the panel’s .env', async () => {
  const { source } = makeTree()
  const dir = await readSourcePath(source, '')
  expect(dir.type).toBe('dir')
  expect(dir.entries.map(e => e.name)).toEqual(['docs', '.env', '.env.example', 'logo.png', 'README.md'])
  expect(dir.entries.find(e => e.name === '.env').locked).toBe(true)
  expect(dir.entries.find(e => e.name === 'README.md').size).toBe(8)
})

test('a text file comes back as text, a binary one does not', async () => {
  const { source } = makeTree()
  const md = await readSourcePath(source, 'docs/api.md')
  expect(md).toMatchObject({ type: 'file', path: 'docs/api.md', name: 'api.md', binary: false, tooLarge: false, text: 'api på svenska\n' })
  const png = await readSourcePath(source, 'logo.png')
  expect(png).toMatchObject({ type: 'file', binary: true, text: '', size: 8 })
})

test('a large file is download-only, and its cut-off head is not mistaken for binary', async () => {
  const { source } = makeTree()
  writeFileSync(join(source, 'big.txt'), 'å'.repeat(TEXT_MAX)) // two bytes each
  const big = await readSourcePath(source, 'big.txt')
  expect(big).toMatchObject({ tooLarge: true, binary: false, text: '' })
  // an odd cut lands inside a character
  expect(looksBinary(new TextEncoder().encode('åå').subarray(0, 3), false)).toBe(false)
  expect(looksBinary(new TextEncoder().encode('åå').subarray(0, 3), true)).toBe(true)
})

test('.git, the panel’s .env, and anything that is not there are refused', async () => {
  const { source } = makeTree()
  await rejects(readSourcePath(source, '.git'), 404)
  await rejects(readSourcePath(source, '.git/config'), 404)
  await rejects(readSourcePath(source, '.env'), 403)
  await rejects(openSourceDownload(source, '.env'), 403)
  await rejects(readSourcePath(source, 'nope.txt'), 404)
  await rejects(readSourcePath(source, '../master.key'), 400)
  expect((await readSourcePath(source, '.env.example')).text).toBe('TOKEN=\n')
})

test('a project that was never deployed reports missing instead of failing', async () => {
  const { root } = makeTree()
  expect(await readSourcePath(join(root, 'nowhere'), '')).toEqual({ type: 'missing' })
})

test('symlinks are followed inside the tree and nowhere else', async () => {
  const { root, source } = makeTree()
  const ok =
    trySymlink(join(root, 'master.key'), join(source, 'NOTES.md'), 'file') &&
    trySymlink(root, join(source, 'up'), 'dir') &&
    trySymlink(join(source, 'docs', 'api.md'), join(source, 'API.md'), 'file') &&
    trySymlink(join(source, '.env'), join(source, 'settings.txt'), 'file')
  if (!ok) return // no symlink privilege on this machine

  await rejects(readSourcePath(source, 'NOTES.md'), 404)
  await rejects(openSourceDownload(source, 'NOTES.md'), 404)
  await rejects(readSourcePath(source, 'up'), 404)
  await rejects(readSourcePath(source, 'up/master.key'), 404)
  // renaming the panel's .env through a link does not unlock it
  await rejects(readSourcePath(source, 'settings.txt'), 403)

  // an inside link works, and reports where it really lives
  const linked = await readSourcePath(source, 'API.md')
  expect(linked).toMatchObject({ path: 'docs/api.md', text: 'api på svenska\n' })

  const types = Object.fromEntries((await readSourcePath(source, '')).entries.map(e => [e.name, e.type]))
  expect(types['API.md']).toBe('file')
  expect(types['NOTES.md']).toBe('other')
  expect(types.up).toBe('other')
})

test('a download streams the exact bytes', async () => {
  const { source } = makeTree()
  const { name, size, stream } = await openSourceDownload(source, 'logo.png')
  expect(name).toBe('logo.png')
  expect(size).toBe(8)
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
  await rejects(openSourceDownload(source, 'docs'), 400) // a directory
})

// --- routes ------------------------------------------------------------------

function setupRoutes() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('eve', 'x', 'tenant', 'eve')").run()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command)
            VALUES ('bobapp', 'BobApp', 2, 'bob/app', 'main', 'bobapp', 'container', 'bun start')`).run()
  const appsDir = mkdtempSync(join(tmpdir(), 'skeppa-fileroutes-'))
  const source = join(appsDir, 'bobapp', 'source')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'README.md'), '# Bob\n')
  writeFileSync(join(source, 'page.html'), '<script>alert(1)</script>')
  const routes = projectRoutes({ db, config: { appsDir, masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa' }, liveState: createLiveState() })
  const as = id => {
    const app = new Hono()
    app.use('*', (c, next) => {
      c.set('user', db.query('SELECT * FROM users WHERE id = ?').get(id))
      return next()
    })
    app.route('/', routes)
    return app
  }
  return { as }
}

test('the files route serves the owner and the admin, and 404s everyone else', async () => {
  const { as } = setupRoutes()
  for (const id of [1, 2]) {
    const res = await as(id).request('/1/files?path=README.md')
    expect(res.status).toBe(200)
    expect((await res.json()).text).toBe('# Bob\n')
  }
  expect((await as(3).request('/1/files')).status).toBe(404)
  expect((await as(3).request('/1/files/raw?path=README.md')).status).toBe(404)
  expect((await as(2).request('/1/files?path=../x')).status).toBe(400)
})

test('a download is always an attachment, never a page on the panel’s origin', async () => {
  const { as } = setupRoutes()
  const res = await as(2).request('/1/files/raw?path=page.html')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/octet-stream')
  expect(res.headers.get('content-disposition')).toStartWith('attachment; filename="page.html"')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('content-security-policy')).toBe('sandbox')
  expect(await res.text()).toBe('<script>alert(1)</script>')
})

test('there is no way to write through the files routes', async () => {
  const { as } = setupRoutes()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await as(1).request('/1/files?path=README.md', { method, body: 'x' })
    expect(res.status).toBe(404)
  }
})
