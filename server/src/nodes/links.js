import { createClient, createConnection } from 'lazy-storage'
import { STORE_SHAPES, UPLINK_ID, mirrorStore, wholeArraysOf } from '../live/stores.js'
import { nodeInfo } from '../live/state.js'
import { nodeForKey } from './keys.js'
import { FLEET_PROTOCOL, MIN_FLEET_PROTOCOL, helloProtocol, protocolAdvice } from './protocol.js'

// The master's side of its agents: other Skeppa servers that dial this
// panel at /agent and report what they run.
//
// One socket per node, opened by the agent (so the master never needs a way
// in to it), authenticated by its key (nodes/keys.js). Three channels ride
// it, each message an envelope `{ ch, … }`:
//
//   live   lazy-storage's own protocol, turned around: the agent serves its
//          stores (agent/uplink.js, a hub over this socket) and this panel
//          is the client — `uplink` always, `deploy-<id>` while a browser
//          follows one. Each is mirrored into a store of this panel's own,
//          which browsers open like any other:
//
//            node-<id>               what that server reports    admins
//            node-<id>-deploy-<dep>  one of its running deploys  admins
//
//   rpc    request/answer, master → agent, by a fixed list of methods the
//          agent knows (agent/uplink.js METHODS) — among them `request`, an
//          API call run through the agent's own routes (routes/nodes.js
//          relays /api/nodes/:id/api/* there).
//   ask    the other way: the agent's questions (`{ ch: 'ask' }`, answered
//          `{ ch: 'answer' }`), judged by onAsk (nodes/answers.js) — GitHub
//          tokens scoped to one of its repos, the repo listing — so an agent
//          needs no GitHub App of its own. Pushes come down as rpc `push`.
//   ctl    small talk: each side's hello (the agent's version and admin,
//          and both sides' fleet protocol range, nodes/protocol.js), and
//          the master's `watch`, which tells the agent someone is looking
//          so its poller runs at the live cadence.
//
// The upstream connection lives as long as the node does, across the
// agent's reconnects: the tunnel transport below fails at once while no
// socket is up, and an agent dialling in starts it right away, so a
// reconnect is a delta and what was deleted meanwhile is deleted here too.
// A node that is offline keeps showing what it last reported.

export const AGENT_PATH = '/agent'
const NODE_STORE = /^node-(\d+)$/
// a running log there: node-<id>-deploy-<dep>, or a Shipyard build's, node-<id>-build-<image>
const NODE_DEPLOY = /^node-(\d+)-(deploy|build)-(\d+)$/
export const nodeStoreId = id => `node-${id}`
export const nodeDeployStoreId = (id, deploymentId) => `node-${id}-deploy-${deploymentId}`
export const nodeBuildStoreId = (id, imageId) => `node-${id}-build-${imageId}`

const isNodeSocket = ws => Boolean(ws?.data) && Object.hasOwn(ws.data, 'skeppaNode')

export class NodeCallError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

export function createNodeLinks({
  db,
  liveState,
  onError = err => console.error('[nodes]', err?.message ?? err),
  rpcTimeoutMs = 15_000,
  linger = 30_000,
  reconnect = { min: 1000, max: 30_000 },
  now = () => new Date().toISOString(),
  // What an agent asks of this panel (`ask`, the other way round from rpc):
  // (nodeId, method, params) → a JSON value, or throws. nodes/answers.js.
  onAsk = null,
  // What each node last reported, kept across this panel's restarts: a
  // lazy-storage storage (sqliteStorage(file, { lease: false })), or none.
  storage = null,
  // A paired node not heard from for this long: onNodeDown(node row, since
  // ISO), once; onNodeUp(node row, away ms) when it is back after that.
  offlineAlertMs = 5 * 60_000,
  onNodeDown = null,
  onNodeUp = null,
}) {
  const nodes = new Map() // id -> link state, below
  // Repositories a node may have a token for although none of its projects
  // reports one yet: the admin here just asked about it through the relay
  // (a branch list in the mooring form). `${node} ${repo}` -> expiry (ms).
  const grants = new Map()
  const GRANT_MS = 10 * 60_000

  function setInfo(id, online) {
    const row = db.query('SELECT * FROM nodes WHERE id = ?').get(id)
    if (row) liveState.nodes[id] = nodeInfo(row, online, { adminId: nodes.get(Number(id))?.adminId ?? 0 })
  }

  // --- the tunnel: a lazy-storage transport over the agent's socket ---------
  function tunnel(n) {
    const t = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send(message) {
        if (n.tunnel === t && n.socket) n.socket.send(JSON.stringify({ ch: 'live', m: message }))
      },
      close() {
        if (n.tunnel !== t) return
        n.tunnel = null
        queueMicrotask(() => t.onclose?.({}))
      },
    }
    if (!n.socket) {
      // No agent: fail now, and the connection retries on its backoff (an
      // agent dialling in cuts that short, see open below).
      queueMicrotask(() => t.onclose?.({}))
      return t
    }
    n.tunnel = t
    queueMicrotask(() => {
      if (n.tunnel === t) t.onopen?.()
    })
    return t
  }

  function patch(label, store, client, diff) {
    try {
      store.patch(wholeArraysOf(client.state, diff))
    } catch (err) {
      onError(new Error(`${label}: ${err.message}`, { cause: err }))
    }
  }

  function sendCtl(n, message) {
    n.socket?.send(JSON.stringify({ ch: 'ctl', ...message }))
  }

  // Someone is looking at this node: its own store, or one of its logs.
  function updateWatch(n) {
    let on = n.store.sessions > 0
    for (const log of n.logs.values()) on ||= log.store.sessions > 0
    if (on === n.watching) return
    n.watching = on
    sendCtl(n, { t: 'watch', on })
  }

  function ensure(id) {
    id = Number(id)
    if (nodes.has(id)) return nodes.get(id)
    // `pushes`: GitHub pushes waiting for the node to come back, the latest
    // per repo and ref (`${repo} ${ref}` -> slice).
    const n = { id, socket: null, tunnel: null, logs: new Map(), rpc: new Map(), seq: 0, watching: false, pushes: new Map() }
    n.connection = createConnection({ transport: () => tunnel(n), reconnect, keepalive: 30_000, wake: false })
    n.store = mirrorStore(STORE_SHAPES.node, { storage: storage?.store(nodeStoreId(id)) })
    n.store.observe('session', () => updateWatch(n))
    n.upstream = createClient({ connection: n.connection, store: UPLINK_ID, ...STORE_SHAPES.node, mirror: true })
    n.upstream.watch(diff => patch(nodeStoreId(id), n.store, n.upstream, diff))
    // The first time the uplink is in step since this panel started, what the
    // kept copy still has and the agent no longer does goes: the client
    // started empty, so its first snapshot can only add.
    n.upstream.on('status', status => {
      if (status !== 'online' || n.reconciled) return
      n.reconciled = true
      reconcile(n)
    })
    armDown(n) // until it dials in
    n.upstream.on('closed', closed => onError(new Error(`node ${id}: uplink closed — ${closed?.code}: ${closed?.message}`)))
    n.upstream.on('error', err => onError(new Error(`node ${id}: uplink — ${err?.code ?? ''} ${err?.message ?? err}`)))
    nodes.set(id, n)
    n.upstream.connect()
    return n
  }

  function reconcile(n) {
    const gone = {}
    for (const c of ['projects', 'groups']) {
      const now = n.upstream.state?.[c] ?? {}
      for (const id of Object.keys(n.store.state[c] ?? {})) if (!(id in now)) (gone[c] ??= {})[id] = null
    }
    if (!Object.keys(gone).length) return
    try {
      n.store.patch(gone)
    } catch (err) {
      onError(new Error(`node ${n.id}: reconcile — ${err.message}`, { cause: err }))
    }
  }

  // --- offline alerts ----------------------------------------------------------
  // A paired node gets offlineAlertMs to (re)connect before anyone is told;
  // an unpaired one is not missed. The alert goes once per absence.
  const rowOf = id => db.query('SELECT * FROM nodes WHERE id = ?').get(id)
  function armDown(n) {
    clearTimeout(n.downTimer)
    n.downSince ??= Date.now()
    if (!onNodeDown) return
    n.downTimer = setTimeout(() => {
      const row = rowOf(n.id)
      if (!row?.key_hash || n.socket || n.alerted) return
      n.alerted = true
      try {
        onNodeDown(row, row.last_seen_at)
      } catch (err) {
        onError(err)
      }
    }, offlineAlertMs)
    n.downTimer.unref?.()
  }
  function markUp(n) {
    clearTimeout(n.downTimer)
    const away = n.downSince ? Date.now() - n.downSince : 0
    n.downSince = null
    if (!n.alerted) return
    n.alerted = false
    try {
      onNodeUp?.(rowOf(n.id), away)
    } catch (err) {
      onError(err)
    }
  }

  // --- running logs (deploys, Shipyard builds), followed on demand ----------
  // `upstreamId` is the store over there: deploy-<id> or build-<image id>.
  function openLog(n, upstreamId) {
    const existing = n.logs.get(upstreamId)
    if (existing) return existing.store
    const store = mirrorStore(STORE_SHAPES.deploy)
    const client = createClient({ connection: n.connection, store: upstreamId, ...STORE_SHAPES.deploy, mirror: true })
    const log = { store, client, timer: null }
    n.logs.set(upstreamId, log)
    const idle = () => {
      clearTimeout(log.timer)
      log.timer = store.sessions > 0 ? null : setTimeout(() => endLog(n, upstreamId), linger)
    }
    store.observe('session', () => {
      idle()
      updateWatch(n)
    })
    client.watch(diff => patch(`node-${n.id}-${upstreamId}`, store, client, diff))
    // 'evicted' is the deploy or build finishing over there; 'unknown-store'
    // one that already had. Either way the stored log is on the API from here.
    client.on('closed', () => endLog(n, upstreamId))
    client.connect()
    idle() // nobody has said hello yet: a store nobody opens does not stay
    return store
  }

  function endLog(n, upstreamId) {
    const log = n.logs.get(upstreamId)
    if (!log) return
    n.logs.delete(upstreamId)
    clearTimeout(log.timer)
    log.client.disconnect()
    log.store.closeSessions(() => true, upstreamId.startsWith('build-') ? 'build finished' : 'deployment finished')
    log.store.dispose()
    updateWatch(n)
  }

  // --- the agent's socket ---------------------------------------------------
  function detach(n) {
    n.socket = null
    const t = n.tunnel
    n.tunnel = null
    t?.onclose?.({ code: 1006 })
    for (const [rid, call] of n.rpc) {
      clearTimeout(call.timer)
      call.reject(new NodeCallError('the server went offline', 'offline'))
      n.rpc.delete(rid)
    }
  }

  function receive(n, raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.ch === 'live') {
      if (msg.m && typeof msg.m === 'object') n.tunnel?.onmessage?.(msg.m)
    } else if (msg.ch === 'rpc') {
      const call = n.rpc.get(msg.id)
      if (!call) return
      n.rpc.delete(msg.id)
      clearTimeout(call.timer)
      if (msg.error) call.reject(new NodeCallError(String(msg.error.message ?? 'failed'), String(msg.error.code ?? 'failed')))
      else call.resolve(msg.result ?? null)
    } else if (msg.ch === 'ask') {
      answerAsk(n, msg)
    } else if (msg.ch === 'ctl' && msg.t === 'hello') {
      const version = typeof msg.version === 'string' ? msg.version.slice(0, 40) : ''
      n.adminId = Number.isInteger(msg.adminId) && msg.adminId > 0 ? msg.adminId : 0
      const said = helloProtocol(msg)
      db.query('UPDATE nodes SET agent_version = ?, agent_protocol = ?, agent_min_protocol = ? WHERE id = ?')
        .run(version, said.protocol, said.minProtocol, n.id)
      setInfo(n.id, true)
      // Still connected — the Fleet page says it, and Update panel goes
      // through the relay — but worth a line in this panel's log too.
      const gap = protocolAdvice(said)
      if (gap) onError(new Error(`node ${n.id}: speaks fleet protocol ${said.minProtocol}–${said.protocol}, this panel ${MIN_FLEET_PROTOCOL}–${FLEET_PROTOCOL} — update ${gap === 'peer-older' ? 'that server' : 'this panel'}`))
    }
  }

  // An agent's question. Whatever it asks for is judged by onAsk as that
  // node's — an agent is trusted to run its own projects, not this panel.
  async function answerAsk(n, msg) {
    const ws = n.socket
    let reply
    try {
      if (!onAsk) throw new NodeCallError('this panel answers no questions', 'unavailable')
      reply = { result: (await onAsk(n.id, String(msg.method ?? ''), msg.params ?? {})) ?? null }
    } catch (err) {
      reply = { error: { code: err.code ?? 'failed', message: err.message ?? 'failed' } }
    }
    if (ws && n.socket === ws) ws.send(JSON.stringify({ ch: 'answer', id: msg.id, ...reply }))
  }

  // Waiting pushes, in the order they came; one that fails stays dropped —
  // the next push or a Check GitHub there catches the head up.
  function flushPushes(n) {
    const waiting = [...n.pushes.values()]
    n.pushes.clear()
    for (const push of waiting) {
      callNode(n, 'push', push).catch(err => onError(new Error(`node ${n.id}: a queued push failed — ${err.message}`)))
    }
  }

  // The repositories a node's reported projects deploy from GitHub.
  function reposOf(n) {
    const repos = new Set()
    for (const live of Object.values(n.store.state.projects ?? {})) {
      const info = live?.info
      if (info?.repo_full_name && !info.git_url) repos.add(String(info.repo_full_name).toLowerCase())
    }
    return repos
  }

  function callNode(n, method, params = {}, { timeoutMs = rpcTimeoutMs } = {}) {
    if (!n?.socket) return Promise.reject(new NodeCallError('the server is offline', 'offline'))
    const rid = ++n.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        n.rpc.delete(rid)
        reject(new NodeCallError(`no answer in ${Math.round(timeoutMs / 1000)} s`, 'timeout'))
      }, timeoutMs)
      n.rpc.set(rid, { resolve, reject, timer })
      n.socket.send(JSON.stringify({ ch: 'rpc', id: rid, method, params }))
    })
  }

  const websocket = {
    open(ws) {
      const n = nodes.get(ws.data.skeppaNode)
      if (!n) return ws.close(4401, 'unauthorized')
      if (n.socket && n.socket !== ws) {
        // A second dial wins: the first is most likely a socket that died
        // without saying so.
        const old = n.socket
        detach(n)
        old.close(4000, 'replaced by a newer connection')
      }
      n.socket = ws
      db.query('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(now(), n.id)
      setInfo(n.id, true)
      markUp(n)
      sendCtl(n, { t: 'hello', protocol: FLEET_PROTOCOL, minProtocol: MIN_FLEET_PROTOCOL })
      sendCtl(n, { t: 'watch', on: n.watching })
      n.connection.connect() // now, not when the backoff says
      flushPushes(n)
    },
    message(ws, raw) {
      const n = nodes.get(ws.data.skeppaNode)
      if (n?.socket === ws) receive(n, raw)
    },
    close(ws) {
      const n = nodes.get(ws.data.skeppaNode)
      if (!n || n.socket !== ws) return
      detach(n)
      db.query('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(now(), n.id)
      setInfo(n.id, false)
      armDown(n)
    },
  }

  for (const { id } of db.query('SELECT id FROM nodes').all()) ensure(id)

  return {
    // The /agent route: a Response, undefined once upgraded, or null when
    // the request is somebody else's. A key that does not match is still
    // upgraded, only to be closed with 4401, so the agent can tell "refused"
    // from "unreachable" and stop hammering.
    upgrade(req, server) {
      if (new URL(req.url).pathname !== AGENT_PATH) return null
      const node = nodeForKey(db, req.headers.get('authorization'))
      const data = { skeppaNode: node ? ensure(node.id).id : null }
      return server.upgrade(req, { data }) ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    },
    isNodeSocket,
    websocket,

    // For the live transport, next to the panel's own stores.
    get(storeId) {
      let m = NODE_STORE.exec(storeId)
      if (m) return nodes.get(Number(m[1]))?.store ?? null
      m = NODE_DEPLOY.exec(storeId)
      if (m) {
        const n = nodes.get(Number(m[1]))
        return n ? openLog(n, `${m[2]}-${m[3]}`) : null
      }
      return null
    },
    owns: storeId => NODE_STORE.test(storeId) || NODE_DEPLOY.test(storeId),
    // A node's state and logs are its admin's: deploy logs echo ENV values,
    // and tenants on agents are a later phase.
    canOpen(user, storeId) {
      const m = NODE_STORE.exec(storeId) ?? NODE_DEPLOY.exec(storeId)
      return Boolean(m) && user?.role === 'admin' && nodes.has(Number(m[1]))
    },

    isOnline: id => Boolean(nodes.get(Number(id))?.socket),

    call(id, method, params = {}, options = {}) {
      return callNode(nodes.get(Number(id)), method, params, options)
    },

    // A verified GitHub push (github/push.js pushSlice), handed to every
    // node whose reported projects deploy that repo: now if it is online,
    // when it is back otherwise (the latest per repo and ref). A node this
    // panel has heard nothing from since it started reports no projects
    // and hears nothing — Check GitHub there catches it up. How many it
    // went to.
    forwardPush(push) {
      const repo = String(push?.repository?.full_name ?? '').toLowerCase()
      if (!repo) return 0
      let count = 0
      for (const n of nodes.values()) {
        if (!reposOf(n).has(repo)) continue
        count++
        if (n.socket) {
          callNode(n, 'push', push).catch(err => onError(new Error(`node ${n.id}: push forward failed — ${err.message}`)))
        } else {
          n.pushes.set(`${repo} ${push.ref}`, push)
        }
      }
      return count
    },

    // Which GitHub repositories a node may have a token for: those its
    // projects deploy, and those just granted (below).
    mayUseRepo(id, repo) {
      const n = nodes.get(Number(id))
      if (!n || typeof repo !== 'string') return false
      const key = repo.toLowerCase()
      if (reposOf(n).has(key)) return true
      const until = grants.get(`${n.id} ${key}`)
      if (until && until > Date.now()) return true
      grants.delete(`${n.id} ${key}`)
      return false
    },
    // The admin here asked about a repo on that server (the relay, for a
    // branch list or suggestions): its token may follow, for a while.
    grantRepo(id, repo) {
      if (typeof repo === 'string' && repo) grants.set(`${Number(id)} ${repo.toLowerCase()}`, Date.now() + GRANT_MS)
    },

    // A node created, renamed or re-paired: its row as LiveState shows it.
    refresh(id) {
      ensure(id)
      setInfo(Number(id), Boolean(nodes.get(Number(id))?.socket))
    },
    // Its key changed: whoever is dialling with the old one is out.
    disconnect(id, reason = 'the key was replaced') {
      nodes.get(Number(id))?.socket?.close(4401, reason)
    },
    remove(id) {
      id = Number(id)
      const n = nodes.get(id)
      delete liveState.nodes[id]
      if (!n) return
      nodes.delete(id)
      clearTimeout(n.downTimer)
      n.socket?.close(4401, 'removed from the fleet')
      detach(n)
      for (const upstreamId of [...n.logs.keys()]) endLog(n, upstreamId)
      n.upstream.disconnect()
      n.connection.close()
      n.store.closeSessions(() => true, 'removed from the fleet')
      n.store.dispose()
      // …and what it reported, kept on disk, goes with it
      try {
        storage?.remove(nodeStoreId(id))
      } catch (err) {
        onError(err)
      }
    },
    dispose() {
      for (const id of [...nodes.keys()]) {
        const n = nodes.get(id)
        nodes.delete(id)
        clearTimeout(n.downTimer)
        n.socket?.close(1001, 'shutting down')
        detach(n)
        for (const upstreamId of [...n.logs.keys()]) endLog(n, upstreamId)
        n.upstream.disconnect()
        n.connection.close()
        n.store.dispose()
      }
    },
  }
}
