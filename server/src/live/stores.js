import { LazyWatch } from 'lazy-watch'
import { createStore } from 'lazy-storage/server'
import { expandRegisters, registerSet, setAt, valueAt } from 'lazy-storage/core'

// LiveState, served as lazy-storage stores.
//
// lazy-storage has no per-user read filter inside a store: `authorize`
// decides who may open one, and every session on it then receives every
// patch. So the Hub's per-socket scoping becomes store layout:
//
//   panel          system, users, images    admins
//   fleet-<owner>  that owner's projects    the owner, or an admin
//   harbor         proxy (the base domain)  any signed-in user
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

// Arrays of records travel as whole values and must be declared; an
// undeclared one is refused by the store. Primitive arrays (loadavg, a
// container's ports, an image's tags) may sit anywhere. A client opening a
// store declares the same list, or the server reports a mismatch.
export const FLEET_REGISTERS = ['projects/*/recentDeployments']
export const PANEL_REGISTERS = ['images/managed', 'images/local']
export const HARBOR_REGISTERS = []
const LIVE_REGISTERS = registerSet([...FLEET_REGISTERS, ...PANEL_REGISTERS])

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

function mirrorStore(initial, registers) {
  return createStore({
    initial,
    registers,
    // Clients only read: every op a client sends is refused, and the client
    // resyncs from a snapshot.
    validate: () => false,
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
}) {
  const stores = new Map()
  const logs = new Map() // deploymentId -> { store, seq }
  // Last known owner per project id: a deletion diff arrives after the
  // project is gone from state, and it still has to reach its owner's fleet.
  const owners = new Map()
  let sessions = 0

  function add(id, store) {
    store.observe('session', () => {
      let total = 0
      for (const s of stores.values()) total += s.sessions
      if (total !== sessions) onSessionsChange((sessions = total))
    })
    stores.set(id, store)
    return store
  }
  add('panel', mirrorStore({ system: {}, users: {}, images: {} }, PANEL_REGISTERS))
  add('harbor', mirrorStore({ proxy: {} }, HARBOR_REGISTERS))

  const ensureFleet = ownerId =>
    stores.get(fleetId(ownerId)) ?? add(fleetId(ownerId), mirrorStore({ projects: {} }, FLEET_REGISTERS))

  function dropFleet(ownerId) {
    const store = stores.get(fleetId(ownerId))
    if (!store) return
    stores.delete(fleetId(ownerId))
    store.dispose() // its sessions close; the sockets stay up for their other stores
  }

  const ownerOf = id => liveState.projects?.[id]?.info?.owner_id ?? owners.get(String(id)) ?? null

  function rememberOwners() {
    for (const [id, live] of Object.entries(liveState.projects ?? {})) {
      if (live?.info?.owner_id != null) owners.set(id, live.info.owner_id)
    }
  }

  // Every store's tree is a subtree of LiveState at the same paths, so the
  // live value for any store path is read straight off the proxy.
  const current = path => {
    const value = valueAt(liveState, path)
    if (value === undefined) return null
    return LazyWatch.isProxy(value) ? LazyWatch.snapshot(value) : value
  }

  // A server patch is the authority (lazy-storage 0.10.1): a record
  // recreated under a deleted key — a container after a deploy, a pm2
  // process started again by hand — lands, and nothing here should ever be
  // refused. Should the merge refuse a leaf anyway, the store would sit
  // silently behind LiveState for good (the next batch only carries what
  // changed since), so it is written again from the live value on the next
  // turn, and reported if that keeps failing.
  function write(id, diff, attempt = 0) {
    const store = stores.get(id)
    if (!store) return
    let result
    try {
      result = store.patch(diff)
    } catch (err) {
      onError(new Error(`live store ${id}: ${err.message}`, { cause: err }))
      return
    }
    if (!result.rejected.length) return
    if (attempt >= 3) {
      onError(new Error(`live store ${id}: gave up on ${result.rejected.map(p => p.join('/')).join(', ')}`))
      return
    }
    setTimeout(() => {
      const repair = {}
      for (const path of result.rejected) setAt(repair, path, current(path))
      write(id, expandRegisters(repair, LIVE_REGISTERS, liveState), attempt + 1)
    }, 2)
  }

  function route(diff) {
    // store.patch takes arrays only as whole values; lazy-watch emits them
    // as fragments ({ 0: ..., $length }), expanded here from the live state.
    const { projects, system, users, images, proxy } = expandRegisters(diff, LIVE_REGISTERS, liveState)
    if (projects && typeof projects === 'object') {
      const fleets = new Map()
      for (const [id, subtree] of Object.entries(projects)) {
        const owner = ownerOf(id)
        if (owner == null) {
          onError(new Error(`project ${id} has no owner — not published to any fleet`))
          continue
        }
        if (!fleets.has(owner)) fleets.set(owner, {})
        fleets.get(owner)[id] = subtree
      }
      for (const [owner, subtree] of fleets) {
        ensureFleet(owner)
        write(fleetId(owner), { projects: subtree })
      }
    }
    const panel = {}
    if (system !== undefined) panel.system = system
    if (users !== undefined) panel.users = users
    if (images !== undefined) panel.images = images
    if (Object.keys(panel).length) write('panel', panel)
    if (proxy !== undefined) write('harbor', { proxy })
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
    const store = mirrorStore({ lines: {} }, [])
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
