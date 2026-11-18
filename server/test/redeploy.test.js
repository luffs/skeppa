import { test, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../src/db/migrate.js'
import { syncRepo } from '../src/deploy/git.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'

// Redeploy: back to a commit that deployed fine once. The git half against a
// real repository, a force-pushed-away commit included; the route half
// checks the commit is one this project actually deployed.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
let tmp, origin, first, second

const git = (args, cwd) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`)
  return r.stdout.toString().trim()
}
const commit = (text, message) => {
  writeFileSync(join(origin, 'app.txt'), text)
  git(['add', '.'], origin)
  git(['commit', '-m', message], origin)
  return git(['rev-parse', 'HEAD'], origin)
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skeppa-redeploy-'))
  origin = join(tmp, 'origin')
  git(['init', '-b', 'main', origin])
  // a commit force-pushed off the branch is still fetchable by id — GitHub
  // allows that; a local repository has to be told
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], origin)
  first = commit('v1\n', 'first')
  second = commit('v2\n', 'second')
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

test('a pinned sync checks out the earlier commit, not the branch head', async () => {
  const dir = join(mkdtempSync(join(tmp, 'w-')), 'source')
  const head = await syncRepo({ dir, gitUrl: origin, branch: 'main', sha: first })
  expect(head).toEqual({ sha: first, message: 'first' })
  expect(readFileSync(join(dir, 'app.txt'), 'utf8').trim()).toBe('v1') // autocrlf may add a \r
  // and the next ordinary sync goes back to the head
  expect((await syncRepo({ dir, gitUrl: origin, branch: 'main' })).sha).toBe(second)
})

test('a commit no longer on the branch is fetched by its id', async () => {
  const dir = join(mkdtempSync(join(tmp, 'w-')), 'source')
  await syncRepo({ dir, gitUrl: origin, branch: 'main' }) // a checkout with `second` in it
  const lost = commit('v3\n', 'third, then force-pushed away')
  git(['reset', '--hard', second], origin)
  const lines = []
  const head = await syncRepo({ dir, gitUrl: origin, branch: 'main', sha: lost, onLine: l => lines.push(l) })
  expect(head.sha).toBe(lost)
  expect(lines.some(l => l.includes('no longer on main'))).toBe(true)
})

test('anything but a full commit id is refused before git runs', async () => {
  await expect(syncRepo({ dir: join(tmp, 'never'), gitUrl: origin, branch: 'main', sha: 'HEAD~1' })).rejects.toThrow('not a commit id')
})

function routeSetup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime)
     VALUES ('app', 'App', 1, '', 'https://example.com/app.git', 'main', 'app', 'container')`
  ).run()
  const projectId = Number(lastInsertRowid)
  const deployed = (sha, status) => db.query(
    `INSERT INTO deployments (project_id, status, "trigger", commit_sha, commit_message) VALUES (?, ?, 'manual', ?, ?)`
  ).run(projectId, status, sha, `msg ${sha.slice(0, 3)}`)
  deployed('a'.repeat(40), 'success')
  deployed('b'.repeat(40), 'failed')
  const liveState = createLiveState()
  liveState.projects[projectId] = projectDefaults(null, getProjectInfo(db, projectId))
  const enqueued = []
  const runner = { enqueue: (id, opts) => (enqueued.push({ id, ...opts }), 77) }
  const app = new Hono()
  app.use('*', (c, next) => (c.set('user', { id: 1, role: 'admin' }), next()))
  app.route('/', projectRoutes({ db, config: { appsDir: '/tmp/apps' }, liveState, runner }))
  const post = body => app.request(`/${projectId}/deploy`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  return { projectId, enqueued, post }
}

test('the route redeploys only a commit this project deployed successfully', async () => {
  const { projectId, enqueued, post } = routeSetup()
  const ok = await post({ sha: 'a'.repeat(40) })
  expect(ok.status).toBe(202)
  expect(enqueued).toEqual([{ id: projectId, trigger: 'redeploy', commitSha: 'a'.repeat(40), commitMessage: 'msg aaa' }])
  for (const sha of ['b'.repeat(40), 'c'.repeat(40), 'HEAD', 42]) {
    const refused = await post({ sha })
    expect(refused.status).toBe(400)
    expect((await refused.json()).fields.sha).toMatch(/not a commit this project has deployed/)
  }
  expect(enqueued.length).toBe(1)
})

test('without a sha it is the ordinary deploy, body or none', async () => {
  const { enqueued, post } = routeSetup()
  expect((await post()).status).toBe(202)
  expect((await post({})).status).toBe(202)
  expect(enqueued.map(e => e.trigger)).toEqual(['manual', 'manual'])
})
