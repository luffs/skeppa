import { LazyWatch } from 'lazy-watch'
import { createStore } from 'lazy-storage/server'
import { valueAt } from 'lazy-storage/core'

// LiveState, served as lazy-storage stores.
//
// lazy-storage has no per-user read filter inside a store: `authorize`
// decides who may open one, and every session on it then receives every
// patch. So the Hub's per-socket scoping becomes store layout:
//
//   panel          system, users, images    admins
//   fleet-<owner>  that owner's projects    the owner, or an admin
//                  and piers (groups)
//   harbor         proxy (the base domain)  any signed-in user
//
// The panel's nodes (other Skeppa servers reporting here, nodes/links.js)
// ride in `panel` as a collection; what each one reports is a store of its
// own, `node-<id>`, kept by the node links, not by this bridge. On an agent
// the bridge feeds one more store, `uplink` — every project, pier, the proxy
// and the system record, unfiltered — which no browser may open: only the
// master's link reads it (agent/uplink.js).
//
// Nothing here writes LiveState. The poller, the runner and the routes keep
// writing the LiveState proxy; the bridge below forwards each lazy-watch
// batch to the stores it belongs to, so the writers never learn that stores
// exist. Clients are read-only mirrors — `validate` refuses every client op.
//
// A running deployment's log is a store of its own:
//
//   deploy-<id>    { lines: { <zero-padded seq>: line } }    canReadDeployment
//
// opened by the runner's LogCollector (openLog / appendLog / closeLog).
// Opening it delivers the backlog as the snapshot, a reconnect gets a delta,
// and the store is evicted when the deploy finishes — the stored log is on
// the API from then on. Deploy logs echo ENV values, so who may open one is
// the caller's rule (index.js: admins, or the project's owner).

// A store is collections of records and singletons, and both sides declare
// the same top level or the server answers `shape-mismatch`. `users` and
// `projects` are collections — records keyed by id, added and deleted on
// their own; so are a fleet's `groups` (piers), which travel with the
// projects they hold. `system`, `images`, `proxy` and a deploy log's `lines` are one
// record each: a bag of fields, not a keyed set, and `lines` could not be a
// collection at all since its values are strings. The client declares the
// same (web/src/live.js) — arrays need no declaration of their own, an array
// being a leaf written whole.
export const STORE_SHAPES = {
  panel: { initial: { system: {}, users: {}, images: {}, nodes: {} }, singletons: ['system', 'images'] },
  harbor: { initial: { proxy: {} }, singletons: ['proxy'] },
  fleet: { initial: { projects: {}, groups: {} }, singletons: [] },
  deploy: { initial: { lines: {} }, singletons: ['lines'] },
  // What an agent reports (its `uplink`), and the same again as the
  // master's `node-<id>`: every project and pier on that server, its proxy,
  // its system record and its images (the Shipyard's, for the project form).
  node: { initial: { projects: {}, groups: {}, proxy: {}, system: {}, images: {} }, singletons: ['proxy', 'system', 'images'] },
}

export const UPLINK_ID = 'uplink'

const FLEET_ID = /^fleet-\d+$/
const DEPLOY_ID = /^deploy-(\d+)$/
export const fleetId = ownerId => `fleet-${ownerId}`
export const deployStoreId = deploymentId => `deploy-${deploymentId}`

// The rule for the live-state stores; deploy logs are the caller's (below).
export function canOpenStore(user, id) {
  if (!user) return false
  if (id === 'harbor') return true
  if (user.role === 'admin') return id === 'panel' || FLEET_ID.test(id)
  return id === fleetId(user.id)
}

// lazy-watch records an array edit as a fragment (a `$splice`, a length, a
// handful of indices) and a store takes an array whole, so every array goes
// in as it stands: a store's tree is a subtree of `root` at the same paths,
// so wherever the live value is an array it replaces what the diff holds
// there, and how the source edited it stops mattering at the wire. `root` is
// LiveState here, and an upstream mirror's state in nodes/links.js.
export function wholeArraysOf(root, diff, path = []) {
  if (diff === null || typeof diff !== 'object') return diff
  const live = valueAt(root, path)
  if (Array.isArray(live)) return LazyWatch.isProxy(live) ? LazyWatch.snapshot(live) : structuredClone(live)
  if (Array.isArray(diff)) return diff // already whole, with nothing live behind it
  const out = {}
  for (const [key, value] of Object.entries(diff)) out[key] = wholeArraysOf(root, value, [...path, key])
  return out
}

// `storage`: a lazy-storage adapter (sqliteStorage(file).store(id)) for a
// mirror that should outlive the process — a Fleet node's (nodes/links.js);
// in memory otherwise.
export function mirrorStore(shape, { storage } = {}) {
  return createStore({
    ...shape,
    ...(storage ? { storage } : {}),
    readOnly: true, // clients only read; an op a client sends is refused and it resyncs
    rateLimit: false,
  })
}

// Nulls in LiveState mean "unknown" at boot (projectDefaults). Sent as a
// seed they would become tombstones for keys that were never there; to a
// mirror an absent key and a null read the same, so they are left out.
function withoutNulls(node) {
  if (Array.isArray(node) || node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (value !== null) out[key] = withoutNulls(value)
  }
  return out
}

export function createLiveStores({
  liveState,
  canReadDeployment = () => false,
  onError = err => console.error('[live]', err?.message ?? err),
  onSessionsChange = () => {},
  uplink = false,
}) {
  const stores = new Map()
  const logs = new Map() // deploymentId -> { store, seq }
  // Last known owner per project id: a deletion diff arrives after the
  // project is gone from state, and it still has to reach its owner's fleet.
  const owners = new Map()
  let sessions = 0

  function add(id, store) {
    store.observe('session', () => {
      // The master reading the uplink is not someone looking: it says when
      // someone is (agent/uplink.js `watch`), and the poller follows that.
      let total = 0
      for (const [sid, s] of stores) if (sid !== UPLINK_ID) total += s.sessions
      if (total !== sessions) onSessionsChange((sessions = total))
    })
    stores.set(id, store)
    return store
  }
  add('panel', mirrorStore(STORE_SHAPES.panel))
  add('harbor', mirrorStore(STORE_SHAPES.harbor))
  if (uplink) add(UPLINK_ID, mirrorStore(STORE_SHAPES.node))

  const ensureFleet = ownerId =>
    stores.get(fleetId(ownerId)) ?? add(fleetId(ownerId), mirrorStore(STORE_SHAPES.fleet))

  function dropFleet(ownerId) {
    const store = stores.get(fleetId(ownerId))
    if (!store) return
    stores.delete(fleetId(ownerId))
    store.dispose() // its sessions close; the sockets stay up for their other stores
  }

  // The same for piers, whose owner never changes (a Crew move takes the
  // projects out of their piers instead).
  const groupOwners = new Map()

  const ownerOf = id => liveState.projects?.[id]?.info?.owner_id ?? owners.get(String(id)) ?? null
  const groupOwnerOf = id => liveState.groups?.[id]?.owner_id ?? groupOwners.get(String(id)) ?? null

  function rememberOwners() {
    for (const [id, live] of Object.entries(liveState.projects ?? {})) {
      if (live?.info?.owner_id != null) owners.set(id, live.info.owner_id)
    }
    for (const [id, group] of Object.entries(liveState.groups ?? {})) {
      if (group?.owner_id != null) groupOwners.set(id, group.owner_id)
    }
  }

  // Every store's tree is a subtree of LiveState at the same paths, so the
  // live value for any store path is read straight off the proxy.
  const current = path => {
    const value = valueAt(liveState, path)
    if (value === undefined) return null
    return LazyWatch.isProxy(value) ? LazyWatch.snapshot(value) : value
  }

  const wholeArrays = diff => wholeArraysOf(liveState, diff)

  // The server's own write: stamped now and applied without checks, so a
  // record recreated under a deleted key (a container after a deploy, a pm2
  // process started again by hand) lands, and nothing here is ever refused.
  // LiveState is the authority and this only carries it across.
  function write(id, diff) {
    const store = stores.get(id)
    if (!store) return
    try {
      store.patch(wholeArrays(diff))
    } catch (err) {
      onError(new Error(`live store ${id}: ${err.message}`, { cause: err }))
    }
  }

  function route(diff) {
    const { projects, groups, system, users, images, proxy, nodes } = diff
    const fleets = new Map() // owner -> { projects?, groups? }
    const into = (owner, key) => {
      if (!fleets.has(owner)) fleets.set(owner, {})
      const fleet = fleets.get(owner)
      return (fleet[key] ??= {})
    }
    if (projects && typeof projects === 'object') {
      for (const [id, subtree] of Object.entries(projects)) {
        const owner = ownerOf(id)
        if (owner == null) {
          onError(new Error(`project ${id} has no owner — not published to any fleet`))
          continue
        }
        const previous = owners.get(String(id))
        if (subtree !== null && previous != null && String(previous) !== String(owner)) {
          // The project changed hands (a Crew move). This batch only carries
          // the fields that changed, so: the old fleet forgets the project —
          // its owner must stop seeing it the moment it is not theirs — and
          // the new fleet gets all of it.
          into(previous, 'projects')[id] = null
          into(owner, 'projects')[id] = current(['projects', id])
          continue
        }
        into(owner, 'projects')[id] = subtree
      }
    }
    if (groups && typeof groups === 'object') {
      for (const [id, subtree] of Object.entries(groups)) {
        const owner = groupOwnerOf(id)
        if (owner == null) {
          onError(new Error(`pier ${id} has no owner — not published to any fleet`))
          continue
        }
        // A pier removed along with its owner: the fleet is gone already,
        // and must not be brought back just to hear about it.
        if (subtree === null && !stores.has(fleetId(owner))) continue
        into(owner, 'groups')[id] = subtree
      }
    }
    for (const [owner, subtree] of fleets) {
      ensureFleet(owner)
      write(fleetId(owner), subtree)
    }
    const panel = {}
    if (system !== undefined) panel.system = system
    if (users !== undefined) panel.users = users
    if (images !== undefined) panel.images = images
    if (nodes !== undefined) panel.nodes = nodes
    if (Object.keys(panel).length) write('panel', panel)
    if (proxy !== undefined) write('harbor', { proxy })
    if (uplink) {
      // Everything, whoever owns it: the master is this server's admin.
      const up = {}
      if (projects !== undefined) up.projects = projects
      if (groups !== undefined) up.groups = groups
      if (proxy !== undefined) up.proxy = proxy
      if (system !== undefined) up.system = system
      if (images !== undefined) up.images = images
      if (Object.keys(up).length) write(UPLINK_ID, up)
    }
    // Fleets follow the crew: a new user has a store to open before their
    // first project; a deleted user's store closes on their sockets.
    if (users && typeof users === 'object') {
      for (const [id, user] of Object.entries(users)) (user === null ? dropFleet : ensureFleet)(id)
    }
    rememberOwners()
  }

  // Whatever was written to LiveState before this point (boot's
  // initLiveState) is still batched; the snapshot already holds it, so the
  // batch goes to the listeners that exist now rather than reaching this
  // one as a second copy of the seed.
  LazyWatch.flush(liveState)
  for (const id of Object.keys(liveState.users ?? {})) ensureFleet(id)
  route(withoutNulls(LazyWatch.snapshot(liveState)))

  const listener = diff => {
    try {
      route(diff)
    } catch (err) {
      onError(err)
    }
  }
  LazyWatch.on(liveState, listener)

  function canOpen(user, id) {
    const deploy = DEPLOY_ID.exec(id)
    if (deploy) return Boolean(user) && Boolean(canReadDeployment(user, Number(deploy[1])))
    return canOpenStore(user, id)
  }

  // --- deploy logs -----------------------------------------------------------
  function openLog(deploymentId) {
    if (logs.has(deploymentId)) return
    const store = mirrorStore(STORE_SHAPES.deploy)
    add(deployStoreId(deploymentId), store)
    logs.set(deploymentId, { store, seq: 0 })
  }

  // One leaf per line: a patch is the line, a snapshot is the backlog, and
  // keys sort as strings in arrival order.
  function appendLog(deploymentId, line) {
    const log = logs.get(deploymentId)
    if (!log) return
    log.seq += 1
    try {
      log.store.patch({ lines: { [String(log.seq).padStart(7, '0')]: String(line) } })
    } catch (err) {
      onError(new Error(`deploy log ${deploymentId}: ${err.message}`, { cause: err }))
    }
  }

  // Everyone following is told the store is over (the client reads the
  // stored log from the API from here), then the store and its lines go.
  function closeLog(deploymentId) {
    const log = logs.get(deploymentId)
    if (!log) return
    logs.delete(deploymentId)
    stores.delete(deployStoreId(deploymentId))
    log.store.closeSessions(() => true, 'deployment finished')
    log.store.dispose()
  }

  return {
    // The shape createHandlers takes as `stores`: get(id) → store or null
    get: id => stores.get(id) ?? null,
    ids: () => [...stores.keys()],
    canOpen,
    openLog,
    appendLog,
    closeLog,
    get sessions() {
      return sessions
    },
    dispose() {
      LazyWatch.off(liveState, listener)
      for (const store of stores.values()) store.dispose()
      stores.clear()
    },
  }
}
