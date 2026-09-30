import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting } from '../src/db/settings.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { projectDirs } from '../src/deploy/envfiles.js'
import { buildCaddyConfig } from '../src/proxy/index.js'
import { DeployRunner, DeployError } from '../src/deploy/runner.js'
import { applyProjectAction } from '../src/deploy/control.js'
import { resurrectApps } from '../src/deploy/resurrect.js'

// Two rules that both rest on knowing what a project is actually deployed as
// (projects.deployed_runtime), as opposed to what its form says (runtime):
//
// 1. A project's pm2 name is never enough to stop or delete a pm2 process.
//    Tenants pick project names, and the name used to be a free-text field
//    for everyone — so a tenant could aim a deploy at the harbor gate.
// 2. The harbor gate serves what is deployed. Switching an app to a static
//    site (or back) moves the route when the deploy has the new thing ready.

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
    appsDir: mkdtempSync(join(tmpdir(), 'skeppa-live-')),
    masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa', sandbox: 'podman', containerSocket: 'test.sock',
  }
  setSetting(db, 'proxy_base_domain', 'apps.example.com')
  const liveState = createLiveState()
  const events = []
  const pm2 = {
    deleteProcess: async name => { events.push(`pm2 delete ${name}`) },
    startOrReload: async () => { events.push('pm2 start') },
    describe: async () => null,
  }
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => {
      c.set('user', user)
      c.set('session', { id: 'sess', user_id: user.id })
      return next()
    })
    app.route('/', projectRoutes({ db, config, liveState, pm2, containerClient: { removeContainer: async () => {} } }))
    return app
  }
  const post = (user, body) => as(user).request('/', { method: 'POST', body: JSON.stringify(body) })
  const patch = (user, id, body) => as(user).request(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  const del = (user, id) => as(user).request(`/${id}`, { method: 'DELETE' })

  // A project row as the runner loads it, with a working tree on disk.
  const addProject = (slug, { runtime, deployed = '', pm2_name = slug, owner = 1, subdomain = slug, files = { 'dist/index.html': slug } }) => {
    const { lastInsertRowid } = db.query(
      `INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, deployed_runtime, subdomain, port, start_command, auto_start)
       VALUES (?, ?, ?, 'o/r', 'main', ?, ?, ?, ?, ?, 'bun start', 1)`
    ).run(slug, slug, owner, pm2_name, runtime, deployed, subdomain, 4100 + db.query('SELECT COUNT(*) AS n FROM projects').get().n)
    const id = Number(lastInsertRowid)
    const project = db.query('SELECT * FROM projects WHERE id = ?').get(id)
    const dirs = projectDirs(config, project)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dirs.source, path, '..'), { recursive: true })
      writeFileSync(join(dirs.source, path), content)
    }
    liveState.projects[id] = projectDefaults(null, getProjectInfo(db, id))
    return { id, project, dirs }
  }
  const runner = (overrides = {}) => new DeployRunner({
    db, config, liveState, logs: NO_LOGS, github: null, pm2,
    containerClient: { removeContainer: async name => { events.push(`remove container ${name}`) } },
    applyProxy: async () => { events.push('gate reload') },
    ...overrides,
  })
  const routeOf = id => {
    const slug = db.query('SELECT subdomain FROM projects WHERE id = ?').get(id).subdomain
    const route = buildCaddyConfig(db, config).apps.http.servers.skeppa.routes.find(r => r.match?.[0].host[0].startsWith(`${slug}.`))
    return route.handle[0].handler === 'reverse_proxy' ? 'proxy' : 'files'
  }
  const deployed = id => db.query('SELECT deployed_runtime FROM projects WHERE id = ?').get(id).deployed_runtime
  return { db, config, liveState, admin, bob, events, pm2, post, patch, del, addProject, runner, routeOf, deployed }
}

const log = () => {
  const lines = []
  return { lines, line: l => lines.push(l) }
}

// --- 1. pm2 names ---------------------------------------------------------------

test("a tenant cannot aim a project at the harbor gate's process — by field, by edit, or by project name", async () => {
  const { bob, post, patch } = setup()
  const site = await (await post(bob, { name: 'Site', git_url: 'https://example.com/s.git', runtime: 'static', pm2_name: 'skeppa-proxy' })).json()
  expect(site.pm2_name).toBe('site') // the field is not an input for a project with no pm2 process

  const edited = await (await patch(bob, site.id, { pm2_name: 'skeppa-proxy' })).json()
  expect(edited.pm2_name).toBe('site')

  // naming the project after the process does not get there either
  const proxyNamed = await (await post(bob, { name: 'Skeppa Proxy', git_url: 'https://example.com/p.git' })).json()
  expect(proxyNamed.pm2_name).toBe('skeppa-proxy-2')
  const panelNamed = await (await post(bob, { name: 'Skeppa', git_url: 'https://example.com/k.git' })).json()
  expect(panelNamed.pm2_name).toBe('skeppa-2')
})

test("an admin's pm2 project cannot take the gate's name; the panel's own name stays for the panel", async () => {
  const { admin, post, patch } = setup()
  const taken = await post(admin, { name: 'Gate', git_url: 'https://example.com/g.git', runtime: 'pm2', pm2_name: 'skeppa-proxy' })
  expect(taken.status).toBe(400)
  expect((await taken.json()).fields.pm2_name).toBe('reserved for the harbor gate')

  const panel = await (await post(admin, { name: 'Panel', git_url: 'https://example.com/skeppa.git', runtime: 'pm2', pm2_name: 'skeppa' })).json()
  expect(panel.pm2_name).toBe('skeppa') // how the panel deploys itself

  const app = await (await post(admin, { name: 'App', git_url: 'https://example.com/a.git', runtime: 'pm2' })).json()
  const renamed = await patch(admin, app.id, { pm2_name: 'skeppa-proxy' })
  expect(renamed.status).toBe(400)
  expect((await renamed.json()).fields.pm2_name).toBe('reserved for the harbor gate')
})

test('a deploy deletes a pm2 process only when the project was really deployed as one — never on the name alone', async () => {
  const { addProject, runner, events } = setup()
  const r = runner()
  // never deployed; its pm2 name happens to match a process that is not the project's
  const fresh = addProject('fresh', { runtime: 'static', deployed: '', pm2_name: 'someone-elses-process' })
  await r._settle(fresh.project, fresh.dirs, log())
  // was a container: there is a container to remove, and no pm2 process
  const wasContainer = addProject('wascontainer', { runtime: 'static', deployed: 'container', pm2_name: 'another-process' })
  await r._settle(wasContainer.project, wasContainer.dirs, log())
  expect(events.filter(e => e.startsWith('pm2 delete'))).toEqual([])

  // was a pm2 process: that one, and only that one, goes
  const wasPm2 = addProject('waspm2', { runtime: 'static', deployed: 'pm2', pm2_name: 'waspm2' })
  await r._settle(wasPm2.project, wasPm2.dirs, log())
  expect(events.filter(e => e.startsWith('pm2 delete'))).toEqual(['pm2 delete waspm2'])

  // a row that already carries a reserved name is still never acted on
  events.length = 0
  for (const [slug, name] of [['poisoned', 'skeppa-proxy'], ['selfish', 'skeppa']]) {
    const p = addProject(slug, { runtime: 'static', deployed: 'pm2', pm2_name: name })
    await r._settle(p.project, p.dirs, log())
  }
  expect(events.filter(e => e.startsWith('pm2 delete'))).toEqual([])
})

test('deleting a project removes a pm2 process only for a pm2 project, and never a reserved one', async () => {
  const { admin, bob, del, addProject, events } = setup()
  const tenantSite = addProject('tenantsite', { runtime: 'static', deployed: 'static', owner: 2, pm2_name: 'someone-elses-process' })
  expect((await del(bob, tenantSite.id)).status).toBe(200)
  const poisoned = addProject('poisoned', { runtime: 'pm2', deployed: 'pm2', pm2_name: 'skeppa-proxy' })
  expect((await del(admin, poisoned.id)).status).toBe(200)
  const panel = addProject('panel', { runtime: 'pm2', deployed: 'pm2', pm2_name: 'skeppa' })
  expect((await del(admin, panel.id)).status).toBe(200) // forgetting the project must not stop the panel
  expect(events).toEqual([])

  const app = addProject('app', { runtime: 'pm2', deployed: 'pm2', pm2_name: 'app' })
  await del(admin, app.id)
  const moved = addProject('moved', { runtime: 'container', deployed: 'pm2', pm2_name: 'moved' }) // switch not deployed yet
  await del(admin, moved.id)
  expect(events).toEqual(['pm2 delete app', 'pm2 delete moved'])
})

// --- 2. the gate serves what is deployed ------------------------------------------

test('the route follows the deployed runtime, not the form', () => {
  const { addProject, routeOf } = setup()
  expect(routeOf(addProject('pending-static', { runtime: 'static', deployed: 'container' }).id)).toBe('proxy')
  expect(routeOf(addProject('pending-app', { runtime: 'container', deployed: 'static' }).id)).toBe('files')
  expect(routeOf(addProject('new-static', { runtime: 'static', deployed: '' }).id)).toBe('files') // nothing deployed: the form is all there is
  expect(routeOf(addProject('new-app', { runtime: 'container', deployed: '' }).id)).toBe('proxy')
})

test('saving a runtime change moves nothing: the old site keeps its route until a deploy', async () => {
  const { admin, patch, addProject, routeOf, deployed } = setup()
  const app = addProject('shop', { runtime: 'container', deployed: 'container' })
  const res = await patch(admin, app.id, { runtime: 'static' })
  expect(res.status).toBe(200)
  expect((await res.json())).toMatchObject({ runtime: 'static', deployed_runtime: 'container' })
  expect(routeOf(app.id)).toBe('proxy')
  expect(deployed(app.id)).toBe('container')
})

test('app → static: the route moves once the site is published, and the old container goes only after that', async () => {
  const { db, config, liveState, addProject, runner, events, routeOf, deployed } = setup()
  const { id, project, dirs } = addProject('shop', { runtime: 'static', deployed: 'container' })
  const seen = {}
  const r = runner({
    applyProxy: async () => {
      // what the gate is told at the moment it reloads
      seen.published = existsSync(join(dirs.public, 'index.html'))
      seen.route = buildCaddyConfig(db, config).apps.http.servers.skeppa.routes[0].handle[0].handler
      events.push('gate reload')
    },
  })
  const out = log()
  r._publish(project, dirs, out)
  expect(routeOf(id)).toBe('proxy') // published, but the app still serves until the deploy settles
  await r._settle(project, dirs, out)

  expect(seen).toEqual({ published: true, route: 'subroute' })
  expect(events).toEqual(['gate reload', 'remove container skeppa-app-shop'])
  expect(deployed(id)).toBe('static')
  expect(liveState.projects[id].info.deployed_runtime).toBe('static')
  expect(out.lines).toContain('▸ harbor gate now serves the published files')
})

test('static → app: the route moves once the app is started, and the snapshot goes only after that', async () => {
  const { addProject, runner, events, deployed } = setup()
  const { id, project, dirs } = addProject('docs', { runtime: 'container', deployed: 'static' })
  mkdirSync(dirs.public, { recursive: true })
  writeFileSync(join(dirs.public, 'index.html'), 'old site')
  let snapshotAtReload = null
  const r = runner({ applyProxy: async () => { snapshotAtReload = existsSync(join(dirs.public, 'index.html')); events.push('gate reload') } })
  const out = log()
  await r._settle(project, dirs, out)
  expect(snapshotAtReload).toBe(true)
  expect(existsSync(dirs.public)).toBe(false)
  expect(deployed(id)).toBe('container')
  expect(out.lines).toContain('▸ harbor gate now serves the app')
  expect(events).toEqual(['gate reload']) // a static site had no process or container to remove
})

test('if the gate refuses the new route, the switch is undone: deploy fails, the old app keeps running and serving', async () => {
  const { addProject, runner, events, routeOf, deployed, liveState } = setup()
  const { id, project, dirs } = addProject('shop', { runtime: 'static', deployed: 'container' })
  const r = runner({ applyProxy: async () => { throw new Error('caddy admin API: 400 unknown handler') } })
  const err = await r._settle(project, dirs, log()).catch(e => e)
  expect(err).toBeInstanceOf(DeployError)
  expect(err.message).toContain('the previous site is still being served')
  expect(err.message).toContain('unknown handler')
  expect(deployed(id)).toBe('container')
  expect(liveState.projects[id].info.deployed_runtime).toBe('container')
  expect(routeOf(id)).toBe('proxy')
  expect(events).toEqual([]) // the container was not removed
})

test('a first deploy records what it deployed; a gate hiccup there is a warning, not a failure', async () => {
  const { addProject, runner, deployed, events } = setup()
  const { id, project, dirs } = addProject('new', { runtime: 'static', deployed: '' })
  const out = log()
  await runner({ applyProxy: async () => { throw new Error('caddy binary not found') } })._settle(project, dirs, out)
  expect(deployed(id)).toBe('static')
  expect(out.lines.some(l => l.startsWith('⚠ harbor gate reload failed: caddy binary not found'))).toBe(true)

  // the first static deploy clears a container the slug might have left (its own, by name)
  expect(events).toEqual(['remove container skeppa-app-new'])

  // and a redeploy of the same runtime touches neither the gate nor any process
  events.length = 0
  const again = { ...project, deployed_runtime: 'static' }
  await runner()._settle(again, dirs, log())
  expect(events).toEqual([])
})

test('start/stop and boot resurrection act on what is running, not on a change that was never deployed', async () => {
  const { db, config, addProject } = setup()
  // configured static, still running as a container
  const pending = addProject('pending', { runtime: 'static', deployed: 'container' })
  const calls = []
  const engine = () => ({ stopContainer: async name => { calls.push(`stop ${name}`) } })
  await applyProjectAction({ db, config, project: pending.project, act: 'stop', engine })
  expect(calls).toEqual(['stop skeppa-app-pending'])
  db.query('UPDATE projects SET auto_start = 1 WHERE id = ?').run(pending.id)

  // configured as a container, still a static site
  const stillStatic = addProject('stillstatic', { runtime: 'container', deployed: 'static' })
  const refused = await applyProjectAction({ db, config, project: stillStatic.project, act: 'start', engine }).catch(e => e)
  expect(refused.status).toBe(400)

  const boot = []
  await resurrectApps({
    db, config, log: () => {},
    pm2: { jlist: async () => (boot.push('pm2 list'), []), startOrReload: async () => boot.push('pm2 start') },
    containers: { inspectContainer: async name => (boot.push(`inspect ${name}`), { State: { Running: true } }) },
  })
  expect(boot).toEqual(['inspect skeppa-app-pending']) // the live container is looked after; the static site needs nothing
})
