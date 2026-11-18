import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { generateKeyPairSync, createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, setSecretSetting } from '../src/db/settings.js'
import { GitHubApp, REPOS_FRESH_MS } from '../src/github/appClient.js'
import { createLiveState } from '../src/live/state.js'
import { webhookRoutes } from '../src/routes/webhooks.js'

// The repo listing's cache: per installation, answered at once even when
// old (and refreshed behind the answer), skipped on Refresh, kept honest by
// webhooks — and a cold fetch asks for every page at once.

const MASTER_KEY = 'a'.repeat(64)
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const tick = () => new Promise(r => setTimeout(r, 0))

// Installation 11 (rasmus) holds `count.own` repos, 22 (friend) one. The
// listing's names carry a generation, so a refetch is visible.
function fakeGitHub({ own = 1 } = {}) {
  const calls = []
  const state = { generation: 1, own }
  const fetchFn = async (url, init) => {
    const path = url.replace('https://api.github.com', '')
    calls.push(path)
    if (path === '/app/installations') return json([{ id: 11, account: { login: 'rasmus' } }, { id: 22, account: { login: 'friend' } }])
    if (path.endsWith('/access_tokens')) return json({ token: path.includes('/11/') ? 'tok-11' : 'tok-22', expires_at: FUTURE })
    if (path.startsWith('/installation/repositories')) {
      const page = Number(new URL(`https://x${path}`).searchParams.get('page'))
      if (init.headers.authorization === 'token tok-22') {
        return json({ total_count: 1, repositories: page === 1 ? [{ full_name: 'friend/secret', name: 'secret', owner: { login: 'friend' } }] : [] })
      }
      const all = Array.from({ length: state.own }, (_, i) => ({
        full_name: `rasmus/r${i}-g${state.generation}`, name: `r${i}-g${state.generation}`, owner: { login: 'rasmus' }, pushed_at: '2026-01-01T00:00:00Z',
      }))
      return json({ total_count: all.length, repositories: all.slice((page - 1) * 100, page * 100) })
    }
    throw new Error(`unexpected path: ${path}`)
  }
  return { calls, fetchFn, state }
}

function makeApp(fetchFn) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  setSetting(db, 'github_app_id', '1234')
  setSecretSetting(db, MASTER_KEY, 'github_private_key', PEM)
  return new GitHubApp({ db, config: { masterKey: MASTER_KEY }, fetchFn })
}
const listings = calls => calls.filter(p => p.startsWith('/installation/repositories')).length
const names = repos => repos.map(r => r.full_name).sort()

test('a second listing comes from the cache, and a tenant shares the admin\'s copy', async () => {
  const { calls, fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  const all = await app.listRepos()
  expect(names(all)).toEqual(['friend/secret', 'rasmus/r0-g1'])
  const before = calls.length
  expect(names(await app.listRepos())).toEqual(names(all))
  expect(names(await app.listRepos('Friend'))).toEqual(['friend/secret'])
  expect(calls.length).toBe(before) // not one request more
})

test('every page of a big installation is asked for, the rest at once after the first', async () => {
  const { calls, fetchFn } = fakeGitHub({ own: 250 })
  const app = makeApp(fetchFn)
  const repos = await app.listRepos('rasmus')
  expect(repos.length).toBe(250)
  expect(calls.filter(p => p.startsWith('/installation/repositories')).map(p => p.split('&page=')[1]).sort()).toEqual(['1', '2', '3'])
})

test('callers asking at the same moment share one fetch', async () => {
  const { calls, fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  await Promise.all([app.listRepos(), app.listRepos(), app.listRepos('rasmus')])
  expect(listings(calls)).toBe(2) // one per installation
})

test('an old listing is answered at once, and refreshed behind the answer', async () => {
  const { calls, fetchFn, state } = fakeGitHub()
  const app = makeApp(fetchFn)
  await app.listRepos('rasmus')
  app._repos.get(11).at -= REPOS_FRESH_MS // ten minutes on
  state.generation = 2
  expect(names(await app.listRepos('rasmus'))).toEqual(['rasmus/r0-g1']) // the old one, without waiting
  for (let i = 0; i < 5; i++) await tick()
  expect(names(await app.listRepos('rasmus'))).toEqual(['rasmus/r0-g2'])
  expect(listings(calls)).toBe(2)
})

test('a failed refresh keeps the old listing, and tries again next time', async () => {
  const { fetchFn, state } = fakeGitHub()
  let failing = false
  const app = makeApp(async (url, init) => {
    if (failing && url.includes('/installation/repositories')) throw new Error('GitHub is down')
    return fetchFn(url, init)
  })
  await app.listRepos('rasmus')
  app._repos.get(11).at -= REPOS_FRESH_MS
  failing = true
  const errors = []
  const log = console.error
  console.error = m => errors.push(m)
  try {
    expect(names(await app.listRepos('rasmus'))).toEqual(['rasmus/r0-g1'])
    for (let i = 0; i < 5; i++) await tick()
  } finally {
    console.error = log
  }
  expect(errors.some(e => e.includes('GitHub is down'))).toBe(true)
  failing = false
  state.generation = 2
  await app.listRepos('rasmus') // still old: this call starts the retry
  for (let i = 0; i < 5; i++) await tick()
  expect(names(await app.listRepos('rasmus'))).toEqual(['rasmus/r0-g2'])
})

test('Refresh goes past the cache', async () => {
  const { fetchFn, state } = fakeGitHub()
  const app = makeApp(fetchFn)
  await app.listRepos('rasmus')
  state.generation = 2
  expect(names(await app.listRepos('rasmus', { fresh: true }))).toEqual(['rasmus/r0-g2'])
})

test('forgetting one installation refetches it alone; a push moves a cached last push', async () => {
  const { calls, fetchFn, state } = fakeGitHub()
  const app = makeApp(fetchFn)
  await app.listRepos()
  state.generation = 2
  app.forgetRepos(11)
  const before = listings(calls)
  expect(names(await app.listRepos())).toEqual(['friend/secret', 'rasmus/r0-g2'])
  expect(listings(calls)).toBe(before + 1)

  app.notePush('rasmus/r0-g2', '2026-11-18T12:00:00.000Z')
  expect((await app.listRepos('rasmus'))[0].pushed_at).toBe('2026-11-18T12:00:00.000Z')
})

test('the listing tells which installation covers a repo, so resolving it needs no request', async () => {
  const { calls, fetchFn } = fakeGitHub()
  const app = makeApp(fetchFn)
  await app.listRepos()
  const before = calls.length
  expect(await app.getRepoInstallation('friend/secret')).toEqual({ id: 22, account: 'friend' })
  expect(calls.length).toBe(before)
})

// The webhook half: installation changes forget, pushes move the last push.
test('webhooks keep the cache honest', async () => {
  const SECRET = 's'
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  setSecretSetting(db, MASTER_KEY, 'github_webhook_secret', SECRET)
  const seen = []
  const github = { forgetRepos: id => seen.push(['forget', id]), notePush: (repo, at) => seen.push(['push', repo, at]) }
  const app = webhookRoutes({ db, config: { masterKey: MASTER_KEY }, runner: { enqueue() {} }, liveState: createLiveState(), github })
  const send = (event, payload) => {
    const raw = JSON.stringify(payload)
    return app.request('/github', {
      method: 'POST', body: raw,
      headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'), 'x-github-event': event },
    })
  }
  expect((await send('installation_repositories', { action: 'added', installation: { id: 11 } })).status).toBe(200)
  expect((await send('installation', { action: 'deleted', installation: { id: 22 } })).status).toBe(200)
  await send('push', { ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { full_name: 'rasmus/x' }, head_commit: { message: 'm', timestamp: '2026-11-18T13:00:00+01:00' } })
  expect(seen).toEqual([['forget', 11], ['forget', 22], ['push', 'rasmus/x', '2026-11-18T12:00:00.000Z']])
})
