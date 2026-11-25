import { createHub } from 'lazy-storage/server'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { UPLINK_ID } from '../live/stores.js'
import { parseAgentKey } from '../nodes/keys.js'
import { applyPush } from '../github/push.js'
import { REPO_RE } from '../lib/validate.js'
import { SHA_RE } from '../deploy/git.js'

// The agent's side of the link to its master (nodes/links.js has the other).
//
// With MASTER_URL in the config this panel dials `<master>/agent` with its
// key and keeps that one socket up, reconnecting on a backoff. Over it:
//
//   live   this panel's stores, served by a lazy-storage hub as if the master
//          were a browser — but only `uplink` (everything, unfiltered) and
//          `deploy-<id>`, and read-only like every store here.
//   rpc    the master's requests, answered from METHODS only. Nothing else
//          the master sends can make this panel do anything.
//   ask    this panel's questions to the master (`ask` below): GitHub tokens
//          for one repo, the repo listing — agent/github.js, when this
//          panel has no GitHub App of its own. Pushes come as rpc `push`.
//   ctl    `watch`: someone on the master is looking, so the poller should
//          run at the live cadence (onWatch).
//
// The agent stays a whole panel of its own: its UI, its webhooks, its
// deploys. The master going away changes nothing here but the socket.

const DEPLOY_ID = /^deploy-\d+$/

const coded = (code, message) => Object.assign(new Error(message), { code })

// What the master may do here through `request`: this server's projects,
// piers, deployments, and the GitHub listings the project form needs; its
// Engine room (pm2 and containers), Shipyard, harbor gate and notification
// settings. Not the crew (tenants on agents are a later phase), not the
// GitHub App's own pages (the master lends its App: nodes/answers.js).
// Matched on the normalized path.
const PROCESS = '[A-Za-z0-9@._-]+' // a pm2 or container name, as the system routes validate further
export const FLEET_PATHS = [
  { methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], path: /^\/api\/projects(\/\d+(\/[a-z0-9/-]+)?)?$/ },
  { methods: ['GET', 'POST', 'PATCH', 'DELETE'], path: /^\/api\/groups(\/\d+(\/deploy)?)?$/ },
  { methods: ['GET'], path: /^\/api\/deployments\/\d+$/ },
  { methods: ['GET'], path: /^\/api\/github\/repos(\/branches|\/suggest)?$/ },
  { methods: ['GET', 'POST'], path: new RegExp(`^/api/system/(pm2|containers)/${PROCESS}/(start|stop|restart|remove|logs|logs/previous)$`) },
  { methods: ['GET', 'POST', 'PATCH', 'DELETE'], path: /^\/api\/images(\/(pull|remove|prune|\d+(\/(log|build))?))?$/ },
  { methods: ['GET', 'PUT', 'POST'], path: /^\/api\/proxy(\/apply)?$/ },
  { methods: ['GET', 'PUT'], path: /^\/api\/settings$/ },
  { methods: ['POST'], path: /^\/api\/settings\/notify\/test$/ },
]

// The largest answer relayed: the master takes 4 MB a message, and a
// download travels as base64.
export const MAX_RELAYED_BYTES = 2 * 1024 * 1024

// `/api/…?query` → the normalized URL, or null when it is not one the
// master may ask for.
export function fleetRequestUrl(method, path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.length > 2048) return null
  let url
  try {
    url = new URL(path, 'http://agent.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'http://agent.invalid') return null
  const allowed = FLEET_PATHS.some(rule => rule.methods.includes(method) && rule.path.test(url.pathname))
  return allowed ? url : null
}

// What the master may ask. Each is (params, context) → a JSON value; a
// thrown error's `code` and message go back as the answer.
export const METHODS = {
  // One deployment with its log: the collector's while it runs, else the
  // stored one. Same as GET /api/deployments/:id for an admin.
  deployment(params, { db, runner }) {
    const id = Number(params?.id)
    if (!Number.isInteger(id) || id < 1) throw coded('bad-request', 'id must be a deployment id')
    const row = db.query('SELECT * FROM deployments WHERE id = ?').get(id)
    if (!row) return null
    return { ...row, log: runner?.getActiveLog(row.id) ?? row.log }
  },

  // A GitHub push the master's App heard (github/push.js pushSlice): what the
  // webhook route would do with it here. Only well-formed ones.
  push(params, { db, liveState, runner, github }) {
    const repo = params?.repository?.full_name
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) throw coded('bad-request', 'repository.full_name must be owner/name')
    if (typeof params.ref !== 'string' || !params.ref.startsWith('refs/')) throw coded('bad-request', 'ref must be a git ref')
    if (params.after != null && !(typeof params.after === 'string' && SHA_RE.test(params.after))) throw coded('bad-request', 'after must be a commit sha')
    return applyPush({ db, liveState, runner, github }, params)
  },

  // One API request, run through this panel's own routes (createFleetApiApp)
  // as its admin — the same checks as a request from its own UI. Answers
  // { status, json } or, for a download, { status, base64, disposition }.
  async request(params, { fleetApi, log }) {
    if (!fleetApi) throw coded('unavailable', 'this server takes no fleet requests')
    const method = String(params?.method ?? 'GET').toUpperCase()
    const url = fleetRequestUrl(method, params?.path)
    if (!url) throw coded('forbidden', `not through the fleet: ${method} ${String(params?.path ?? '').slice(0, 120)}`)
    const hasBody = params.body !== undefined && method !== 'GET' && method !== 'DELETE'
    // Changes are this server's business too: its own log says who asked.
    if (method !== 'GET') log?.(`master: ${method} ${url.pathname}`)
    const res = await fleetApi.fetch(new Request(url, {
      method,
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(params.body) : undefined,
    }))
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('application/json')) {
      const text = await res.text()
      if (text.length > MAX_RELAYED_BYTES) throw coded('too-large', 'the answer is too large to relay through the master')
      return { status: res.status, json: text ? JSON.parse(text) : null }
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_RELAYED_BYTES) throw coded('too-large', `${Math.round(bytes.length / 1024)} kB is too large to relay through the master — download it on that server's own panel`)
    return { status: res.status, base64: Buffer.from(bytes).toString('base64'), disposition: res.headers.get('content-disposition') ?? '' }
  },
}

// The stores the master may read here, served over the agent's socket:
// `uplink` and running deploy logs. Nothing else — not `panel`, not a fleet.
export const masterMayOpen = id => id === UPLINK_ID || DEPLOY_ID.test(id)

export function createAgentHub({ liveStores, send, onError }) {
  return createHub(id => liveStores.get(id), {
    send,
    // A stable id: lazy-storage tells users apart by it (presence, replicas)
    user: { id: 'master', role: 'master' },
    authorizeId: (_user, id) => masterMayOpen(id),
    onError,
  })
}

// http(s)://host[:port][/prefix] → ws(s)://…/agent
export function agentUrl(masterUrl) {
  const url = new URL(masterUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/agent`
  url.search = ''
  url.hash = ''
  return url.href
}

// The key file the join script wrote: one `skn_…` line, chmod 600.
export function readAgentKey(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read the agent key at ${path} (${err.code ?? err.message}) — pair this server with: bun scripts/join.js <master url> <code>`, { cause: err })
  }
  const parsed = parseAgentKey(text)
  if (!parsed) throw new Error(`${path} does not hold an agent key — pair this server again with scripts/join.js`)
  if (process.platform !== 'win32') {
    try {
      if (statSync(path).mode & 0o077) console.warn(`warning: ${path} is readable by group/others — run: chmod 600 ${path}`)
    } catch {
      // raced against deletion; the read above already succeeded
    }
  }
  return parsed.value
}

// Which commit this checkout is at, for the master's Fleet page. Read off
// .git without spawning git; '' when it cannot tell.
export function checkoutVersion(dir) {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
    const ref = /^ref: (refs\/[\w./-]+)$/.exec(head)?.[1]
    let sha = ref ? '' : head
    if (ref) {
      try {
        sha = readFileSync(join(dir, '.git', ref), 'utf8').trim()
      } catch {
        const packed = readFileSync(join(dir, '.git', 'packed-refs'), 'utf8')
        sha = packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? ''
      }
    }
    return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : ''
  } catch {
    return ''
  }
}

export function createUplink({
  masterUrl,
  key,
  db,
  runner = null,
  liveState = null, // for `push`
  github = null, // for `push` (its repo cache)
  fleetApi = null, // createFleetApiApp in app.js: what `request` runs through
  liveStores,
  version = '',
  onWatch = () => {},
  onError = err => console.error('[uplink]', err?.message ?? err),
  log = message => console.log(`[uplink] ${message}`),
  WebSocket: WS = globalThis.WebSocket,
  backoff = { min: 1000, max: 60_000 },
  refusedDelay = 5 * 60_000,
}) {
  const url = agentUrl(masterUrl)
  let socket = null
  let timer = null
  let stopped = true
  let delay = backoff.min
  let connected = false
  let refused = false
  // Questions to the master (`ask`), waiting for its answer: id -> { resolve, reject, timer }
  const asks = new Map()
  let askSeq = 0

  function dropAsks(why) {
    for (const [id, pending] of asks) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error(why), { code: 'offline' }))
      asks.delete(id)
    }
  }

  function schedule(ms) {
    clearTimeout(timer)
    if (stopped) return
    // Jittered, so agents that lost the same master do not all return at once
    const wait = ms ?? delay / 2 + Math.random() * (delay / 2)
    if (ms === undefined) delay = Math.min(delay * 2, backoff.max)
    timer = setTimeout(dial, wait)
  }

  async function answer(ws, msg) {
    const fn = typeof msg.method === 'string' && Object.hasOwn(METHODS, msg.method) ? METHODS[msg.method] : null
    let reply
    if (!fn) {
      reply = { error: { code: 'unknown-method', message: `this server does not know "${String(msg.method).slice(0, 40)}"` } }
    } else {
      try {
        reply = { result: (await fn(msg.params ?? {}, { db, runner, liveState, github, fleetApi, log })) ?? null }
      } catch (err) {
        reply = { error: { code: err.code ?? 'failed', message: err.message ?? 'failed' } }
      }
    }
    if (ws.readyState === 1) ws.send(JSON.stringify({ ch: 'rpc', id: msg.id, ...reply }))
  }

  function dial() {
    if (stopped) return
    let ws
    try {
      // Bun's WebSocket takes headers: the key never goes in the URL, where
      // proxies log it.
      ws = new WS(url, { headers: { authorization: `Bearer ${key}` } })
    } catch (err) {
      onError(err)
      return schedule()
    }
    socket = ws
    let hub = null
    let done = false

    ws.onopen = () => {
      if (socket !== ws) return
      delay = backoff.min
      connected = true
      refused = false
      hub = createAgentHub({
        liveStores,
        send: message => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ ch: 'live', m: message }))
        },
        onError,
      })
      // Who the master acts as here (createFleetApiApp): what a project it
      // moors here is owned by, and whose piers it may moor at.
      const admin = db.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
      ws.send(JSON.stringify({ ch: 'ctl', t: 'hello', version, adminId: admin?.id ?? 0 }))
      log(`connected to ${url}`)
    }

    ws.onmessage = event => {
      if (socket !== ws) return
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.ch === 'live' && msg.m && typeof msg.m === 'object') {
        try {
          hub?.receive(msg.m)
        } catch (err) {
          onError(err)
        }
      } else if (msg.ch === 'rpc') {
        answer(ws, msg).catch(onError)
      } else if (msg.ch === 'answer') {
        const pending = asks.get(msg.id)
        if (!pending) return
        asks.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(Object.assign(new Error(String(msg.error.message ?? 'failed')), { code: String(msg.error.code ?? 'failed') }))
        else pending.resolve(msg.result ?? null)
      } else if (msg.ch === 'ctl' && msg.t === 'watch') {
        onWatch(msg.on === true)
      }
    }

    const closed = code => {
      if (done) return
      done = true
      hub?.close()
      hub = null
      if (socket !== ws) return
      socket = null
      if (connected) log(`lost the master (${code ?? 'no code'})`)
      connected = false
      onWatch(false)
      dropAsks('lost the master')
      if (code === 4401) {
        // The master does not take this key (re-paired, or removed): asking
        // again every second would not change that.
        if (!refused) onError(new Error(`the master refused this server's key — pair it again with scripts/join.js; retrying every ${Math.round(refusedDelay / 60_000)} min`))
        refused = true
        schedule(refusedDelay)
      } else {
        schedule()
      }
    }
    ws.onclose = event => closed(event?.code)
    // A failed handshake can report an error with no close after it
    ws.onerror = () => {
      if (ws.readyState === 0 || ws.readyState === 3) closed(1006)
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      dial()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      const ws = socket
      socket = null
      connected = false
      dropAsks('stopped')
      ws?.close(1000, 'stopping')
    },
    // Ask the master (nodes/answers.js): a GitHub token, the repo list.
    ask(method, params = {}, { timeoutMs = 20_000 } = {}) {
      const ws = socket
      if (!ws || !connected || ws.readyState !== 1) {
        return Promise.reject(Object.assign(new Error('not connected to the master'), { code: 'offline' }))
      }
      const id = ++askSeq
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          asks.delete(id)
          reject(Object.assign(new Error(`the master did not answer in ${Math.round(timeoutMs / 1000)} s`), { code: 'timeout' }))
        }, timeoutMs)
        asks.set(id, { resolve, reject, timer })
        ws.send(JSON.stringify({ ch: 'ask', id, method, params }))
      })
    },
    get connected() {
      return connected
    },
    url,
  }
}
