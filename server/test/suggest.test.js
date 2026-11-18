import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, setSecretSetting } from '../src/db/settings.js'
import { GitHubApp } from '../src/github/appClient.js'
import { githubRoutes } from '../src/routes/github.js'
import { suggestSetup } from '../src/lib/suggest.js'

// The mooring form's suggestions, read from the repository's root: what
// package.json says, as bun commands (the default build image has only bun).

test('a build and a start script: build, then start', () => {
  const s = suggestSetup({ files: ['package.json', 'bun.lock'], packageJson: { scripts: { build: 'vite build', start: 'node server.js' } } })
  expect(s).toEqual({ found: true, deploy: 'bun install && bun run build', start: 'bun run start', notes: ['bun.lock', 'a build script', 'a start script'] })
})

test('another lockfile is named, and bun install still reads it', () => {
  const s = suggestSetup({ files: ['package.json', 'pnpm-lock.yaml'], packageJson: { scripts: { start: 'x' } } })
  expect(s.deploy).toBe('bun install')
  expect(s.notes[0]).toBe('pnpm-lock.yaml — bun install reads it')
})

test('built by a site builder and never started: a static site, publishing where it builds to', () => {
  expect(suggestSetup({ files: ['package.json'], packageJson: { scripts: { build: 'vite build' }, devDependencies: { vite: '6' } } }))
    .toEqual({ found: true, deploy: 'bun install && bun run build', start: '', runtime: 'static', publish_dir: 'dist', notes: ['a build script', 'no start script', 'Vite'] })
  expect(suggestSetup({ packageJson: { scripts: { build: 'react-scripts build' }, dependencies: { 'react-scripts': '5' } } }).publish_dir).toBe('build')
  // with a start script it is an app that happens to use Vite
  expect(suggestSetup({ packageJson: { scripts: { build: 'b', start: 's' }, devDependencies: { vite: '6' } } }).runtime).toBeUndefined()
})

test('no package.json: nothing to suggest, and why', () => {
  expect(suggestSetup({ files: ['Dockerfile', 'README.md'] })).toEqual({
    found: false, deploy: '', start: '', notes: ['no package.json at the root', 'a Dockerfile, which the panel does not build'],
  })
})

// --- reading the root, and who may ask -------------------------------------

const MASTER_KEY = 'a'.repeat(64)
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

function setup({ pkg = '{"scripts":{"build":"vite build"},"devDependencies":{"vite":"6"}}' } = {}) {
  const calls = []
  const fetchFn = async url => {
    const path = url.replace('https://api.github.com', '')
    calls.push(path)
    if (path === '/repos/bob/site/installation') return json({ id: 7, account: { login: 'bob' } })
    if (path === '/repos/eve/secret/installation') return json({ id: 8, account: { login: 'eve' } })
    if (path.endsWith('/access_tokens')) return json({ token: 't', expires_at: new Date(Date.now() + 3600e3).toISOString() })
    if (path === '/repos/bob/site/contents?ref=main') return json([{ type: 'file', name: 'package.json' }, { type: 'dir', name: 'src' }])
    if (path === '/repos/bob/site/contents/package.json?ref=main') return json({ encoding: 'base64', content: Buffer.from(pkg).toString('base64') })
    throw new Error(`unexpected path: ${path}`)
  }
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  setSetting(db, 'github_app_id', '1234')
  setSecretSetting(db, MASTER_KEY, 'github_private_key', PEM)
  const github = new GitHubApp({ db, config: { masterKey: MASTER_KEY }, fetchFn })
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => (c.set('user', user), next()))
    app.route('/', githubRoutes({ db, config: { masterKey: MASTER_KEY }, github }))
    return app
  }
  return { calls, as, github }
}

test('the root is read: file names, and package.json decoded', async () => {
  const { github } = setup()
  expect(await github.readRepoRoot('bob/site', 'main')).toEqual({
    files: ['package.json'],
    packageJson: { scripts: { build: 'vite build' }, devDependencies: { vite: '6' } },
  })
  const broken = setup({ pkg: '{ not json' })
  expect((await broken.github.readRepoRoot('bob/site', 'main')).packageJson).toBeNull()
})

test('a tenant asks only about their own installation\'s repos — anything else is a 404', async () => {
  const { as } = setup()
  const bob = as({ id: 2, role: 'tenant', github_login: 'Bob' })
  const mine = await bob.request('/repos/suggest?repo=bob/site&branch=main')
  expect(mine.status).toBe(200)
  expect((await mine.json()).runtime).toBe('static')
  expect((await bob.request('/repos/suggest?repo=eve/secret&branch=main')).status).toBe(404)
  expect((await as({ id: 3, role: 'tenant', github_login: '' }).request('/repos/suggest?repo=bob/site')).status).toBe(404)
})

test('the repository and branch are checked before GitHub is asked', async () => {
  const { as, calls } = setup()
  const admin = as({ id: 1, role: 'admin' })
  for (const q of ['repo=../etc', 'repo=bob/site&branch=a..b', 'repo=']) {
    expect((await admin.request(`/repos/suggest?${q}`)).status).toBe(400)
  }
  expect(calls).toEqual([])
})
