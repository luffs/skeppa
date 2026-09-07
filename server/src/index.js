import { createBunWebSocket } from 'hono/bun'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { pruneSessions } from './auth/sessions.js'
import { createLiveState, initLiveState } from './live/state.js'
import { Hub } from './live/hub.js'
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

const hub = new Hub({
  liveState,
  onClientsChange: n => poller.setFast(n > 0),
})
// Always on: the crash watch must run with nobody looking. Clients connecting
// only switch the cadence from idle to live.
poller.start()
const runner = new DeployRunner({
  db, config, liveState, hub, github, poller,
  notify: text => sendNotification(db, config.masterKey, text),
})
hub.getLogBacklog = id => runner.getActiveLog(id)
// Deploy logs echo env values: tenant sockets follow only their own
// deployments. Admin sockets (and sockets without a user, which the
// upgrade never produces) pass.
hub.canReadDeployment = (user, deploymentId) => {
  if (!user || user.role === 'admin') return true
  const row = db.query(
    'SELECT p.owner_id FROM deployments d JOIN projects p ON p.id = d.project_id WHERE d.id = ?'
  ).get(deploymentId)
  return row?.owner_id === user.id
}

const proxy = createProxy({ db, config })
// Bring the harbor gate back in sync after a restart (config may have changed
// while the panel was down). Failures surface in Rigging, not at boot.
if (proxySettings(db).baseDomain) {
  proxy.apply().catch(err => console.error('[proxy] startup apply failed:', err.message))
}

// After a server reboot, deployed apps are not in the pm2 dump (saving them
// would write their decrypted env to disk) — the panel starts them itself.
resurrectApps({ db, config }).catch(err => console.error('[resurrect] failed:', err.message))

const { upgradeWebSocket, websocket } = createBunWebSocket()
const app = createApp({ db, config, liveState, hub, runner, github, poller, proxy, upgradeWebSocket })

const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch, websocket })
console.log(`Skeppa listening on http://${config.host}:${server.port} (${config.isProd ? 'production' : 'development'})` +
  (config.host === '127.0.0.1' ? ' — loopback only; set HOST=0.0.0.0 in the panel config for direct LAN access' : ''))
