import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { LazyWatch } from 'lazy-watch'
import { createHub } from 'lazy-storage/server'
import { assertModel, registerSet } from 'lazy-storage/core'
import { createNetwork } from 'lazy-storage/testing'
import { migrate } from '../src/db/migrate.js'
import { createLiveState, initLiveState, projectDefaults, getProjectInfo } from '../src/live/state.js'
import { createLiveStores, canOpenStore, FLEET_REGISTERS, PANEL_REGISTERS } from '../src/live/stores.js'

// LiveState served as lazy-storage stores (live/stores.js): the layout that
// replaces the Hub's per-socket scoping, and the bridge that keeps the
// stores equal to what the poller and the routes write to LiveState.

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const tick = () => new Promise(r => setTimeout(r, 0))
const wait = ms => new Promise(r => setTimeout(r, ms))

function setup(options = {}) {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('cap', 'x', 'admin')").run()
  db.query("INSERT INTO users (username, password_hash, role, handle) VALUES ('bob', 'x', 'tenant', 'bob')").run()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port)
            VALUES ('adm', 'Adm', 1, 'cap/adm', 'main', 'adm', 'container', 'bun start', 4101)`).run()
  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port)
            VALUES ('bobapp', 'BobApp', 2, 'bobgh/app', 'main', 'bobapp', 'container', 'bun start', 4102)`).run()
  const liveState = createLiveState()
  initLiveState(liveState, db, {})
  liveState.system = { appsDir: '/apps', loadavg: [0.1, 0.2, 0.3], containers: {}, pm2: {} }
  const errors = []
  const live = createLiveStores({ liveState, onError: err => errors.push(err.message), ...options })
  const admin = { id: 1, role: 'admin' }
  const bob = { id: 2, role: 'tenant' }
  return { db, liveState, live, errors, admin, bob }
}

test('stores are laid out per owner and seeded from LiveState, nulls left out', () => {
  const { live, errors } = setup()
  expect(live.ids().sort()).toEqual(['fleet-1', 'fleet-2', 'harbor', 'panel'])
  const fleet1 = live.get('fleet-1').state
  const fleet2 = live.get('fleet-2').state
  expect(Object.keys(fleet1.projects)).toEqual(['1'])
  expect(Object.keys(fleet2.projects)).toEqual(['2'])
  expect(fleet2.projects[2].info.slug).toBe('bobapp')
  // projectDefaults' nulls mean "unknown"; a mirror reads an absent key the same
  expect('headCommit' in fleet1.projects[1]).toBe(false)
  expect(fleet1.projects[1].pm2.status).toBe('unknown')
  const panel = live.get('panel').state
  expect(Object.keys(panel.users).sort()).toEqual(['1', '2'])
  expect(panel.system.loadavg).toEqual([0.1, 0.2, 0.3])
  expect(live.get('harbor').state.proxy).toEqual({ baseDomain: '' })
  expect(errors).toEqual([])
})

test('a change reaches its owner\'s fleet and no other store', async () => {
  const { liveState, live } = setup()
  const before = Object.fromEntries(live.ids().map(id => [id, live.get(id).version]))
  liveState.projects[2].pm2.status = 'online'
  liveState.projects[2].headCommit = { sha: 'b'.repeat(40), message: 'feat', pushedAt: '2026-09-07T00:00:00Z' }
  await tick()
  expect(live.get('fleet-2').state.projects[2].pm2.status).toBe('online')
  expect(live.get('fleet-2').state.projects[2].headCommit.message).toBe('feat')
  expect(live.get('fleet-2').version).toBeGreaterThan(before['fleet-2'])
  for (const id of ['fleet-1', 'panel', 'harbor']) expect(live.get(id).version).toBe(before[id])
})

test('a deletion reaches the fleet that had the project', async () => {
  const { liveState, live } = setup()
  delete liveState.projects[2]
  await tick()
  expect(live.get('fleet-2').state.projects[2]).toBeUndefined()
  expect(Object.keys(live.get('fleet-1').state.projects)).toEqual(['1'])
})

test('the deployment tail travels as a whole array, however LiveState edits it', async () => {
  const { liveState, live } = setup()
  const entry = i => ({ id: i, status: 'success', trigger: 'manual', commitSha: null, startedAt: null, finishedAt: null, createdAt: 'x' })
  liveState.projects[1].recentDeployments = [entry(2), entry(1)]
  await tick()
  liveState.projects[1].recentDeployments.unshift(entry(3)) // a $splice op on the wire
  await tick()
  const tail = live.get('fleet-1').state.projects[1].recentDeployments
  expect(Array.isArray(tail)).toBe(true)
  expect(tail.map(d => d.id)).toEqual([3, 2, 1])
})

test('a record recreated under a deleted key lands (containers come and go on every deploy)', async () => {
  const { liveState, live, errors } = setup()
  liveState.system.containers['skeppa-app-adm'] = { state: 'running', image: 'i', ports: ['4101->3000/tcp'] }
  await tick()
  delete liveState.system.containers['skeppa-app-adm']
  await tick()
  liveState.system.containers['skeppa-app-adm'] = { state: 'created', image: 'i', ports: [] }
  await tick()
  expect(live.get('panel').state.system.containers['skeppa-app-adm'].state).toBe('created')

  // The same within one millisecond, as two batches
  delete liveState.system.containers['skeppa-app-adm']
  LazyWatch.flush(liveState)
  liveState.system.containers['skeppa-app-adm'] = { state: 'running', image: 'i', ports: [] }
  LazyWatch.flush(liveState)
  await wait(30)
  expect(live.get('panel').state.system.containers['skeppa-app-adm'].state).toBe('running')
  expect(errors).toEqual([])
})

test('fleets follow the crew', async () => {
  const { liveState, live } = setup()
  liveState.users[3] = { id: 3, username: 'eve', role: 'tenant', handle: 'eve', created_at: 'x' }
  await tick()
  expect(live.get('fleet-3')).not.toBeNull()
  expect(live.get('panel').state.users[3].username).toBe('eve')
  delete liveState.users[3]
  await tick()
  expect(live.get('fleet-3')).toBeNull()
})

test('who may open what', () => {
  const admin = { id: 1, role: 'admin' }
  const bob = { id: 2, role: 'tenant' }
  expect(canOpenStore(admin, 'panel')).toBe(true)
  expect(canOpenStore(admin, 'fleet-2')).toBe(true)
  expect(canOpenStore(admin, 'harbor')).toBe(true)
  expect(canOpenStore(bob, 'fleet-2')).toBe(true)
  expect(canOpenStore(bob, 'harbor')).toBe(true)
  expect(canOpenStore(bob, 'fleet-1')).toBe(false)
  expect(canOpenStore(bob, 'panel')).toBe(false)
  expect(canOpenStore(bob, 'fleet-2x')).toBe(false)
  expect(canOpenStore(null, 'harbor')).toBe(false)
})

test('every array of records LiveState carries is a declared register', () => {
  const { liveState } = setup()
  liveState.system.containers.x = { state: 'running', image: 'i', ports: ['4101->3000/tcp'] }
  liveState.images.local = [{ id: 'sha', tags: ['a:1'], size: 1, createdAt: 'x', managed: false }]
  liveState.images.managed = [{ name: 'n', ref: 'r', used_by: [] }]
  liveState.projects[1].recentDeployments = [{ id: 1, status: 'success' }]
  const regs = registerSet([...FLEET_REGISTERS, ...PANEL_REGISTERS])
  // the library's own model check: throws on an undeclared array of objects
  expect(() => assertModel(LazyWatch.snapshot(liveState), regs)).not.toThrow()
  expect(() => assertModel({ projects: { 1: { recentDeployments: [{ id: 1 }] } } }, registerSet([]))).toThrow()
})

// Through lazy-storage's own hub and an in-memory network: what a browser
// will see once the frontend opens stores instead of /ws.
test('a tenant mirror follows its own fleet, is refused the rest, and cannot write', async () => {
  const { liveState, live, bob } = setup()
  const net = createNetwork({
    session: ({ send, user }) => createHub(id => live.get(id), { send, user, authorize: live.canOpen }),
  })
  const mirror = opts => ({ initial: { projects: {} }, undo: false, presence: false, ...opts })
  const mine = net.client(mirror({ store: 'fleet-2', registers: FLEET_REGISTERS }), { user: bob })
  const theirs = net.client(mirror({ store: 'fleet-1', registers: FLEET_REGISTERS }), { user: bob })
  const panel = net.client(mirror({ store: 'panel', initial: {}, registers: PANEL_REGISTERS }), { user: bob })
  const harbor = net.client(mirror({ store: 'harbor', initial: { proxy: {} }, registers: [] }), { user: bob })
  await net.settle()

  expect(Object.keys(mine.state.projects)).toEqual(['2'])
  expect(mine.state.projects[2].info.slug).toBe('bobapp')
  expect(theirs.closed?.code).toBe('forbidden')
  expect(panel.closed?.code).toBe('forbidden')
  expect(harbor.state.proxy.baseDomain).toBe('')

  // live: a poller write lands in the mirror
  liveState.projects[2].pm2.status = 'online'
  await net.settle()
  expect(mine.state.projects[2].pm2.status).toBe('online')
  expect(live.sessions).toBe(2) // fleet-2 and harbor; refused stores hold no session

  // read-only: a client edit is refused and the mirror falls back in line
  const refused = []
  mine.on('error', err => refused.push(err.code))
  mine.state.projects[2].pm2.status = 'hacked'
  await net.settle()
  expect(refused).toEqual(['forbidden'])
  expect(mine.state.projects[2].pm2.status).toBe('online')
  expect(live.get('fleet-2').state.projects[2].pm2.status).toBe('online')
})

test('a running deployment is a store: owner-gated, the backlog on open, lines as they come, evicted at the end', async () => {
  const { db, live, admin, bob } = setup({
    // wired exactly as index.js wires it
    canReadDeployment: (user, deploymentId) => {
      if (user.role === 'admin') return true
      const row = db.query('SELECT p.owner_id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.id = ?').get(deploymentId)
      return row?.owner_id === user.id
    },
  })
  db.query(`INSERT INTO deployments (project_id, "trigger", log) VALUES (1, 'manual', '')`).run() // admin's, id 1
  db.query(`INSERT INTO deployments (project_id, "trigger", log) VALUES (2, 'manual', '')`).run() // bob's, id 2
  live.openLog(1)
  live.appendLog(1, 'ADMIN_SECRET=x')
  live.openLog(2)
  live.appendLog(2, 'first')

  const net = createNetwork({
    session: ({ send, user }) => createHub(id => live.get(id), { send, user, authorize: live.canOpen }),
  })
  const follow = (store, user) => net.client({ store, initial: { lines: {} }, undo: false, presence: false }, { user })
  const theirs = follow('deploy-1', bob)
  const mine = follow('deploy-2', bob)
  const admins = follow('deploy-1', admin)
  await net.settle()
  expect(theirs.closed?.code).toBe('forbidden') // not his
  expect(Object.values(mine.state.lines)).toEqual(['first']) // the backlog is the snapshot
  expect(Object.values(admins.state.lines)).toEqual(['ADMIN_SECRET=x'])

  live.appendLog(2, 'second')
  await net.settle()
  const inOrder = client => Object.keys(client.state.lines).sort().map(k => client.state.lines[k])
  expect(inOrder(mine)).toEqual(['first', 'second'])

  live.closeLog(2)
  await net.settle()
  expect(mine.closed?.code).toBe('evicted')
  expect(live.get('deploy-2')).toBeNull()
  expect(live.get('deploy-1')).not.toBeNull()
  live.appendLog(2, 'late') // nothing to write to; no throw
  expect(live.canOpen(null, 'deploy-1')).toBe(false)
})

test('the admin opens every fleet; a project created later shows up in the right one', async () => {
  const { db, liveState, live, admin } = setup()
  const net = createNetwork({
    session: ({ send, user }) => createHub(id => live.get(id), { send, user, authorize: live.canOpen }),
  })
  const open = store => net.client({ store, initial: { projects: {} }, registers: FLEET_REGISTERS, undo: false, presence: false }, { user: admin })
  const fleet1 = open('fleet-1')
  const fleet2 = open('fleet-2')
  await net.settle()
  expect(Object.keys(fleet1.state.projects)).toEqual(['1'])
  expect(Object.keys(fleet2.state.projects)).toEqual(['2'])

  db.query(`INSERT INTO projects (slug, name, owner_id, repo_full_name, branch, pm2_name, runtime, start_command, port)
            VALUES ('bob2', 'Bob2', 2, 'bobgh/two', 'main', 'bob2', 'container', 'bun start', 4103)`).run()
  liveState.projects[3] = projectDefaults(null, getProjectInfo(db, 3))
  await net.settle()
  expect(Object.keys(fleet2.state.projects).sort()).toEqual(['2', '3'])
  expect(Object.keys(fleet1.state.projects)).toEqual(['1'])
})
