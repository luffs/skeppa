import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting } from '../src/db/settings.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { buildCaddyConfig, createProxy, staticRoot } from '../src/proxy/index.js'
import { projectDirs } from '../src/deploy/envfiles.js'
import { DeployRunner } from '../src/deploy/runner.js'

// projects.gate_files: an app whose build output the harbor gate serves. The
// app keeps every request that is not a file in that build — and the files
// come from the same panel-owned snapshot a static site uses, never from the
// working tree.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const NO_LOGS = { openLog() {}, appendLog() {}, closeLog() {} }

function setup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const config = {
    appsDir: mkdtempSync(join(tmpdir(), 'skeppa-gatefiles-')),
    dataDir: mkdtempSync(join(tmpdir(), 'skeppa-gatefiles-data-')),
    masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa', sandbox: 'host', deployTimeoutMs: 20_000,
  }
  const liveState = createLiveState()
  const applied = []
  const proxy = { apply: async () => { applied.push(Date.now()) } }
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => {
      c.set('user', user)
      c.set('session', { id: 'sess', user_id: user.id })
      return next()
    })
    app.route('/', projectRoutes({ db, config, liveState, proxy }))
    return app
  }
  const user = id => db.query('SELECT * FROM users WHERE id = ?').get(id)
  const post = (id, body) => as(user(id)).request('/', { method: 'POST', body: JSON.stringify(body) })
  const patch = (id, projectId, body) => as(user(id)).request(`/${projectId}`, { method: 'PATCH', body: JSON.stringify(body) })
  const routeFor = host => buildCaddyConfig(db, config).apps.http.servers.skeppa.routes.find(r => r.match?.[0].host[0] === host)
  return { db, config, liveState, applied, post, patch, routeFor }
}

const APP = { name: 'Shop', git_url: 'https://example.com/shop.git', runtime: 'container', subdomain: 'shop', port: 4321 }

test('an app with gate_files: GET/HEAD for a file in the snapshot is the gate\'s, everything else the app\'s', async () => {
  const { db, config, post, routeFor } = setup()
  expect((await post(1, { ...APP, gate_files: true, publish_dir: 'web/dist' })).status).toBe(201)
  const root = staticRoot(config, 'shop')

  const [handler] = routeFor('shop.apps.example.com').handle
  expect(handler.handler).toBe('subroute')
  const [dirIndex, file, app] = handler.routes

  // a directory path is a file only when it has an index.html: `/` is the build's index.html
  expect(dirIndex.match).toEqual([{ method: ['GET', 'HEAD'], path: ['*/'], file: { root, try_files: ['{http.request.uri.path}index.html'] } }])
  expect(dirIndex.handle[0]).toEqual({ handler: 'rewrite', uri: '{http.matchers.file.relative}' })
  expect(dirIndex.terminal).toBe(true)
  // any other path only when it is a file (a try_files entry without a slash never matches a directory)
  expect(file.match).toEqual([{ method: ['GET', 'HEAD'], not: [{ path: ['*/'] }], file: { root, try_files: ['{http.request.uri.path}'] } }])
  expect(file.terminal).toBe(true)
  // both serve through the same compressed, cache-aware file routes a static site uses
  for (const route of [dirIndex, file]) {
    const files = route.handle.at(-1)
    expect(files.handler).toBe('subroute')
    expect(files.routes.map(r => r.handle[0].handler)).toEqual(['encode', 'headers', 'headers', 'file_server'])
    expect(files.routes.at(-1).handle[0]).toEqual({ handler: 'file_server', root })
  }
  // the rest — POSTs to /, /api/…, anything not in the build — reaches the app untouched (no encode in front)
  expect(app).toEqual({ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:4321' }] }] })
  expect(JSON.stringify(handler)).not.toContain('source')

  // without the option an app is a plain proxy, as always
  await post(1, { ...APP, name: 'Api', subdomain: 'api', port: 4322 })
  expect(routeFor('api.apps.example.com').handle).toEqual([{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:4322' }] }])

  const proxy = createProxy({ db, config, fetchFn: async () => ({ ok: true }), pm2: { describe: async () => null }, which: () => '/usr/bin/caddy' })
  const listed = Object.fromEntries((await proxy.status()).routes.map(r => [r.host, { static: r.static, files: r.files }]))
  expect(listed).toEqual({
    'api.apps.example.com': { static: false, files: false },
    'shop.apps.example.com': { static: false, files: true },
  })
})

test('turning gate_files on or off re-applies the gate at once', async () => {
  const { post, patch, applied } = setup()
  const created = await (await post(1, APP)).json()
  applied.length = 0
  expect((await patch(1, created.id, { gate_files: true })).status).toBe(200)
  expect(applied.length).toBe(1)
  expect((await patch(1, created.id, { name: 'Shop 2' })).status).toBe(200)
  expect(applied.length).toBe(1) // an unrelated edit leaves the gate alone
  expect((await (await patch(1, created.id, { gate_files: false })).json()).gate_files).toBe(0)
  expect(applied.length).toBe(2)
})

test('a tenant\'s container app may have the gate serve its files', async () => {
  const { post } = setup()
  const res = await post(2, { ...APP, gate_files: true })
  expect(res.status).toBe(201)
  expect((await res.json()).gate_files).toBe(1)
})

// --- deploy: real git, real files ------------------------------------------------

function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-gatefiles-repo-'))
  const git = (...args) => {
    const res = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir })
    if (res.exitCode !== 0) throw new Error(`git ${args[0]}: ${res.stderr.toString()}`)
  }
  const write = tree => {
    for (const [path, content] of Object.entries(tree)) {
      if (content === null) {
        rmSync(join(dir, path), { recursive: true, force: true })
        continue
      }
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
  }
  git('init', '-q', '-b', 'main')
  write(files)
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return { dir, commit(tree, message) { write(tree); git('add', '-A'); git('commit', '-q', '-m', message) } }
}

async function deployAndWait(runner, db, projectId) {
  const id = runner.enqueue(projectId, { trigger: 'manual' })
  for (let i = 0; i < 400; i++) {
    const row = db.query('SELECT status, log FROM deployments WHERE id = ?').get(id)
    if (row.status === 'success' || row.status === 'failed') return row
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('deploy did not finish')
}

test('a deploy publishes the build before the app is touched, keeps it, and a missing build stops before the app', async () => {
  const { db, config, liveState } = setup()
  const repo = gitRepo({
    'web/dist/index.html': '<h1>v1</h1>',
    'web/dist/assets/index-AAAAAAA1.js': 'v1',
    'server.js': 'app',
  })
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime, start_command, subdomain, port, publish_dir, gate_files, deploy_script)
            VALUES ('shop', 'Shop', 1, '', ?, 'main', 'shop', 'pm2', 'bun server.js', 'shop', 4321, 'web/dist', 1, '')`).run(repo.dir)
  liveState.projects[1] = projectDefaults(null, getProjectInfo(db, 1))
  const publicDir = projectDirs(config, { slug: 'shop' }).root + '/public'
  const starts = []
  const pm2 = {
    startOrReload: async () => { starts.push(existsSync(join(publicDir, 'index.html')) ? readFileSync(join(publicDir, 'index.html'), 'utf8') : null) },
    deleteProcess: async () => {},
    describe: async () => null,
  }
  const runner = new DeployRunner({ db, config, liveState, logs: NO_LOGS, github: null, pm2, applyProxy: async () => {} })

  const first = await deployAndWait(runner, db, 1)
  expect(first.status).toBe('success')
  expect(first.log).toContain('▸ publishing web/dist — the harbor gate answers with these files, the app with the rest')
  expect(starts).toEqual(['<h1>v1</h1>']) // the files were in place when the app started
  expect(first.log).not.toContain('no index.html') // an app may serve its own root

  // the next build renames its chunk: the old one stays for pages still open
  repo.commit({ 'web/dist/index.html': '<h1>v2</h1>', 'web/dist/assets/index-AAAAAAA1.js': null, 'web/dist/assets/index-BBBBBBB2.js': 'v2' }, 'v2')
  const second = await deployAndWait(runner, db, 1)
  expect(second.status).toBe('success')
  expect(second.log).toContain('▸ kept 1 hashed asset of the previous build, for pages that are still open')
  expect(existsSync(join(publicDir, 'assets', 'index-AAAAAAA1.js'))).toBe(true)
  expect(existsSync(join(publicDir, 'assets', 'index-BBBBBBB2.js'))).toBe(true)

  // a build that did not produce the directory: the deploy stops before the app, and says where a site is
  repo.commit({ 'web/dist': null, 'client/dist/index.html': '<h1>moved</h1>' }, 'moved the frontend')
  const third = await deployAndWait(runner, db, 1)
  expect(third.status).toBe('failed')
  expect(third.log).toContain('publish directory "web/dist" not found — did the build produce it? Built sites found at: client/dist')
  expect(starts.length).toBe(2) // not restarted
  expect(readFileSync(join(publicDir, 'index.html'), 'utf8')).toBe('<h1>v2</h1>') // the files that were served still are

  // switched off: the next deploy removes the snapshot once the app is up
  db.query('UPDATE projects SET gate_files = 0').run()
  repo.commit({ 'web/dist/index.html': '<h1>v3</h1>' }, 'v3')
  const fourth = await deployAndWait(runner, db, 1)
  expect(fourth.status).toBe('success')
  expect(fourth.log).not.toContain('publishing')
  expect(existsSync(publicDir)).toBe(false)
}, 60_000)
