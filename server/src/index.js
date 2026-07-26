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
import { createProxy, proxySettings } from './proxy/index.js'
import { GitHubApp } from './github/appClient.js'
import { DeployRunner, recoverInterrupted } from './deploy/runner.js'
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
initLiveState(liveState, db)

const github = new GitHubApp({ db, config })
const poller = createPoller({ db, config, liveState })
const hub = new Hub({
  liveState,
  onClientsChange: n => (n > 0 ? poller.start() : poller.stop()),
})
const runner = new DeployRunner({ db, config, liveState, hub, github })
hub.getLogBacklog = id => runner.getActiveLog(id)

const proxy = createProxy({ db, config })
// Bring the harbor gate back in sync after a restart (config may have changed
// while the panel was down). Failures surface in Rigging, not at boot.
if (proxySettings(db).baseDomain) {
  proxy.apply().catch(err => console.error('[proxy] startup apply failed:', err.message))
}

const { upgradeWebSocket, websocket } = createBunWebSocket()
const app = createApp({ db, config, liveState, hub, runner, github, poller, proxy, upgradeWebSocket })

const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket })
console.log(`Skeppa listening on http://localhost:${server.port} (${config.isProd ? 'production' : 'development'})`)
