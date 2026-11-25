import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { existsSync } from 'node:fs'
import { requireSession, requireAdmin } from './auth/sessions.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { groupRoutes } from './routes/groups.js'
import { deploymentRoutes } from './routes/deployments.js'
import { githubRoutes, settingsRoutes } from './routes/github.js'
import { webhookRoutes } from './routes/webhooks.js'
import { systemRoutes } from './routes/system.js'
import { userRoutes } from './routes/users.js'
import { accountRoutes } from './routes/account.js'
import { proxyApiRoutes } from './routes/proxy.js'
import { imageRoutes } from './routes/images.js'
import { nodeRoutes, nodeJoinRoutes } from './routes/nodes.js'

// The WebSocket is not here: lazy-storage serves live state and deploy logs
// at /live, mounted ahead of this app in index.js.
// Whether this panel serves its own UI: always, unless it is a Fleet agent
// without AGENT_LOCAL_UI.
export const hasLocalUi = config => !config.masterUrl || Boolean(config.agentLocalUi)

export function createApp({ db, config, liveState, runner, github, poller, proxy, links = null, logs = null }) {
  const app = new Hono()

  app.onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ error: 'internal error' }, 500)
  })

  // Public routes first: webhook (HMAC-authenticated) and login.
  app.route('/api/webhooks', webhookRoutes({ db, config, runner, liveState, github, onPush: links ? push => links.forwardPush(push) : null }))

  // An agent is run from its master: no sign-in, no API, no page of its own
  // (index.js keeps /live shut too) — unless AGENT_LOCAL_UI turns its own
  // panel back on, for when the master is gone. Its webhook route stays, for
  // an App of its own.
  if (!hasLocalUi(config)) {
    const said = `This server is run from its master, ${config.masterUrl}. Its own panel is off — AGENT_LOCAL_UI=true in its config turns it back on.`
    app.all('/api/*', c => c.json({ error: said }, 404))
    app.all('*', c => c.text(said, 404))
    return app
  }

  app.route('/api/auth', authRoutes({ db, config }))
  // An agent pairing itself: the one-time code is the credential.
  if (links) app.route('/api/nodes/join', nodeJoinRoutes({ db, links }))

  // Everything else under /api requires a valid session.
  app.use('/api/*', requireSession(db))
  // Multi-tenant boundary: these groups configure the panel itself.
  for (const group of ['settings', 'system', 'users', 'proxy', 'images', 'nodes']) {
    app.use(`/api/${group}`, requireAdmin())
    app.use(`/api/${group}/*`, requireAdmin())
  }
  app.route('/api/projects', projectRoutes({ db, config, liveState, runner, poller, github, proxy }))
  app.route('/api/groups', groupRoutes({ db, config, liveState, runner })) // piers — every role, own only
  app.route('/api/deployments', deploymentRoutes({ db, runner }))
  app.route('/api/github', githubRoutes({ db, config, github }))
  app.route('/api/settings', settingsRoutes({ db, config, github }))
  app.route('/api/system', systemRoutes({ db, config, poller }))
  app.route('/api/users', userRoutes({ db, liveState, proxy, github }))
  app.route('/api/account', accountRoutes({ db })) // self-service — every role
  app.route('/api/proxy', proxyApiRoutes({ db, proxy, liveState }))
  app.route('/api/images', imageRoutes({ db, config, liveState, logs }))
  if (links) app.route('/api/nodes', nodeRoutes({ db, links }))

  // Static SPA (prod build). In dev, Vite serves the frontend and proxies here.
  // serveStatic handles Content-Type and rejects traversal ('..', '\', '//').
  if (existsSync(config.webDist)) {
    // Unknown API/WS paths must 404 as JSON, not fall through to the SPA page.
    app.all('/api/*', c => c.json({ error: 'not found' }, 404))
    app.all('/ws', c => c.json({ error: 'not found' }, 404))
    app.use('*', serveStatic({ root: config.webDist }))
    app.get('*', serveStatic({ root: config.webDist, path: 'index.html' }))
  }

  return app
}

// Agent mode: the API the master reaches through the uplink's `request`
// method (agent/uplink.js), which only lets FLEET_PATHS through. The same
// route modules as the panel's own, so every check they make is made — as
// this server's first admin, the master acting as that admin. No session,
// no cookie: the uplink's key already said who is asking.
export function createFleetApiApp({ db, config, liveState, runner, github, poller, proxy, logs = null }) {
  const app = new Hono()
  app.onError((err, c) => {
    console.error('unhandled error (fleet request):', err)
    return c.json({ error: 'internal error' }, 500)
  })
  app.use('/api/*', async (c, next) => {
    const user = db.query("SELECT id, username, role, handle, github_login FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
    if (!user) return c.json({ error: 'this server has no admin to act as' }, 503)
    c.set('user', user)
    c.set('session', { id: 'fleet-master', user_id: user.id })
    await next()
  })
  app.route('/api/projects', projectRoutes({ db, config, liveState, runner, poller, github, proxy }))
  app.route('/api/groups', groupRoutes({ db, config, liveState, runner }))
  app.route('/api/deployments', deploymentRoutes({ db, runner }))
  app.route('/api/github', githubRoutes({ db, config, github }))
  // Its admin pages, as the master shows them (FLEET_PATHS picks what of them)
  app.route('/api/settings', settingsRoutes({ db, config, github }))
  app.route('/api/system', systemRoutes({ db, config, poller }))
  app.route('/api/proxy', proxyApiRoutes({ db, proxy, liveState }))
  app.route('/api/images', imageRoutes({ db, config, liveState, logs }))
  app.all('*', c => c.json({ error: 'not found' }, 404))
  return app
}
