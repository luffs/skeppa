import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { pruneSessions } from './auth/sessions.js'
import { createLiveState, initLiveState } from './live/state.js'
import { createLiveStores } from './live/stores.js'
import { createLiveTransport } from './live/transport.js'
import { createPoller } from './live/poller.js'
import { sendNotification, upgradeNotifyUrl } from './lib/notify.js'
import { createProxy, proxySettings } from './proxy/index.js'
import { GitHubApp } from './github/appClient.js'
import { DeployRunner, recoverInterrupted } from './deploy/runner.js'
import { resurrectApps } from './deploy/resurrect.js'
import { createApp } from './app.js'

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

const github = new GitHubApp({ db, config })
const poller = createPoller({
  db, config, liveState,
  onCrashAlert: (label, count) =>
    sendNotification(db, config.masterKey, `⚠ ${label} restarted ${count} times in the last 10 minutes — check the Engine room`),
})
// A webhook URL saved by an older version sits in plaintext — encrypt it
// before this boot writes anything else, so the next backup is clean.
if (upgradeNotifyUrl(db, config.masterKey)) console.log('notify_url: legacy plaintext value now stored encrypted')

// Live state and deploy logs reach browsers as lazy-storage stores at /live.
// The poller polls fast while anyone is looking.
const liveStores = createLiveStores({
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
  onSessionsChange: n => poller.setFast(n > 0),
})
// Always on: the crash watch must run with nobody looking. Clients connecting
// only switch the cadence from idle to live.
poller.start()
const runner = new DeployRunner({
  db, config, liveState, logs: liveStores, github, poller,
  notify: text => sendNotification(db, config.masterKey, text),
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

const app = createApp({ db, config, liveState, runner, github, poller, proxy })
const live = createLiveTransport({ db, liveStores })

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(req, server) {
    const res = await live.upgrade(req, server) // the /live socket and its snapshot route
    return res === null ? app.fetch(req, server) : res
  },
  websocket: live.websocket,
})
console.log(`Skeppa listening on http://${config.host}:${server.port} (${config.isProd ? 'production' : 'development'})` +
  (config.host === '127.0.0.1' ? ' — loopback only; set HOST=0.0.0.0 in the panel config for direct LAN access' : ''))
