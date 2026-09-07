// Deploy logs over Hono's /ws: per-deployment subscribe/unsubscribe, a
// backlog on subscribe, then lines as they are written. Live state is not
// on this socket any more — it comes from the stores in live.js.
//
// Reconnects with exponential backoff; subscriptions are re-established
// after every reconnect.

let ws = null
let wanted = false
let backoff = 500
let reconnectTimer = null

const logListeners = new Map() // deploymentId -> Set<fn(event)>

function sendMsg(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export function connectWs() {
  wanted = true
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onopen = () => {
    backoff = 500
    for (const deploymentId of logListeners.keys()) {
      sendMsg({ type: 'logs:subscribe', deploymentId })
    }
  }

  ws.onmessage = evt => {
    let msg
    try {
      msg = JSON.parse(evt.data)
    } catch {
      return
    }
    if (msg.type === 'logs:line') emitLog(msg.deploymentId, { type: 'line', line: msg.line })
    else if (msg.type === 'logs:backlog') emitLog(msg.deploymentId, { type: 'backlog', log: msg.log })
  }

  ws.onclose = () => {
    ws = null
    if (!wanted) return
    reconnectTimer = setTimeout(connectWs, backoff)
    backoff = Math.min(backoff * 2, 15000)
  }

  ws.onerror = e => {
    console.error('WebSocket error:', e)
    ws?.close()
  }
}

export function disconnectWs() {
  wanted = false
  clearTimeout(reconnectTimer)
  ws?.close()
  ws = null
}

function emitLog(deploymentId, event) {
  for (const fn of logListeners.get(deploymentId) ?? []) fn(event)
}

// Returns an unsubscribe function. The server sends the in-memory backlog of a
// running deployment right after subscribing.
export function subscribeLogs(deploymentId, fn) {
  let set = logListeners.get(deploymentId)
  if (!set) {
    logListeners.set(deploymentId, (set = new Set()))
    sendMsg({ type: 'logs:subscribe', deploymentId })
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) {
      logListeners.delete(deploymentId)
      sendMsg({ type: 'logs:unsubscribe', deploymentId })
    }
  }
}
