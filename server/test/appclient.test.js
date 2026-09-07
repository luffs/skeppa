import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, setSecretSetting } from '../src/db/settings.js'
import { GitHubApp } from '../src/github/appClient.js'

const MASTER_KEY = 'a'.repeat(64)
// A real key so the JWT signing path runs for real; 1024 bits keeps it fast.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Two installations: the panel owner's (11) and a friend's (22) — the shape
// GitHub serves once the app is public and someone else installs it.
function fakeGitHub() {
  const calls = []
  const fetchFn = async (url, init) => {
    const path = url.replace('https://api.github.com', '')
    calls.push({ path, method: init.method ?? 'GET', auth: init.headers.authorization })
    if (path === '/app/installations') {
      return json([{ id: 11, account: { login: 'rasmus' } }, { id: 22, account: { login: 'friend' } }])
    }
    if (path === '/repos/rasmus/mine/installation') return json({ id: 11 })
    if (path === '/repos/friend/secret/installation') return json({ id: 22 })
    if (path === '/repos/ghost/gone/installation') return json({ message: 'Not Found' }, 404)
    if (path === '/app/installations/11/access_tokens') return json({ token: 'tok-11', expires_at: FUTURE })
    if (path === '/app/installations/22/access_tokens') return json({ token: 'tok-22', expires_at: FUTURE })
    if (path.startsWith('/installation/repositories')) {
      const own = init.headers.authorization === 'token tok-11'
      const repo = own
        ? { full_name: 'rasmus/mine', private: true, default_branch: 'main', pushed_at: FUTURE }
        : { full_name: 'friend/secret', private: true, default_branch: 'main', pushed_at: FUTURE }
      return json({ total_count: 1, repositories: [repo] })
    }
    if (path === '/repos/friend/secret/branches/main') {
      return json({ commit: { sha: 'c'.repeat(40), commit: { message: 'fix', committer: { date: FUTURE } } } })
    }
    throw new Error(`unexpected path: ${path}`)
  }
  return { calls, fetchFn }
}

function makeApp(fetchFn) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  setSetting(db, 'github_app_id', '1234')
  setSecretSetting(db, MASTER_KEY, 'github_private_key', PEM)
  return new GitHubApp({ db, config: { masterKey: MASTER_KEY }, fetchFn })
}

test('tokens are minted per installation and cached per installation', async () => {
  const { calls, fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)

  expect(await app.getInstallationToken('rasmus/mine')).toBe('tok-11')
  expect(await app.getInstallationToken('friend/secret')).toBe('tok-22')
  // both again — resolution and tokens must come from cache, no new mints
  expect(await app.getInstallationToken('rasmus/mine')).toBe('tok-11')
  expect(await app.getInstallationToken('friend/secret')).toBe('tok-22')

  const mints = calls.filter(c => c.path.endsWith('/access_tokens'))
  expect(mints.length).toBe(2)
  const resolutions = calls.filter(c => c.path.endsWith('/installation'))
  expect(resolutions.length).toBe(2)
})

test('getBranchHead authenticates with the token of the installation covering the repo', async () => {
  const { calls, fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  const head = await app.getBranchHead('friend/secret', 'main')
  expect(head.sha).toBe('c'.repeat(40))
  const branchCall = calls.find(c => c.path === '/repos/friend/secret/branches/main')
  expect(branchCall.auth).toBe('token tok-22')
})

test('listRepos merges every installation, so friend-installed repos appear in the picker', async () => {
  const { fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  const repos = await app.listRepos()
  expect(repos.map(r => r.full_name).sort()).toEqual(['friend/secret', 'rasmus/mine'])
})

test('a repo no installation covers gets the friendly error, naming the repo', async () => {
  const { fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  await expect(app.getInstallationToken('ghost/gone')).rejects.toThrow(/not installed on ghost\/gone/)
})

test('the no-repo form still resolves the first installation (panel-owner concerns)', async () => {
  const { fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  expect(await app.getInstallationToken()).toBe('tok-11')
})
