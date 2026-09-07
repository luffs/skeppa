import { LazyWatch } from 'lazy-watch'

// Owns the set of connected WebSocket clients.
// - LiveState diffs (batched by lazy-watch) go to every socket, scoped per
//   socket: admins see everything, a tenant sees their own projects and
//   the proxy's base domain — never system, users or images.
// - Deploy logs use per-deployment pub/sub: subscribe -> backlog + appended
//   lines; nothing log-related ever touches LiveState.
export class Hub {
  constructor({ liveState, onClientsChange } = {}) {
    this.liveState = liveState
    this.clients = new Set()
    this.logSubs = new Map() // deploymentId -> Set<socket>
    this.users = new Map() // socket -> { id, role } from the upgrade session
    this.onClientsChange = onClientsChange || (() => {})
    this.getLogBacklog = () => null // wired to DeployRunner.getActiveLog in index.js
    // Wired in index.js: deploy logs echo env values, so a tenant socket
    // may only follow their own deployments. Bare hubs (tests) trust.
    this.canReadDeployment = () => true
    // Last known owner per project id: a deletion diff arrives after the
    // project is gone from state, and it still has to reach its owner.
    this.projectOwners = new Map()
    if (liveState) {
      LazyWatch.on(liveState, diff => this.broadcastState(diff))
    }
  }

  // The same rule shapes the snapshot and every diff, so a tenant mirror
  // stays consistent with what it was seeded with. Admin sockets (and
  // user-less bare hubs) pass the tree through untouched.
  _scope(user, tree) {
    if (!user || user.role === 'admin') return tree
    const out = {}
    if (tree.projects && typeof tree.projects === 'object') {
      const projects = {}
      for (const [id, value] of Object.entries(tree.projects)) {
        if (this._ownerOf(id) === user.id) projects[id] = value
      }
      if (Object.keys(projects).length) out.projects = projects
    }
    if (tree.proxy !== undefined) out.proxy = tree.proxy // baseDomain, for routed URLs
    return out
  }

  _ownerOf(id) {
    const live = this.liveState?.projects?.[id]?.info?.owner_id
    return live ?? this.projectOwners.get(String(id)) ?? null
  }

  _rememberOwners() {
    for (const [id, live] of Object.entries(this.liveState?.projects ?? {})) {
      if (live?.info?.owner_id != null) this.projectOwners.set(id, live.info.owner_id)
    }
  }

  broadcastState(diff) {
    let raw = null
    for (const sock of this.clients) {
      const user = this.users.get(sock)
      if (!user || user.role === 'admin') {
        raw ??= JSON.stringify({ type: 'state', diff })
        this._sendRaw(sock, raw)
        continue
      }
      const scoped = this._scope(user, diff)
      if (Object.keys(scoped).length) this._send(sock, { type: 'state', diff: scoped })
    }
    this._rememberOwners() // after: a deletion needed the previous owners
  }

  add(sock, user = null) {
    this.clients.add(sock)
    if (user) this.users.set(sock, user)
    const snapshot = LazyWatch.snapshot(this.liveState)
    this._rememberOwners()
    const tenant = user && user.role !== 'admin'
    // A tenant's mirror still needs every top-level branch to exist.
    const state = tenant
      ? { projects: {}, system: {}, users: {}, proxy: {}, images: {}, ...this._scope(user, snapshot) }
      : snapshot
    this._send(sock, { type: 'state:full', state })
    this.onClientsChange(this.clients.size)
  }

  remove(sock) {
    this.clients.delete(sock)
    this.users.delete(sock)
    for (const [id, subs] of this.logSubs) {
      subs.delete(sock)
      if (subs.size === 0) this.logSubs.delete(id)
    }
    this.onClientsChange(this.clients.size)
  }

  // Client messages are schema-validated; unknown types are ignored and logged.
  handleMessage(sock, raw) {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      console.warn('ws: ignoring non-JSON message')
      return
    }
    const { type, deploymentId } = msg ?? {}
    if (type === 'logs:subscribe' && Number.isInteger(deploymentId)) {
      if (!this.canReadDeployment(this.users.get(sock) ?? null, deploymentId)) {
        console.warn(`ws: denied logs:subscribe to deployment ${deploymentId}`)
        return
      }
      let subs = this.logSubs.get(deploymentId)
      if (!subs) this.logSubs.set(deploymentId, (subs = new Set()))
      subs.add(sock)
      const backlog = this.getLogBacklog(deploymentId)
      if (backlog != null) this._send(sock, { type: 'logs:backlog', deploymentId, log: backlog })
    } else if (type === 'logs:unsubscribe' && Number.isInteger(deploymentId)) {
      const subs = this.logSubs.get(deploymentId)
      if (subs) {
        subs.delete(sock)
        if (subs.size === 0) this.logSubs.delete(deploymentId)
      }
    } else {
      console.warn('ws: ignoring unknown message type:', type)
    }
  }

  sendLog(deploymentId, line) {
    const subs = this.logSubs.get(deploymentId)
    if (!subs) return
    const msg = JSON.stringify({ type: 'logs:line', deploymentId, line })
    for (const sock of subs) this._sendRaw(sock, msg)
  }

  broadcast(msg) {
    const s = JSON.stringify(msg)
    for (const sock of this.clients) this._sendRaw(sock, s)
  }

  _send(sock, msg) {
    this._sendRaw(sock, JSON.stringify(msg))
  }

  _sendRaw(sock, s) {
    try {
      sock.send(s)
    } catch (err) {
      console.warn('ws send failed:', err?.message)
    }
  }
}
