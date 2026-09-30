import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting } from '../src/db/settings.js'
import { createLiveState } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { buildCaddyConfig, createProxy, staticRoot } from '../src/proxy/index.js'
import { DeployRunner } from '../src/deploy/runner.js'
import { applyProjectAction } from '../src/deploy/control.js'
import { resurrectApps } from '../src/deploy/resurrect.js'

// The static runtime: a project with no process. The deploy builds files, the
// panel publishes a snapshot of them, and the harbor gate serves the snapshot.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const NO_LOGS = { openLog() {}, appendLog() {}, closeLog() {} }

function setup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  const admin = db.query('SELECT * FROM users WHERE id = 1').get()
  const bob = db.query('SELECT * FROM users WHERE id = 2').get()
  const config = {
    appsDir: mkdtempSync(join(tmpdir(), 'skeppa-static-')),
    dataDir: mkdtempSync(join(tmpdir(), 'skeppa-static-data-')),
    masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa', sandbox: 'podman', deployTimeoutMs: 20_000,
  }
  const liveState = createLiveState()
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => {
      c.set('user', user)
      c.set('session', { id: 'sess', user_id: user.id })
      return next()
    })
    app.route('/', projectRoutes({ db, config, liveState }))
    return app
  }
  const post = (user, body) => as(user).request('/', { method: 'POST', body: JSON.stringify(body) })
  const patch = (user, id, body) => as(user).request(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  return { db, config, liveState, admin, bob, post, patch }
}

const SITE = { name: 'Site', git_url: 'https://example.com/site.git', runtime: 'static' }

// --- routes -------------------------------------------------------------------

test('a static project defaults to publishing dist, and the directory is normalized and whitelisted', async () => {
  const { admin, post, patch } = setup()
  const created = await (await post(admin, SITE)).json()
  expect(created).toMatchObject({ runtime: 'static', publish_dir: 'dist', spa_fallback: 0 })

  expect((await (await patch(admin, created.id, { publish_dir: './build/' })).json()).publish_dir).toBe('build')
  expect((await (await patch(admin, created.id, { publish_dir: '.' })).json()).publish_dir).toBe('') // the working directory itself
  expect((await (await patch(admin, created.id, { spa_fallback: true })).json()).spa_fallback).toBe(1)

  for (const bad of ['../outside', '/etc', 'a/../../b', 'dist;rm -rf']) {
    const res = await patch(admin, created.id, { publish_dir: bad })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.publish_dir).toBe('must be a safe relative path')
  }
})

test('a tenant may run a container or a static site — never a host process', async () => {
  const { bob, post, patch } = setup()
  const site = await post(bob, SITE)
  expect(site.status).toBe(201)
  const created = await site.json()
  expect(created.runtime).toBe('static')

  const app = await (await post(bob, { name: 'App', git_url: 'https://example.com/app.git' })).json()
  expect(app.runtime).toBe('container') // unspecified still means a container

  const toPm2 = await patch(bob, created.id, { runtime: 'pm2' })
  expect(toPm2.status).toBe(400) // a field error, not a 500
  expect((await toPm2.json()).fields.runtime).toContain('container or as a static site')
  expect((await patch(bob, created.id, { runtime: 'container' })).status).toBe(200)
})

test('the panel itself cannot become a static site', async () => {
  const { admin, post, patch } = setup()
  const panel = await (await post(admin, { name: 'Panel', git_url: 'https://example.com/skeppa.git', pm2_name: 'skeppa', runtime: 'pm2' })).json()
  const res = await patch(admin, panel.id, { runtime: 'static' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.runtime).toContain('must run under pm2')
})

// --- the harbor gate ------------------------------------------------------------

test('a static project is routed to a file server on its snapshot; an app to its port', async () => {
  const { db, config, admin, post } = setup()
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  await post(admin, { ...SITE, subdomain: 'docs' })
  await post(admin, { ...SITE, name: 'Spa', subdomain: 'spa', spa_fallback: true })
  await post(admin, { name: 'Api', git_url: 'https://example.com/api.git', subdomain: 'api', port: 4001 })

  const routes = buildCaddyConfig(db, config).apps.http.servers.skeppa.routes
  const byHost = Object.fromEntries(routes.filter(r => r.match).map(r => [r.match[0].host[0], r.handle]))

  expect(byHost['api.apps.example.com']).toEqual([{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:4001' }] }])

  const root = staticRoot(config, 'site')
  expect(root).toBe(join(config.appsDir, 'site', 'public'))
  const docs = byHost['docs.apps.example.com'][0]
  expect(docs.handler).toBe('subroute')
  expect(docs.routes.map(r => r.handle[0].handler)).toEqual(['encode', 'file_server'])
  expect(docs.routes.at(-1).handle[0]).toEqual({ handler: 'file_server', root })

  // the fallback: a path that is no file is rewritten to index.html, within the same root
  const spaRoot = staticRoot(config, 'spa')
  const spa = byHost['spa.apps.example.com'][0]
  expect(spa.routes.map(r => r.handle[0].handler)).toEqual(['encode', 'rewrite', 'file_server'])
  expect(spa.routes[1]).toEqual({
    match: [{ file: { root: spaRoot, try_files: ['{http.request.uri.path}', '/index.html'] } }],
    handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
  })
  // nothing in the config ever points at a working tree
  expect(JSON.stringify(routes)).not.toContain('source')

  const proxy = createProxy({ db, config, fetchFn: async () => ({ ok: true }), pm2: { describe: async () => null }, which: () => '/usr/bin/caddy' })
  const listed = Object.fromEntries((await proxy.status()).routes.map(r => [r.host, r.static]))
  expect(listed).toEqual({ 'api.apps.example.com': false, 'docs.apps.example.com': true, 'spa.apps.example.com': true })
})

// --- deploy: real git, real files -----------------------------------------------

function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-static-repo-'))
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

test('deploying a static project publishes what the repo holds, and a failed publish keeps the old site up', async () => {
  const { db, config, liveState } = setup()
  const repo = gitRepo({ 'dist/index.html': '<h1>v1</h1>', 'dist/assets/app.js': 'x', 'dist/.env': 'SECRET=1', 'README.md': 'src' })
  // Inserted directly: the route only takes https URLs, the runner takes any.
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime, start_command, subdomain, publish_dir, deploy_script)
            VALUES ('site', 'Site', 1, '', ?, 'main', 'site', 'static', 'ignored for static', 'docs', 'dist', '')`).run(repo.dir)
  const runner = new DeployRunner({ db, config: { ...config, sandbox: 'host' }, liveState, logs: NO_LOGS, github: null })
  const publicDir = join(config.appsDir, 'site', 'public')

  const first = await deployAndWait(runner, db, 1)
  expect(first.log).toContain('▸ publishing dist')
  expect(first.status).toBe('success')
  expect(first.log).toContain('published 2 files')
  expect(first.log).toContain('left out 1 dot-file')
  expect(first.log).not.toContain('no start command') // nothing is started, and nothing claims to be skipped
  expect(readFileSync(join(publicDir, 'index.html'), 'utf8')).toBe('<h1>v1</h1>')
  expect(existsSync(join(publicDir, '.env'))).toBe(false)
  expect(existsSync(join(publicDir, 'README.md'))).toBe(false) // only the publish directory

  // the next commit drops the build output: the deploy fails, the site stays
  repo.commit({ dist: null, 'src.txt': 'no build' }, 'lose dist')
  const second = await deployAndWait(runner, db, 1)
  expect(second.status).toBe('failed')
  expect(second.log).toContain('publish directory "dist" not found — did the build produce it?')
  expect(readFileSync(join(publicDir, 'index.html'), 'utf8')).toBe('<h1>v1</h1>')
}, 30_000)

test('a tenant static deploy passes the runtime guard; a tenant host process does not', async () => {
  const { db, config, liveState } = setup()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime) VALUES ('bobsite', 'BobSite', 2, 'b/s', 'main', 'bobsite', 'static')`).run()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime) VALUES ('bobhost', 'BobHost', 2, 'b/h', 'main', 'bobhost', 'pm2')`).run()
  const ran = []
  const runner = new DeployRunner({ db, config, liveState, logs: NO_LOGS, github: null, execute: async project => { ran.push(project.slug) } })
  expect((await deployAndWait(runner, db, 1)).status).toBe('success')
  const host = await deployAndWait(runner, db, 2)
  expect(host.status).toBe('failed')
  expect(host.log).toContain('container or as a static site')
  expect(ran).toEqual(['bobsite'])
})

// --- no process: nothing to drive, nothing to resurrect --------------------------

test('start, stop and restart are refused for a static site, and start-at-boot is left alone', async () => {
  const { db, config } = setup()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, auto_start) VALUES ('site', 'Site', 1, 'o/r', 'main', 'site', 'static', 1)`).run()
  const project = db.query('SELECT * FROM projects WHERE id = 1').get()
  for (const act of ['start', 'stop', 'restart']) {
    const err = await applyProjectAction({ db, config, project, act, engine: () => { throw new Error('engine must not be touched') } }).catch(e => e)
    expect(err.status).toBe(400)
    expect(err.message).toContain('no process')
  }
  expect(db.query('SELECT auto_start FROM projects WHERE id = 1').get().auto_start).toBe(1)
})

test('boot resurrection starts nothing for a static project, even one with a leftover start command', async () => {
  const { db, config } = setup()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, auto_start) VALUES ('site', 'Site', 1, 'o/r', 'main', 'site', 'static', 'bun run start', 1)`).run()
  mkdirSync(join(config.appsDir, 'site', 'source'), { recursive: true })
  writeFileSync(join(config.appsDir, 'site', 'ecosystem.config.cjs'), 'module.exports = {}') // from a pm2 era
  const calls = []
  const pm2 = { jlist: async () => (calls.push('jlist'), []), startOrReload: async file => calls.push(file) }
  const containers = { inspectContainer: async () => (calls.push('inspect'), null) }
  await resurrectApps({ db, config, pm2, containers, log: () => {} })
  expect(calls).toEqual([]) // pm2 is not even asked: there is no pm2 project
  expect(existsSync(join(config.appsDir, 'site', 'ecosystem.config.cjs'))).toBe(false)
})
