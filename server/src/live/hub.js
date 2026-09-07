// Owns the set of WebSocket clients on Hono's /ws: deploy logs, as
// per-deployment pub/sub — subscribe -> backlog + appended lines. Live state
// is not on this socket; it is served as lazy-storage stores at /live
// (live/stores.js, live/transport.js).
export class Hub {
  constructor({ onClientsChange } = {}) {
    this.clients = new Set()
    this.logSubs = new Map() // deploymentId -> Set<socket>
    this.users = new Map() // socket -> { id, role } from the upgrade session
    this.onClientsChange = onClientsChange || (() => {})
    this.getLogBacklog = () => null // wired to DeployRunner.getActiveLog in index.js
    // Wired in index.js: deploy logs echo env values, so a tenant socket
    // may only follow their own deployments. Bare hubs (tests) trust.
    this.canReadDeployment = () => true
  }

  add(sock, user = null) {
    this.clients.add(sock)
    if (user) this.users.set(sock, user)
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
