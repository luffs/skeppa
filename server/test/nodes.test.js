import { test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { createHub } from 'lazy-storage/server'
import { createNetwork } from 'lazy-storage/testing'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, initLiveState } from '../src/live/state.js'
import { createLiveStores, STORE_SHAPES } from '../src/live/stores.js'
import { createNodeLinks } from '../src/nodes/links.js'
import { createUplink, createAgentHub, masterMayOpen, agentUrl, METHODS, fleetRequestUrl } from '../src/agent/uplink.js'
import { createFleetApiApp } from '../src/app.js'
import { createFleetAnswers } from '../src/nodes/answers.js'
import { FleetGitHub } from '../src/agent/github.js'
import { GitHubApp } from '../src/github/appClient.js'
import { pushSlice } from '../src/github/push.js'
import { nodeRoutes, nodeJoinRoutes } from '../src/routes/nodes.js'
import { parseAgentKey, sha256, nodeForKey } from '../src/nodes/keys.js'
import { parseMasterUrl } from '../src/config.js'

// Agents: another Skeppa reporting to this one over a socket it dials
// itself. A real Bun.serve master and a real uplink, over loopback.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const wait = ms => new Promise(r => setTimeout(r, ms))
// A test network queues its deliveries until settled: pass the nets to drain.
async function until(fn, ms = 3000, nets = []) {
  const end = Date.now() + ms
  for (;;) {
    for (const net of nets) await net.settle()
    let ok
    try {
      ok = fn()
    } catch {
      ok = false
    }
    if (ok) return
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms: ${fn}`)
    await wait(10)
  }
}

const cleanups = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()()
})

function freshDb() {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, migrationsDir)
  return db
}

// `db`: another master process on the same database (a restart); the rest
// goes to createNodeLinks.
function master({ db = null, ...linkOptions } = {}) {
  if (!db) {
    db = freshDb()
    db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  }
  const liveState = createLiveState()
  initLiveState(liveState, db, {})
  const errors = []
  const minted = []
  const github = {
    isConfigured: () => true,
    getScopedToken: async repo => (minted.push(repo), { token: `tok-${repo}`, expiresAt: Date.now() + 3_600_000 }),
    getRepoInstallation: async repo => ({ id: 9, account: repo.split('/')[0] }),
    listRepos: async account => [{ full_name: 'ops/web', owner: 'ops', account }],
    appOwnerLogin: async () => 'ops',
  }
  let answers = null
  const links = createNodeLinks({
    db, liveState, onError: err => errors.push(err.message), reconnect: { min: 20, max: 100 }, linger: 50,
    onAsk: (nodeId, method, params) => answers.answer(nodeId, method, params),
    ...linkOptions,
  })
  answers = createFleetAnswers({ github, links })
  const app = new Hono()
  app.route('/api/nodes/join', nodeJoinRoutes({ db, links }))
  app.use('/api/nodes/*', (c, next) => {
    c.set('user', { id: 1, role: 'admin' })
    return next()
  })
  app.route('/api/nodes', nodeRoutes({ db, links }))
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req, srv) => links.upgrade(req, srv) ?? app.fetch(req),
    websocket: links.websocket,
  })
  const url = `http://127.0.0.1:${server.port}`
  const api = (path, init = {}) => fetch(url + path, { headers: { 'content-type': 'application/json' }, ...init })
  cleanups.push(() => {
    links.dispose()
    server.stop(true)
  })
  return { db, liveState, links, url, api, errors, github, minted }
}

function agent() {
  const db = freshDb()
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('ops', 'x', 'admin')").run()
  for (const [slug, port] of [['web', 4101], ['api', 4102]]) {
    db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port)
              VALUES (?, ?, 1, ?, 'main', ?, 'container', 'bun start', ?)`).run(slug, slug, `ops/${slug}`, slug, port)
  }
  db.query(`INSERT INTO deployments (project_id, status, "trigger", log) VALUES (1, 'success', 'manual', 'built fine\n')`).run()
  const liveState = createLiveState()
  initLiveState(liveState, db, {})
  liveState.system = { loadavg: [0.5, 0.4, 0.3], cpuCount: 4 }
  const stores = createLiveStores({ liveState, uplink: true, onError: () => {} })
  const watching = []
  const enqueued = []
  const runner = { enqueue: (id, opts) => (enqueued.push({ id, ...opts }), 500 + enqueued.length), getActiveLog: () => null }
  const config = { appsDir: '/tmp/apps-agent-test', masterKey: 'b'.repeat(64), selfPm2Name: 'skeppa' }
  const link = { uplink: null } // set by connect
  const github = new FleetGitHub({ db, config, ask: (method, params) => link.uplink.ask(method, params) })
  const fleetApi = createFleetApiApp({ db, config, liveState, runner, github })
  return { db, liveState, stores, watching, enqueued, fleetApi, runner, github, link }
}

async function pair(m, name = 'hemma-2') {
  const created = await (await m.api('/api/nodes', { method: 'POST', body: JSON.stringify({ name }) })).json()
  const joined = await (await m.api('/api/nodes/join', { method: 'POST', body: JSON.stringify({ code: created.code }) })).json()
  return { id: created.node.id, code: created.code, key: joined.key }
}

function connect(m, a, key, extra = {}) {
  const uplink = createUplink({
    masterUrl: m.url, key, db: a.db, liveStores: a.stores, version: 'abc1234', fleetApi: a.fleetApi,
    runner: a.runner, liveState: a.liveState, github: a.github,
    onWatch: on => a.watching.push(on),
    log: () => {}, onError: () => {},
    backoff: { min: 20, max: 100 }, refusedDelay: 150,
    ...extra,
  })
  a.link.uplink = uplink
  uplink.start()
  cleanups.push(() => uplink.stop())
  return uplink
}

// A browser on the master: a lazy-storage client through a hub over links.
function browser(m, user = { id: 1, role: 'admin' }) {
  return createNetwork({
    session: ({ send }) => createHub(id => m.links.get(id), { send, user, authorize: (u, id) => m.links.canOpen(u, id) }),
  })
}

test('URLs: a master URL is http(s) without credentials; the agent dials /agent beside any prefix', () => {
  expect(parseMasterUrl('https://panel.example.com/')).toBe('https://panel.example.com')
  expect(parseMasterUrl('')).toBe('')
  expect(parseMasterUrl('ftp://x')).toBeNull()
  expect(parseMasterUrl('https://u:p@x.example')).toBeNull()
  expect(parseMasterUrl('https://x.example/?k=1')).toBeNull()
  expect(agentUrl('https://panel.example.com')).toBe('wss://panel.example.com/agent')
  expect(agentUrl('http://10.0.0.2:3000/skeppa/')).toBe('ws://10.0.0.2:3000/skeppa/agent')
})

test('pairing: the code is spent once for a key, and only hashes are kept', async () => {
  const m = master()
  const created = await (await m.api('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'jobb-1' }) })).json()
  expect(created.code).toMatch(/^skj_1_[0-9a-f]{32}$/)
  expect(m.liveState.nodes[1]).toMatchObject({ name: 'jobb-1', paired: false, online: false })
  expect(m.liveState.nodes[1].joinExpiresAt).not.toBe('')

  const dup = await m.api('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'JOBB-1' }) })
  expect(dup.status).toBe(400)

  const bad = await m.api('/api/nodes/join', { method: 'POST', body: JSON.stringify({ code: 'skj_1_' + '0'.repeat(32) }) })
  expect(bad.status).toBe(401)
  const ok = await m.api('/api/nodes/join', { method: 'POST', body: JSON.stringify({ code: created.code }) })
  const { key, node } = await ok.json()
  expect(node).toEqual({ id: 1, name: 'jobb-1' })
  expect(parseAgentKey(key)?.nodeId).toBe(1)
  const again = await m.api('/api/nodes/join', { method: 'POST', body: JSON.stringify({ code: created.code }) })
  expect(again.status).toBe(401)

  const row = m.db.query('SELECT * FROM nodes WHERE id = 1').get()
  expect(row.key_hash).toBe(sha256(key))
  expect(JSON.stringify(row)).not.toContain(key)
  expect(row.join_hash).toBe('')
  expect(m.liveState.nodes[1]).toMatchObject({ paired: true, joinExpiresAt: '' })
  expect(nodeForKey(m.db, `Bearer ${key}`)?.id).toBe(1)
  expect(nodeForKey(m.db, `Bearer ${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`)).toBeNull()
  expect(nodeForKey(m.db, '')).toBeNull()
})

test('an expired code pairs nothing', async () => {
  const m = master()
  const created = await (await m.api('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).json()
  m.db.query("UPDATE nodes SET join_expires_at = '2000-01-01T00:00:00.000Z'").run()
  const res = await m.api('/api/nodes/join', { method: 'POST', body: JSON.stringify({ code: created.code }) })
  expect(res.status).toBe(401)
})

test('the agent reports everything it runs, and changes and deletions follow', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  const store = m.links.get(`node-${id}`)
  await until(() => Object.keys(store.state.projects).length === 2)
  expect(store.state.projects[1].info.slug).toBe('web')
  expect(store.state.system.cpuCount).toBe(4)
  await until(() => m.liveState.nodes[id].online === true && m.liveState.nodes[id].version === 'abc1234')
  expect(m.liveState.nodes[id].lastSeenAt).not.toBe('')

  a.liveState.projects[2].pm2 = { status: 'online', uptime: 1000 }
  a.liveState.system.loadavg = [2, 2, 2]
  await until(() => store.state.projects[2].pm2?.status === 'online')
  await until(() => store.state.system.loadavg[0] === 2)
  delete a.liveState.projects[1]
  await until(() => store.state.projects[1] === undefined)
  expect(m.errors).toEqual([])
})

test('what changed while the agent was away arrives when it is back — deletions too', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  const uplink = connect(m, a, key)
  const store = m.links.get(`node-${id}`)
  await until(() => Object.keys(store.state.projects).length === 2)
  uplink.stop()
  await until(() => m.liveState.nodes[id].online === false)
  // offline: still shows what it last reported
  expect(Object.keys(store.state.projects).length).toBe(2)
  delete a.liveState.projects[1]
  a.liveState.projects[2].pm2 = { status: 'stopped' }
  await wait(30)
  uplink.start()
  await until(() => store.state.projects[1] === undefined && store.state.projects[2].pm2?.status === 'stopped')
  expect(m.liveState.nodes[id].online).toBe(true)
})

test('browsers: admins open a node and its logs; tenants and unknown nodes are refused', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  expect(m.links.canOpen({ id: 1, role: 'admin' }, `node-${id}`)).toBe(true)
  expect(m.links.canOpen({ id: 1, role: 'admin' }, `node-${id}-deploy-5`)).toBe(true)
  expect(m.links.canOpen({ id: 2, role: 'tenant' }, `node-${id}`)).toBe(false)
  expect(m.links.canOpen({ id: 1, role: 'admin' }, 'node-99')).toBe(false)
  expect(m.links.owns('fleet-1')).toBe(false)

  const net = browser(m)
  const shape = { ...STORE_SHAPES.node, undo: false, presence: false }
  const admin = net.client({ store: `node-${id}`, ...shape })
  await until(() => Object.keys(admin.state.projects ?? {}).length === 2, 3000, [net])
  const tenantNet = browser(m, { id: 2, role: 'tenant' })
  const tenant = tenantNet.client({ store: `node-${id}`, ...shape })
  await until(() => tenant.closed?.code === 'forbidden', 3000, [tenantNet])
})

test('someone looking on the master puts the agent on the live cadence', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  const net = browser(m)
  const viewer = net.client({ store: `node-${id}`, ...STORE_SHAPES.node, undo: false, presence: false })
  await net.settle()
  await until(() => a.watching.at(-1) === true, 3000, [net])
  viewer.disconnect()
  await net.settle()
  await until(() => a.watching.at(-1) === false, 3000, [net])
})

test('a running deploy on the agent is followed from the master, and ends when it ends there', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  a.stores.openLog(7)
  a.stores.appendLog(7, '$ bun install')
  a.stores.appendLog(7, 'done')

  const net = browser(m)
  const log = net.client({ store: `node-${id}-deploy-7`, ...STORE_SHAPES.deploy, undo: false, presence: false })
  await net.settle()
  await until(() => Object.values(log.state.lines ?? {}).length === 2, 3000, [net])
  a.stores.appendLog(7, 'started')
  await until(() => Object.values(log.state.lines).includes('started'), 3000, [net])
  expect(Object.keys(log.state.lines).sort().map(k => log.state.lines[k])).toEqual(['$ bun install', 'done', 'started'])

  a.stores.closeLog(7)
  await until(() => log.closed?.code === 'evicted', 3000, [net])
})

test('the agent serves the master its uplink and deploy logs, nothing else, and takes no writes', async () => {
  const a = agent()
  a.stores.openLog(3)
  const net = createNetwork({ session: ({ send }) => createAgentHub({ liveStores: a.stores, send, onError: () => {} }) })
  const opts = (store, shape) => ({ store, ...shape, undo: false, presence: false })
  const up = net.client(opts('uplink', STORE_SHAPES.node))
  const log = net.client(opts('deploy-3', STORE_SHAPES.deploy))
  const panel = net.client(opts('panel', STORE_SHAPES.panel))
  const fleet = net.client(opts('fleet-1', STORE_SHAPES.fleet))
  await net.settle()
  expect(Object.keys(up.state.projects).length).toBe(2)
  expect(log.closed).toBeFalsy()
  expect(panel.closed?.code).toBe('forbidden')
  expect(fleet.closed?.code).toBe('forbidden')
  expect(masterMayOpen('deploy-x')).toBe(false)

  up.state.projects[1].info.slug = 'hijacked'
  await net.settle()
  expect(a.stores.get('uplink').state.projects[1].info.slug).toBe('web')
  expect(a.liveState.projects[1].info.slug).toBe('web')
})

test('rpc: a deployment with its log is asked of the agent; offline and unknown answer as such', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  const uplink = connect(m, a, key)
  await until(() => m.links.isOnline(id))
  const res = await m.api(`/api/nodes/${id}/deployments/1`)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ id: 1, status: 'success', log: 'built fine\n' })
  expect((await m.api(`/api/nodes/${id}/deployments/99`)).status).toBe(404)
  await expect(m.links.call(id, 'shell', { cmd: 'rm -rf /' })).rejects.toMatchObject({ code: 'unknown-method' })
  await expect(m.links.call(id, 'deployment', { id: 'x' })).rejects.toMatchObject({ code: 'bad-request' })
  uplink.stop()
  await until(() => !m.links.isOnline(id))
  expect((await m.api(`/api/nodes/${id}/deployments/1`)).status).toBe(503)
})

test('METHODS is the whole list of what a master may ask', () => {
  expect(Object.keys(METHODS)).toEqual(['deployment', 'push', 'request'])
})

test('unpairing cuts the agent off and its key stops working; a new code pairs it again', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  const errors = []
  connect(m, a, key, { onError: err => errors.push(err.message) })
  await until(() => m.links.isOnline(id))
  const res = await m.api(`/api/nodes/${id}/unpair`, { method: 'POST' })
  expect(res.status).toBe(200)
  await until(() => errors.some(e => e.includes('refused')))
  expect(m.links.isOnline(id)).toBe(false)
  expect(m.liveState.nodes[id]).toMatchObject({ paired: false, online: false })
  await wait(200) // the agent retries on its refused delay and is refused again
  expect(m.links.isOnline(id)).toBe(false)

  const { code } = await (await m.api(`/api/nodes/${id}/code`, { method: 'POST' })).json()
  const joined = await (await m.api('/api/nodes/join', { method: 'POST', body: JSON.stringify({ code }) })).json()
  expect(joined.key).not.toBe(key)
  connect(m, a, joined.key)
  await until(() => m.links.isOnline(id))
})

test('a second dial with the same key replaces the first', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  const b = agent()
  b.liveState.projects[1].info = { ...b.liveState.projects[1].info, slug: 'from-b' }
  connect(m, b, key, { backoff: { min: 5000, max: 5000 } })
  await until(() => m.links.get(`node-${id}`).state.projects[1]?.info?.slug === 'from-b')
})

test('removing a node closes its store and forgets it', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  const net = browser(m)
  const viewer = net.client({ store: `node-${id}`, ...STORE_SHAPES.node, undo: false, presence: false })
  await net.settle()
  const res = await m.api(`/api/nodes/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(m.liveState.nodes[id]).toBeUndefined()
  expect(m.links.get(`node-${id}`)).toBeNull()
  expect(m.links.isOnline(id)).toBe(false)
  await until(() => viewer.closed !== null && viewer.closed !== undefined, 3000, [net])
})

test('the list and renames', async () => {
  const m = master()
  await pair(m, 'a-server')
  const res = await m.api('/api/nodes/1', { method: 'PATCH', body: JSON.stringify({ name: '  Hemma   ett ' }) })
  expect((await res.json()).name).toBe('Hemma ett')
  const list = await (await m.api('/api/nodes')).json()
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ id: 1, name: 'Hemma ett', paired: true, online: false })
  expect(JSON.stringify(list)).not.toContain('hash')
  expect((await m.api('/api/nodes/1', { method: 'PATCH', body: JSON.stringify({ name: '' }) })).status).toBe(400)
})

// --- phase 2: commands, through the agent's own routes -----------------------

test('the fleet paths: projects, piers, deployments and GitHub listings; normalized; nothing else', () => {
  expect(fleetRequestUrl('POST', '/api/projects/3/deploy')?.pathname).toBe('/api/projects/3/deploy')
  expect(fleetRequestUrl('GET', '/api/projects/3/files?path=README.md')?.search).toBe('?path=README.md')
  expect(fleetRequestUrl('POST', '/api/projects')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/groups/2/deploy')).toBeTruthy()
  expect(fleetRequestUrl('GET', '/api/github/repos/branches?repo=a/b')).toBeTruthy()
  expect(fleetRequestUrl('GET', '/api/deployments/9')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/deployments/9')).toBeNull()
  expect(fleetRequestUrl('POST', '/api/github/manifest')).toBeNull()
  expect(fleetRequestUrl('GET', '/api/users')).toBeNull()
  expect(fleetRequestUrl('PUT', '/api/system/whatever')).toBeNull()
  expect(fleetRequestUrl('GET', '/api/github/setup')).toBeNull()
  expect(fleetRequestUrl('GET', '/api/github/webhook-deliveries')).toBeNull()
  expect(fleetRequestUrl('POST', '/api/settings')).toBeNull()
  expect(fleetRequestUrl('PUT', '/api/users/1')).toBeNull()
  // phase 4: its admin pages
  expect(fleetRequestUrl('GET', '/api/settings')).toBeTruthy()
  expect(fleetRequestUrl('PUT', '/api/settings')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/settings/notify/test')).toBeTruthy()
  expect(fleetRequestUrl('PUT', '/api/proxy')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/proxy/apply')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/system/pm2/skeppa-proxy/restart')).toBeTruthy()
  expect(fleetRequestUrl('GET', '/api/system/containers/skeppa-app-web/logs/previous?lines=50')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/system/pm2/a%2Fb/restart')).toBeNull()
  expect(fleetRequestUrl('POST', '/api/images/3/build')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/images/prune')).toBeTruthy()
  expect(fleetRequestUrl('POST', '/api/images/3/../../users')).toBeNull()
  expect(fleetRequestUrl('GET', '/api/projects/1/../../users')).toBeNull()
  expect(fleetRequestUrl('GET', '/api/projects/1/%2e%2e/%2e%2e/users')).toBeNull()
  expect(fleetRequestUrl('GET', '//evil.example/api/projects')).toBeNull()
  expect(fleetRequestUrl('GET', 'http://evil.example/api/projects')).toBeNull()
  expect(fleetRequestUrl('TRACE', '/api/projects')).toBeNull()
})

test("the master deploys, reads and edits a project on the agent, as the agent's admin", async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  const relay = (path, init) => m.api(`/api/nodes/${id}/api/${path}`, init)

  const deploy = await relay('projects/1/deploy', { method: 'POST', body: '{}' })
  expect(deploy.status).toBe(202)
  expect(await deploy.json()).toEqual({ id: 501 })
  expect(a.enqueued).toEqual([{ id: 1, trigger: 'manual' }])

  const history = await (await relay('projects/1/deployments')).json()
  expect(history.map(d => d.status)).toEqual(['success'])

  const renamed = await relay('projects/2', { method: 'PATCH', body: JSON.stringify({ name: 'API' }) })
  expect(renamed.status).toBe(200)
  // …and the change comes back the way every change does: live
  await until(() => m.links.get(`node-${id}`).state.projects[2].info.name === 'API')

  // the agent's own validation answers, with its status and fields
  const bad = await relay('projects/1/deploy', { method: 'POST', body: JSON.stringify({ sha: 'nope' }) })
  expect(bad.status).toBe(400)
  expect((await bad.json()).fields.sha).toBeTruthy()
  expect((await relay('projects/99')).status).toBe(404)
})

test('what is not a fleet path is refused by the agent, whatever the master asks', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  for (const [method, path] of [['GET', 'users'], ['POST', 'users'], ['GET', 'github/setup'], ['POST', 'github/manifest'], ['GET', 'system']]) {
    const res = await m.api(`/api/nodes/${id}/api/${path}`, { method, body: method === 'GET' ? undefined : '{}' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/not through the fleet/)
  }
  await expect(m.links.call(id, 'request', { method: 'GET', path: '/api/projects/1/../../users' })).rejects.toMatchObject({ code: 'forbidden' })
})

test("a download is relayed with this panel's own safe headers, never the agent's", async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  const fake = new Hono()
  fake.get('/api/projects/1/files/raw', () => new Response('<script>alert(1)</script>', {
    headers: { 'content-type': 'text/html', 'content-disposition': 'inline', 'set-cookie': 'x=1' },
  }))
  fake.get('/api/projects/2/files/raw', () => new Response(new Uint8Array([0, 1, 2, 255]), {
    headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="a.bin"' },
  }))
  connect(m, a, key, { fleetApi: fake })
  await until(() => m.links.isOnline(id))
  const evil = await m.api(`/api/nodes/${id}/api/projects/1/files/raw?path=x`)
  expect(evil.headers.get('content-type')).toBe('application/octet-stream')
  expect(evil.headers.get('content-disposition')).toBe('attachment')
  expect(evil.headers.get('content-security-policy')).toBe('sandbox')
  expect(evil.headers.get('x-content-type-options')).toBe('nosniff')
  expect(evil.headers.get('set-cookie')).toBeNull()
  const bin = await m.api(`/api/nodes/${id}/api/projects/2/files/raw?path=a.bin`)
  expect(bin.headers.get('content-disposition')).toBe('attachment; filename="a.bin"')
  expect([...new Uint8Array(await bin.arrayBuffer())]).toEqual([0, 1, 2, 255])
})

test('an agent with no admin takes no requests', async () => {
  const a = agent()
  a.db.query("UPDATE users SET role = 'tenant', handle = 'ops'").run()
  const res = await METHODS.request({ method: 'GET', path: '/api/projects' }, { fleetApi: a.fleetApi })
  expect(res.status).toBe(503)
})

// --- phase 3: the master's webhooks and GitHub App, for its agents ----------

const SHA = 'f'.repeat(40)
const push = (repo, branch = 'main', after = SHA) => pushSlice({
  repository: { full_name: repo }, ref: `refs/heads/${branch}`, after,
  head_commit: { message: 'feat: x\n\nlong body', timestamp: '2026-11-25T10:00:00Z' },
  sender: { login: 'someone' }, pusher: { email: 'a@b.c' }, commits: [{ id: 1 }],
})

test('a push slice keeps only what an agent needs', () => {
  expect(push('ops/web')).toEqual({
    repository: { full_name: 'ops/web' }, ref: 'refs/heads/main', after: SHA, deleted: false,
    head_commit: { message: 'feat: x', timestamp: '2026-11-25T10:00:00Z' },
  })
})

test("a push for an agent's repo reaches it: the head moves, and an auto-deploy sets sail there", async () => {
  const m = master()
  const a = agent()
  a.db.query('UPDATE projects SET auto_deploy = 1 WHERE id = 1').run()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => Object.keys(m.links.get(`node-${id}`).state.projects).length === 2)

  expect(m.links.forwardPush(push('ops/web'))).toBe(1)
  await until(() => a.liveState.projects[1].headCommit?.sha === SHA)
  await until(() => a.enqueued.length === 1)
  expect(a.enqueued[0]).toMatchObject({ id: 1, trigger: 'webhook', commitSha: SHA, commitMessage: 'feat: x' })
  expect(a.db.query('SELECT head_sha FROM projects WHERE id = 1').get().head_sha).toBe(SHA)
  // …and the moved head comes back to the master, live
  await until(() => m.links.get(`node-${id}`).state.projects[1].headCommit?.sha === SHA)

  expect(m.links.forwardPush(push('someone/else'))).toBe(0) // not that server's
  expect(m.links.forwardPush(push('OPS/API', 'dev'))).toBe(1) // that repo, another branch: heard, ignored there
  await wait(50)
  expect(a.enqueued.length).toBe(1)
})

test('a push while the agent is away waits for it — the latest per branch', async () => {
  const m = master()
  const a = agent()
  a.db.query('UPDATE projects SET auto_deploy = 1').run()
  const { id, key } = await pair(m)
  const uplink = connect(m, a, key)
  await until(() => Object.keys(m.links.get(`node-${id}`).state.projects).length === 2)
  uplink.stop()
  await until(() => !m.links.isOnline(id))
  m.links.forwardPush(push('ops/web', 'main', 'a'.repeat(40)))
  m.links.forwardPush(push('ops/web', 'main', 'b'.repeat(40)))
  m.links.forwardPush(push('ops/api', 'main', 'c'.repeat(40)))
  uplink.start()
  await until(() => a.enqueued.length === 2)
  expect(a.enqueued.map(e => e.commitSha).sort()).toEqual(['b'.repeat(40), 'c'.repeat(40)])
})

test('the agent takes only well-formed pushes', () => {
  const a = agent()
  const ctx = { db: a.db, liveState: a.liveState, runner: a.runner }
  expect(() => METHODS.push({ repository: { full_name: '../x' }, ref: 'refs/heads/main' }, ctx)).toThrow(/owner\/name/)
  expect(() => METHODS.push({ repository: { full_name: 'ops/web' }, ref: 'main' }, ctx)).toThrow(/git ref/)
  expect(() => METHODS.push({ repository: { full_name: 'ops/web' }, ref: 'refs/heads/main', after: 'nope' }, ctx)).toThrow(/sha/)
})

test("an agent without a GitHub App borrows the master's: a read-only token for one of its repos, nothing more", async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => Object.keys(m.links.get(`node-${id}`).state.projects).length === 2)
  expect(a.github.ownApp()).toBe(false)
  expect(a.github.isConfigured()).toBe(true)

  expect(await a.github.getInstallationToken('ops/web')).toBe('tok-ops/web')
  expect(await a.github.getInstallationToken('ops/web')).toBe('tok-ops/web')
  expect(m.minted).toEqual(['ops/web']) // lent once, then cached there
  await expect(a.github.getInstallationToken('someone/private')).rejects.toMatchObject({ code: 'forbidden' })
  await expect(a.github.getInstallationToken(null)).rejects.toThrow(/no repo/)
  await expect(a.github.getInstallationToken('not a repo')).rejects.toMatchObject({ code: 'bad-request' })

  // the admin asking about a repo there, through the relay, lets its token follow
  await m.api(`/api/nodes/${id}/api/github/repos/branches?repo=someone/private`)
  expect(await a.github.getInstallationToken('someone/private')).toBe('tok-someone/private')
  expect(m.links.mayUseRepo(id, 'someone/other')).toBe(false)

  expect(await a.github.getRepoInstallation('ops/web')).toEqual({ id: 9, account: 'ops' })
  expect(await a.github.listRepos('ops')).toEqual([{ full_name: 'ops/web', owner: 'ops', account: 'ops' }])
  expect(await a.github.appOwnerLogin()).toBe('ops')
  await expect(a.github.listWebhookDeliveries()).rejects.toThrow(/GitHub App of the master/)
})

test('the master answers nothing it does not know, and nothing without an App', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  const uplink = connect(m, a, key)
  await until(() => m.links.isOnline(id))
  await expect(uplink.ask('shell', {})).rejects.toMatchObject({ code: 'unknown-method' })
  m.github.isConfigured = () => false
  await expect(uplink.ask('githubRepos', {})).rejects.toMatchObject({ code: 'unavailable' })
  uplink.stop()
  await expect(uplink.ask('githubRepos', {})).rejects.toMatchObject({ code: 'offline' })
})

test('a scoped token asks GitHub for one repository and contents: read, and is cached', async () => {
  const db = freshDb()
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/repos/ops/web/installation')) return new Response(JSON.stringify({ id: 42, account: { login: 'ops' } }))
    return new Response(JSON.stringify({ token: 'ghs_scoped', expires_at: new Date(Date.now() + 3_600_000).toISOString() }))
  }
  const gh = new GitHubApp({ db, config: { masterKey: 'a'.repeat(64) }, fetchFn })
  gh._appJwt = async () => 'jwt'
  expect((await gh.getScopedToken('ops/web')).token).toBe('ghs_scoped')
  expect((await gh.getScopedToken('ops/web')).token).toBe('ghs_scoped')
  const minted = calls.filter(c => c.url.endsWith('/access_tokens'))
  expect(minted).toHaveLength(1)
  expect(minted[0].url).toBe('https://api.github.com/app/installations/42/access_tokens')
  expect(JSON.parse(minted[0].init.body)).toEqual({ repositories: ['web'], permissions: { contents: 'read' } })
})

// --- phase 4: its admin pages through the master; its own UI off ------------

test("the master reads and sets an agent's notifications through its own settings route", async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.links.isOnline(id))
  const before = await (await m.api(`/api/nodes/${id}/api/settings`)).json()
  expect(before.has_notify_url).toBe(false)
  const res = await m.api(`/api/nodes/${id}/api/settings`, { method: 'PUT', body: JSON.stringify({ notify_url: 'https://hooks.example.com/x' }) })
  expect(res.status).toBe(200)
  const after = await (await m.api(`/api/nodes/${id}/api/settings`)).json()
  expect(after.has_notify_url).toBe(true)
  expect(after.notify_url_host).toBe('hooks.example.com')
})

test("an agent's own panel is off unless AGENT_LOCAL_UI says so; its webhook route stays", async () => {
  const { createApp, hasLocalUi } = await import('../src/app.js')
  const db = freshDb()
  const deps = { db, liveState: createLiveState(), runner: { enqueue() {} }, github: null, poller: null, proxy: null }
  const base = { masterKey: 'c'.repeat(64), webDist: '/nonexistent', isSecureCookie: false }
  expect(hasLocalUi(base)).toBe(true)
  expect(hasLocalUi({ ...base, masterUrl: 'https://m.example' })).toBe(false)
  expect(hasLocalUi({ ...base, masterUrl: 'https://m.example', agentLocalUi: true })).toBe(true)

  const agentApp = createApp({ ...deps, config: { ...base, masterUrl: 'https://m.example' } })
  for (const path of ['/api/projects', '/api/auth/me', '/', '/fleet']) {
    const res = await agentApp.request(path)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('run from its master, https://m.example')
  }
  const login = await agentApp.request('/api/auth/login', { method: 'POST', body: '{}' })
  expect(login.status).toBe(404)
  // the webhook route answers as itself (no secret configured here: 503)
  expect((await agentApp.request('/api/webhooks/github', { method: 'POST', body: '{}' })).status).toBe(503)

  const withUi = createApp({ ...deps, config: { ...base, masterUrl: 'https://m.example', agentLocalUi: true } })
  expect((await withUi.request('/api/projects')).status).toBe(401) // its own panel, behind sign-in as ever
})

// Mooring on a node: the agent says who the master acts as there, and a
// project POSTed through the relay is that admin's, with its repo's token
// granted for the first deploy.
test('a project moored through the master lands on the agent, as its admin, and may fetch its repo', async () => {
  const m = master()
  const a = agent()
  const { id, key } = await pair(m)
  connect(m, a, key)
  await until(() => m.liveState.nodes[id]?.adminId === 1)
  const res = await m.api(`/api/nodes/${id}/api/projects`, {
    method: 'POST',
    body: JSON.stringify({ name: 'shop', repo_full_name: 'ops/shop', branch: 'main', runtime: 'container', start_command: 'bun start' }),
  })
  expect(res.status).toBe(201)
  const created = await res.json()
  const row = a.db.query('SELECT * FROM projects WHERE id = ?').get(created.id)
  expect(row).toMatchObject({ name: 'shop', repo_full_name: 'ops/shop', owner_id: 1 })
  await until(() => m.links.get(`node-${id}`).state.projects[created.id]?.info?.name === 'shop')
  expect(m.links.mayUseRepo(id, 'ops/shop')).toBe(true)
  expect(await a.github.getInstallationToken('ops/shop')).toBe('tok-ops/shop')
})

// --- a server away, and this panel restarting ---------------------------------

test('a paired server away for a while is said once, and again when it is back', async () => {
  const downs = []
  const ups = []
  const m = master({ offlineAlertMs: 80, onNodeDown: row => downs.push(row.name), onNodeUp: (row, ms) => ups.push([row.name, ms]) })
  const a = agent()
  const { id, key } = await pair(m)
  const uplink = connect(m, a, key)
  await until(() => m.links.isOnline(id))
  await wait(120)
  expect(downs).toEqual([]) // online: nothing to say
  uplink.stop()
  await until(() => downs.length === 1)
  await wait(150)
  expect(downs).toEqual(['hemma-2']) // once per absence
  uplink.start()
  await until(() => ups.length === 1)
  expect(ups[0][0]).toBe('hemma-2')
  expect(ups[0][1]).toBeGreaterThanOrEqual(80)

  // a short drop (a deploy of the agent's own panel) says nothing at all
  uplink.stop()
  await wait(20)
  uplink.start()
  await until(() => m.links.isOnline(id))
  await wait(120)
  expect(downs).toHaveLength(1)
  expect(ups).toHaveLength(1)
})

test('an unpaired server is not missed', async () => {
  const downs = []
  const m = master({ offlineAlertMs: 40, onNodeDown: row => downs.push(row.name) })
  await m.api('/api/nodes', { method: 'POST', body: JSON.stringify({ name: 'never-joined' }) })
  await wait(100)
  expect(downs).toEqual([])
})

test('what a server last reported survives a restart here, and what it removed meanwhile goes when it is back', async () => {
  const { sqliteStorage } = await import('lazy-storage/server/sqlite')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-fleet-'))
  const storage = sqliteStorage(join(dir, 'fleet-mirror.sqlite'), { lease: false })
  cleanups.unshift(() => {
    try { storage.close?.() } catch { /* already closed */ }
    // Windows may still hold the file for a moment: a temp dir left behind is harmless
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* left for the OS */ }
  })

  const m1 = master({ storage })
  const a = agent()
  a.db.query('UPDATE projects SET auto_deploy = 1').run()
  const { id, key } = await pair(m1)
  const uplink = connect(m1, a, key)
  await until(() => Object.keys(m1.links.get(`node-${id}`).state.projects).length === 2)
  uplink.stop()
  m1.links.dispose() // this panel goes down…
  await wait(20)

  delete a.liveState.projects[1] // …and meanwhile the agent scuttles a project

  const m2 = master({ db: m1.db, storage }) // …and this panel comes back, the agent still away
  const kept = m2.links.get(`node-${id}`).state.projects
  expect(Object.keys(kept).sort()).toEqual(['1', '2']) // what it last reported, before it dials in
  // a push for one of its repos is kept for it, though it has not dialled in yet
  expect(m2.links.forwardPush(push('ops/api'))).toBe(1)

  const back = createUplink({
    masterUrl: m2.url, key, db: a.db, liveStores: a.stores, fleetApi: a.fleetApi, runner: a.runner,
    liveState: a.liveState, github: a.github, log: () => {}, onError: () => {}, backoff: { min: 20, max: 100 },
  })
  a.link.uplink = back
  back.start()
  cleanups.push(() => back.stop())
  await until(() => m2.links.get(`node-${id}`).state.projects[1] === undefined)
  expect(Object.keys(m2.links.get(`node-${id}`).state.projects)).toEqual(['2'])
  await until(() => a.enqueued.some(e => e.commitSha === SHA))

  m2.links.remove(id) // removing it takes the kept copy along
  expect(storage.ids()).not.toContain(`node-${id}`)
})
