import { reactive, computed } from 'vue'
import { LazyWatch } from 'lazy-watch'
import { createClient, createConnection, webSocketTransport } from 'lazy-storage'
import { store } from './store.js'
import { api } from './api.js'

// Live state, mirrored from the server's lazy-storage stores over one socket
// at /live. The layout is the server's (server/src/live/stores.js):
//
//   panel          system, users, images    admins only
//   fleet-<owner>  that owner's projects    the owner, or an admin
//   harbor         proxy (the base domain)  anyone signed in
//
// A tenant opens harbor and its own fleet; an admin opens panel and harbor,
// then a fleet per user the panel lists. Each store is mirrored into a
// Vue-reactive object, and `store.live` is composed from the mirrors so the
// views keep reading the shape they always have — `projects` is the merge
// across fleets. Clients here only read: the server refuses any write.
//
// Deploy logs are not stores; they still ride Hono's /ws (ws.js).

// Arrays of records travel as whole values and both sides declare them; the
// server reports a mismatch on every snapshot.
export const FLEET_REGISTERS = ['projects/*/recentDeployments']
export const PANEL_REGISTERS = ['images/managed', 'images/local']

const panel = reactive({ system: {}, users: {}, images: {} })
const harbor = reactive({ proxy: {} })
const fleets = reactive({}) // owner id -> { projects }

store.live = reactive({
  // The members are the mirrors' own reactive project objects, so a field
  // changing deep inside one renders without this recomputing; it reruns
  // only when a project or a fleet comes or goes.
  projects: computed(() => {
    const out = {}
    for (const fleet of Object.values(fleets)) Object.assign(out, fleet.projects)
    return out
  }),
  system: computed(() => panel.system),
  users: computed(() => panel.users),
  images: computed(() => panel.images),
  proxy: computed(() => harbor.proxy),
})

let connection = null
const clients = new Map() // store id -> client
const online = new Set() // store ids whose snapshot has landed

function refreshReady() {
  store.ready = clients.size > 0 && [...clients.keys()].every(id => online.has(id))
}

function open(id, initial, registers, mirror, onBatch = () => {}) {
  if (clients.has(id)) return
  const db = createClient({ connection, store: id, initial, registers, undo: false, cache: false, presence: false })
  clients.set(id, db)
  db.watch(diff => {
    LazyWatch.patch(mirror, diff)
    store.liveUpdatedAt = Date.now()
    onBatch(db)
  })
  db.on('status', status => {
    // 'online' means the snapshot (or the delta) is applied — the batch that
    // carries it to the mirror follows on the microtask, an empty store
    // produces none, and either way the store is current from here.
    if (status !== 'online') return
    online.add(id)
    store.liveUpdatedAt = Date.now()
    onBatch(db)
    refreshReady()
  })
  db.on('closed', closed => console.warn(`live: ${id} closed — ${closed?.code}: ${closed?.message}`))
  db.on('error', err => console.warn(`live: ${id}: ${err?.code ?? ''} ${err?.message ?? err}`))
  db.connect()
}

function close(id) {
  const db = clients.get(id)
  if (!db) return
  clients.delete(id)
  online.delete(id)
  db.disconnect()
}

// Open a fleet per owner in `ids` and let go of the others. An admin's list
// is the crew (from the panel's own state, which is current the moment the
// panel is online); a tenant's is themselves.
function syncFleets(ids) {
  const wanted = new Set(ids.map(String))
  for (const id of Object.keys(fleets)) {
    if (wanted.has(id)) continue
    close(`fleet-${id}`)
    delete fleets[id]
  }
  for (const id of wanted) {
    if (fleets[id]) continue
    fleets[id] = reactive({ projects: {} })
    open(`fleet-${id}`, { projects: {} }, FLEET_REGISTERS, fleets[id])
  }
  refreshReady()
}

export function connectLive() {
  if (connection || !store.user) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  connection = createConnection({ transport: webSocketTransport(`${proto}://${location.host}/live`) })
  connection.on('status', status => {
    store.connected = status === 'open' // 'offline' | 'connecting' | 'open'
  })
  // The session is gone (expired, or the account was removed): the socket
  // will not come back on its own, and neither will the API calls.
  connection.on('closed', closed => {
    if (closed?.code === 'unauthorized') api.onUnauthorized?.()
  })
  open('harbor', { proxy: {} }, [], harbor)
  if (store.user.role === 'admin') {
    open('panel', { system: {}, users: {}, images: {} }, PANEL_REGISTERS, panel, db => syncFleets(Object.keys(db.state.users ?? {})))
  } else {
    syncFleets([store.user.id])
  }
}

export function disconnectLive() {
  for (const id of [...clients.keys()]) close(id)
  const conn = connection
  connection = null
  conn?.close()
  for (const id of Object.keys(fleets)) delete fleets[id]
  panel.system = {}
  panel.users = {}
  panel.images = {}
  harbor.proxy = {}
  store.ready = false
  store.connected = false
}
