import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, setSecretSetting } from '../src/db/settings.js'
import { GitHubApp, MAX_BRANCH_PAGES } from '../src/github/appClient.js'
import { githubRoutes } from '../src/routes/github.js'

// The branch select's list: a repository's branches by name and its
// default, every page of them up to a limit — and, like the suggestions,
// only of a tenant's own installation's repos.

const MASTER_KEY = 'a'.repeat(64)
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

// bob/site has `count` branches: main, then b0001, b0002, … in pages of 100.
function setup({ count = 3 } = {}) {
  const calls = []
  const all = ['main', ...Array.from({ length: count - 1 }, (_, i) => `b${String(i + 1).padStart(4, '0')}`)].reverse()
  const fetchFn = async url => {
    const path = url.replace('https://api.github.com', '')
    calls.push(path)
    if (path === '/repos/bob/site/installation') return json({ id: 7, account: { login: 'bob' } })
    if (path === '/repos/eve/secret/installation') return json({ id: 8, account: { login: 'eve' } })
    if (path.endsWith('/access_tokens')) return json({ token: 't', expires_at: new Date(Date.now() + 3600e3).toISOString() })
    if (path === '/repos/bob/site') return json({ full_name: 'bob/site', default_branch: 'main' })
    if (path.startsWith('/repos/bob/site/branches?')) {
      const q = new URL(`https://x${path}`).searchParams
      expect(q.get('per_page')).toBe('100')
      const page = Number(q.get('page'))
      return json(all.slice((page - 1) * 100, page * 100).map(name => ({ name, commit: { sha: 'x' }, protected: false })))
    }
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

test('the branches by name, and which is the default', async () => {
  const { github } = setup()
  expect(await github.listBranches('bob/site')).toEqual({ default_branch: 'main', branches: ['b0001', 'b0002', 'main'], more: false })
})

test('every page, up to the limit — past it the list says it was cut', async () => {
  const many = setup({ count: 250 })
  const got = await many.github.listBranches('bob/site')
  expect(got.branches.length).toBe(250)
  expect(got.more).toBe(false)
  expect(many.calls.filter(p => p.includes('/branches?')).length).toBe(3)

  const huge = setup({ count: MAX_BRANCH_PAGES * 100 + 5 })
  const cut = await huge.github.listBranches('bob/site')
  expect(cut.branches.length).toBe(MAX_BRANCH_PAGES * 100)
  expect(cut.more).toBe(true)
  expect(huge.calls.filter(p => p.includes('/branches?')).length).toBe(MAX_BRANCH_PAGES)
})

test('a tenant lists only their own installation\'s repos — anything else is a 404', async () => {
  const { as } = setup()
  const bob = as({ id: 2, role: 'tenant', github_login: 'Bob' })
  const mine = await bob.request('/repos/branches?repo=bob/site')
  expect(mine.status).toBe(200)
  expect((await mine.json()).default_branch).toBe('main')
  expect((await bob.request('/repos/branches?repo=eve/secret')).status).toBe(404)
  expect((await as({ id: 3, role: 'tenant', github_login: '' }).request('/repos/branches?repo=bob/site')).status).toBe(404)
  expect((await as({ id: 1, role: 'admin' }).request('/repos/branches?repo=bob/site')).status).toBe(200)
})

test('the repository is checked before GitHub is asked', async () => {
  const { as, calls } = setup()
  const admin = as({ id: 1, role: 'admin' })
  for (const q of ['repo=../etc', 'repo=bob/site/../x', 'repo=', '']) {
    expect((await admin.request(`/repos/branches?${q}`)).status).toBe(400)
  }
  expect(calls).toEqual([])
})
