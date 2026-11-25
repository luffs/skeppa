import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, rootDir } from './config.js'
import { openDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { pruneSessions } from './auth/sessions.js'
import { createLiveState, initLiveState } from './live/state.js'
import { createLiveStores } from './live/stores.js'
import { createLiveTransport } from './live/transport.js'
import { createPoller } from './live/poller.js'
import { notifyEvent, notifyUrl, upgradeNotifyUrl } from './lib/notify.js'
import { createProxy, proxySettings, projectPublicUrl } from './proxy/index.js'
import { GitHubApp } from './github/appClient.js'
import { DeployRunner, recoverInterrupted } from './deploy/runner.js'
import { resurrectApps } from './deploy/resurrect.js'
import { createApp, createFleetApiApp, hasLocalUi } from './app.js'
import { createNodeLinks } from './nodes/links.js'
import { sqliteStorage } from 'lazy-storage/server/sqlite'
import { createFleetAnswers } from './nodes/answers.js'
import { recordEvent } from './nodes/events.js'
import { createDiskWatch } from './lib/diskwatch.js'
import { createBackups } from './lib/backups.js'
import { createUplink, readAgentKey, checkoutVersion } from './agent/uplink.js'
import { FleetGitHub } from './agent/github.js'

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })

const db = openDb(join(config.dataDir, 'skeppa.db'))
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations')
const ran = migrate(db, migrationsDir)
if (ran.length) console.log(`migrations applied: ${ran.join(', ')}`)

const interrupted = recoverInterrupted(db)
if (interrupted) console.log(`marked ${interrupted} interrupted deployment(s) as failed`)
pruneSessions(db)

if (!db.query('SELECT 1 FROM users LIMIT 1').get()) {
  console.log('no users yet — create the admin with:  bun scripts/seed.js <username> <password>')
}

const liveState = createLiveState()
initLiveState(liveState, db, config)

// Agent mode: the master's GitHub App, lent over the uplink, unless this
// panel has one of its own (agent/github.js). `uplink` is made further down.
let uplink = null
const github = config.masterUrl
  ? new FleetGitHub({
    db, config,
    ask: (method, params) => (uplink ? uplink.ask(method, params) : Promise.reject(new Error('not connected to the master'))),
  })
  : new GitHubApp({ db, config })
// Where a notification links to: the project's routed address, or nothing.
// Never throws — a notification must not break the deploy or the poll.
const urlOfProject = projectId => {
  try {
    return projectId ? projectPublicUrl(db, projectId) : ''
  } catch {
    return ''
  }
}
// The commit this checkout is at: in the system record (the Fleet page compares
// it) and in an agent's hello to its master.
const panelVersion = checkoutVersion(rootDir)
// Every notification this panel sends goes through here. A Fleet agent with
// no webhook of its own sends its notifications to the master, which sends
// them through its own under this server's name (nodes/answers.js notify):
// one webhook for the whole fleet. `uplink` is made further down.
const sendEvent = (event, text, { url = '' } = {}) => {
  if (config.masterUrl && !notifyUrl(db, config.masterKey)) {
    const asked = uplink ? uplink.ask('notify', { event, text, url }) : Promise.reject(new Error('not connected to the master'))
    return asked.then(r => Boolean(r?.sent), err => {
      console.error(`[notify] through the master: ${err.message}`)
      return false
    })
  }
  return notifyEvent(db, config.masterKey, event, text, { url })
}
// This panel's database, backed up by the panel and watched (lib/backups.js).
const backups = createBackups({
  dbPath: join(config.dataDir, 'skeppa.db'),
  dir: config.backup.dir,
  everyMs: config.backup.everyHours * 3_600_000,
  keep: config.backup.keep,
  notify: text => sendEvent('backup', text),
})
const poller = createPoller({
  db, config, liveState, version: panelVersion,
  backup: () => backups.info(),
  onCrashAlert: (label, count, projectId) =>
    sendEvent('restart_burst', `⚠ ${label} restarted ${count} times in the last 10 minutes — check the Engine room`, { url: urlOfProject(projectId) }),
})
// A webhook URL saved by an older version sits in plaintext — encrypt it
// before this boot writes anything else, so the next backup is clean.
if (upgradeNotifyUrl(db, config.masterKey)) console.log('notify_url: legacy plaintext value now stored encrypted')

// Live state and deploy logs reach browsers as lazy-storage stores at /live.
// The poller polls fast while anyone is looking — here, or on the master
// this panel reports to (agent mode).
const looking = { here: false, master: false }
const cadence = () => poller.setFast(looking.here || looking.master)
const liveStores = createLiveStores({
  // Agent mode: one more store, everything for the master (agent/uplink.js).
  uplink: Boolean(config.masterUrl),
  liveState,
  // Deploy logs echo env values: a tenant may only follow their own
  // deployments. Admins pass.
  canReadDeployment: (user, deploymentId) => {
    if (user.role === 'admin') return true
    const row = db.query(
      'SELECT p.owner_id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.id = ?'
    ).get(deploymentId)
    return row?.owner_id === user.id
  },
  onSessionsChange: n => {
    looking.here = n > 0
    cadence()
  },
})
// Other Skeppa servers reporting to this one: their sockets at /agent, and
// what they report as stores next to the panel's own (nodes/links.js).
// What agents ask of this panel: its GitHub App, lent one repo at a time.
let answers = null
const minutes = ms => Math.max(1, Math.round(ms / 60_000))
const NODE_ALERT_MS = 5 * 60_000 // a fleet server away this long is worth a notification
const links = createNodeLinks({
  db, liveState,
  onAsk: (nodeId, method, params) => answers.answer(nodeId, method, params),
  // What each server last reported survives a restart here: the Fleet page
  // has something to show, and pushes for its repos are kept for it, before
  // it dials in again. A cache — rebuilt from the agent, so no lease (a
  // self-deploy's overlap may share it) and not in the backups.
  storage: sqliteStorage(join(config.dataDir, 'fleet-mirror.sqlite'), { lease: false }),
  offlineAlertMs: NODE_ALERT_MS,
  // Away and back go into the Fleet's log (nodes/events.js) as well as out
  // as notifications.
  onNodeDown: (row, lastSeen) => {
    recordEvent(db, { nodeId: row.id, nodeName: row.name, action: 'offline', subject: lastSeen ? `last seen ${lastSeen}` : '' })
    return sendEvent('node_offline',
      `⚠ ${row.name} has not reported for ${minutes(NODE_ALERT_MS)} minutes${lastSeen ? ` — last seen ${lastSeen.replace('T', ' ').slice(0, 16)} UTC` : ''}. Its apps keep running; it just cannot be reached from here.`)
  },
  onNodeUp: (row, awayMs) => {
    if (row) recordEvent(db, { nodeId: row.id, nodeName: row.name, action: 'back', subject: `after about ${minutes(awayMs)} min` })
    return sendEvent('node_offline',
      `✔ ${row?.name ?? 'A fleet server'} reports again, after about ${minutes(awayMs)} minutes away.`)
  },
})
answers = createFleetAnswers({ github, links, db, masterKey: config.masterKey })
// Always on: the crash watch must run with nobody looking. Clients connecting
// only switch the cadence from idle to live.
poller.start()
// This panel's disk, once a minute: nearly full is a notification (lib/diskwatch.js).
const diskWatch = createDiskWatch({
  read: () => liveState.system?.disk,
  notify: text => sendEvent('disk_full', text),
})
setInterval(() => {
  diskWatch.check()
  backups.check()
}, 60_000).unref?.()
backups.start()
const runner = new DeployRunner({
  db, config, liveState, logs: liveStores, github, poller,
  notify: (event, text, { projectId } = {}) => sendEvent(event, text, { url: urlOfProject(projectId) }),
  // A deploy that changes what a project is served as moves its route
  // (`proxy` is created just below; this only runs once a deploy finishes).
  applyProxy: () => proxy.apply(),
})

const proxy = createProxy({ db, config })
// Bring the harbor gate back in sync after a restart (config may have changed
// while the panel was down). Failures surface in Rigging, not at boot.
if (proxySettings(db).baseDomain) {
  proxy.apply().catch(err => console.error('[proxy] startup apply failed:', err.message))
}

// After a server reboot, deployed apps are not in the pm2 dump (saving them
// would write their decrypted env to disk) — the panel starts them itself.
resurrectApps({ db, config }).catch(err => console.error('[resurrect] failed:', err.message))

const app = createApp({ db, config, liveState, runner, github, poller, proxy, links, logs: liveStores })
// One /live socket for both: the panel's own stores, and its nodes'.
const live = createLiveTransport({
  db,
  liveStores: {
    get: id => (links.owns(id) ? links.get(id) : liveStores.get(id)),
    canOpen: (user, id) => (links.owns(id) ? links.canOpen(user, id) : liveStores.canOpen(user, id)),
  },
})
// Bun has one websocket handler per server: the agents' sockets carry
// `skeppaNode` in their data, everything else is lazy-storage's.
const websocket = { ...live.websocket }
for (const [name, handler] of Object.entries(live.websocket)) {
  if (typeof handler !== 'function') continue
  const own = links.websocket[name]
  websocket[name] = (ws, ...rest) => (links.isNodeSocket(ws) ? own?.(ws, ...rest) : handler(ws, ...rest))
}

// Agent mode: report to the master named in the config.
if (config.masterUrl) {
  try {
    uplink = createUplink({
      masterUrl: config.masterUrl,
      key: readAgentKey(config.agentKeyFile),
      keyFile: config.agentKeyFile,
      db, runner, liveStores, liveState, github,
      fleetApi: createFleetApiApp({ db, config, liveState, runner, github, poller, proxy, logs: liveStores }),
      version: panelVersion,
      onWatch: on => {
        looking.master = on
        cadence()
      },
    })
    if (config.masterUrl.startsWith('http:')) console.warn(`warning: MASTER_URL is plain http — the agent key and everything this server reports travel unencrypted`)
    uplink.start()
  } catch (err) {
    console.error(`[uplink] not reporting to ${config.masterUrl}: ${err.message}`)
  }
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Bun drops a connection whose request has gone 10 s unanswered, and the
  // Caddy in front reports that as a bare 502. Engine calls carry their own
  // longer timers (containers/client.js: 30–120 s, none for a pull), so the
  // default cut them off before their error could become a response. 255 is
  // Bun's ceiling.
  idleTimeout: 255,
  async fetch(req, server) {
    const agent = links.upgrade(req, server) // the agents' sockets at /agent
    if (agent !== null) return agent
    // the /live socket and its snapshot route — not on an agent without its own UI
    const res = hasLocalUi(config) ? await live.upgrade(req, server) : null
    return res === null ? app.fetch(req, server) : res
  },
  websocket,
})
console.log(`Skeppa listening on http://${config.host}:${server.port} (${config.isProd ? 'production' : 'development'})` +
  (config.host === '127.0.0.1' ? ' — loopback only; set HOST=0.0.0.0 in the panel config for direct LAN access' : ''))
