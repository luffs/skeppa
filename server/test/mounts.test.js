import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { projectRoutes } from '../src/routes/projects.js'
import { planReassign } from '../src/lib/reassign.js'
import { parseMounts, formatMounts, parseMountRoots, hostPathProblem, mountBinds } from '../src/lib/mounts.js'
import { appContainerSpec, recreateAppContainer } from '../src/containers/runtime.js'

// Host directories mounted into a container app (a network share on the
// host): admin-set, under MOUNT_ROOTS only, never onto what the panel keeps.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const SCOPE = { roots: ['/mnt/nas'], guarded: ['/home/skeppa/apps', '/home/skeppa/.skeppa'] }

test('mount lines parse into host, target and mode, and are stored normalized', () => {
  const { mounts, error } = parseMounts(' /mnt/nas/Media Library/:/media:ro \n\n/mnt/nas/backup:/data/backup')
  expect(error).toBe('')
  expect(mounts).toEqual([
    { host: '/mnt/nas/Media Library', target: '/media', readOnly: true },
    { host: '/mnt/nas/backup', target: '/data/backup', readOnly: false },
  ])
  expect(formatMounts(mounts)).toBe('/mnt/nas/Media Library:/media:ro\n/mnt/nas/backup:/data/backup')
  expect(parseMounts('').mounts).toEqual([])
})

test('a mount line that is not a clean pair of absolute paths is refused', () => {
  for (const bad of [
    '/mnt/nas/x', // no target
    'mnt/nas:/x', // relative host
    '/mnt/nas/../etc:/x', // climbs out
    '/mnt/nas/x:/y:rx', // unknown mode
    '/mnt/nas/$(id):/x', // nothing shell-ish
    '/:/x', // the whole host
    '/mnt/nas/x:/', // over the root
    '/mnt/nas/x:/app', // the source
    '/mnt/nas/x:/app/web',
    '/mnt/nas/x:/data', // over shared/
    '/mnt/nas/x:/proc/x',
    '/mnt/nas/a:/m\n/mnt/nas/b:/m', // twice
  ]) expect(parseMounts(bad).error).not.toBe('')
  expect(parseMounts(Array.from({ length: 11 }, (_, i) => `/mnt/nas/${i}:/m${i}`).join('\n')).error).toContain('at most')
})

test('roots come from the config; / is never one', () => {
  expect(parseMountRoots('/mnt/nas/:/srv/share, ./rel,/')).toEqual({ roots: ['/mnt/nas', '/srv/share'], ignored: ['./rel', '/'] })
  expect(parseMountRoots(undefined).roots).toEqual([])
})

test('a host path lies under a root, and never at, around or under what the panel keeps', () => {
  expect(hostPathProblem('/mnt/nas/media', SCOPE)).toBe('')
  expect(hostPathProblem('/mnt/nas', SCOPE)).toBe('')
  expect(hostPathProblem('/mnt/nasty', SCOPE)).toContain('not under')
  expect(hostPathProblem('/mnt/nas/x', { ...SCOPE, roots: [] })).toContain('MOUNT_ROOTS')
  const wide = { roots: ['/home'], guarded: SCOPE.guarded }
  expect(hostPathProblem('/home/skeppa', wide)).toContain('keeps to itself') // around the apps
  expect(hostPathProblem('/home/skeppa/apps/other/shared', wide)).toContain('keeps to itself') // inside
  expect(hostPathProblem('/home/someone', wide)).toBe('')
})

test('at create the real paths are checked: a symlink out of the share is refused', () => {
  const config = { mountRoots: ['/mnt/nas'], mountGuarded: ['/home/skeppa/.skeppa'] }
  const links = { '/mnt/nas/media': '/mnt/nas/media', '/mnt/nas/sneaky': '/home/skeppa/.skeppa', '/mnt/nas': '/mnt/nas' }
  const realpath = p => {
    if (!(p in links)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return links[p]
  }
  expect(mountBinds(config, { mounts: '/mnt/nas/media:/media:ro' }, { realpath })).toEqual(['/mnt/nas/media:/media:ro'])
  expect(mountBinds(config, { mounts: '' }, { realpath })).toEqual([])
  expect(() => mountBinds(config, { mounts: '/mnt/nas/sneaky:/x' }, { realpath })).toThrow(/really \/home\/skeppa\/\.skeppa/)
  expect(() => mountBinds(config, { mounts: '/mnt/nas/gone:/x' }, { realpath })).toThrow(/is the share mounted/)
  // roots narrowed since the mount was saved
  expect(() => mountBinds({ ...config, mountRoots: [] }, { mounts: '/mnt/nas/media:/m' }, { realpath })).toThrow(/MOUNT_ROOTS/)
})

test('the spec binds them after source and shared; a mount that cannot be made stops nothing', async () => {
  const dirs = { source: '/apps/a/source', shared: '/apps/a/shared' }
  const project = { slug: 'a', port: 4100, start_command: 'bun start', mounts: '/nowhere/at/all:/media' }
  const spec = appContainerSpec({ buildImage: 'img' }, project, dirs, {}, ['/mnt/nas/media:/media:ro'])
  expect(spec.HostConfig.Binds).toEqual(['/apps/a/source:/app:ro', '/apps/a/shared:/data', '/mnt/nas/media:/media:ro'])

  const calls = []
  const engine = new Proxy({}, { get: (_, name) => async (...args) => { calls.push(name, args) } })
  await expect(recreateAppContainer({
    config: { buildImage: 'img', mountRoots: ['/nowhere'], mountGuarded: [] }, project, dirs, env: {}, client: engine,
  })).rejects.toThrow(/is not there/)
  expect(calls).toEqual([]) // the running container was never touched
})

function setup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle, github_login) VALUES ('bob', 'x', 'tenant', 'bob', 'bobgh')").run()
  const admin = db.query('SELECT * FROM users WHERE id = 1').get()
  const bob = db.query('SELECT * FROM users WHERE id = 2').get()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime, start_command, port)
            VALUES ('bobapp', 'BobApp', 2, '', 'https://example.com/b.git', 'main', 'bobapp', 'container', 'bun start', 4102)`).run()
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults(null, getProjectInfo(db, 1))
  const config = { appsDir: '/tmp/apps', masterKey: 'a'.repeat(64), selfPm2Name: 'skeppa', mountRoots: ['/mnt/nas'], mountGuarded: ['/tmp/apps'] }
  const routes = projectRoutes({ db, config, liveState })
  const as = user => {
    const app = new Hono()
    app.use('*', (c, next) => { c.set('user', user); return next() })
    app.route('/', routes)
    return (path, method, body) => app.request(path, { method, body: JSON.stringify(body) })
  }
  return { db, liveState, admin: as(admin), bob: as(bob), adminUser: admin, bobUser: bob }
}

test('an admin gives a project mounts under the roots; elsewhere is refused', async () => {
  const { admin, db, liveState } = setup()
  const ok = await admin('/1', 'PATCH', { mounts: '/mnt/nas/media/:/media:ro' })
  expect(ok.status).toBe(200)
  expect((await ok.json()).mounts).toBe('/mnt/nas/media:/media:ro')
  expect(liveState.projects[1].info.mounts).toBe('/mnt/nas/media:/media:ro')

  for (const bad of ['/etc:/etc2', '/tmp/apps/other:/x', '/mnt/nas/x:/app']) {
    const res = await admin('/1', 'PATCH', { mounts: bad })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.mounts).toBeTruthy()
  }
  expect(db.query('SELECT mounts FROM projects WHERE id = 1').get().mounts).toBe('/mnt/nas/media:/media:ro')

  const created = await admin('/', 'POST', { name: 'Gallery', git_url: 'https://example.com/g.git', mounts: '/mnt/nas/photos:/photos:ro' })
  expect(created.status).toBe(201)
  expect((await created.json()).mounts).toBe('/mnt/nas/photos:/photos:ro')
})

test('a tenant keeps the mounts an admin gave, and can neither change nor set them', async () => {
  const { admin, bob, db } = setup()
  await admin('/1', 'PATCH', { mounts: '/mnt/nas/media:/media:ro' })

  // saving anything else, the unchanged mounts sent back along, works
  const rename = await bob('/1', 'PATCH', { name: 'Bob App', mounts: '/mnt/nas/media:/media:ro' })
  expect(rename.status).toBe(200)
  for (const mounts of ['/mnt/nas/media:/media', '/mnt/nas:/all', '']) {
    const res = await bob('/1', 'PATCH', { mounts })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.mounts).toContain('admin')
  }
  expect(db.query('SELECT mounts FROM projects WHERE id = 1').get().mounts).toBe('/mnt/nas/media:/media:ro')

  const created = await bob('/', 'POST', { name: 'Peek', git_url: 'https://example.com/p.git', mounts: '/mnt/nas/x:/x' })
  expect(created.status).toBe(400)
  expect((await created.json()).fields.mounts).toContain('admin')
})

test('a Crew move never hands mounts to a tenant', async () => {
  const { db, adminUser, bobUser } = setup()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, pm2_name, runtime, port, mounts)
            VALUES ('nas', 'Nas', 1, '', 'https://example.com/n.git', 'main', 'nas', 'container', 4103, '/mnt/nas/x:/x')`).run()
  const plan = await planReassign({ db }, adminUser, bobUser)
  expect(plan.blockers.map(b => b.reason).join(' ')).toContain('host mounts')
})
