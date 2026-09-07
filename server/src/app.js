import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { serveStatic } from 'hono/bun'
import { existsSync } from 'node:fs'
import { requireSession, requireAdmin, getSession, COOKIE_NAME } from './auth/sessions.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { deploymentRoutes } from './routes/deployments.js'
import { githubRoutes, settingsRoutes } from './routes/github.js'
import { webhookRoutes } from './routes/webhooks.js'
import { systemRoutes } from './routes/system.js'
import { userRoutes } from './routes/users.js'
import { accountRoutes } from './routes/account.js'
import { proxyApiRoutes } from './routes/proxy.js'
import { imageRoutes } from './routes/images.js'

export function createApp({ db, config, liveState, hub, runner, github, poller, proxy, upgradeWebSocket }) {
  const app = new Hono()

  app.onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ error: 'internal error' }, 500)
  })

  // Public routes first: webhook (HMAC-authenticated) and login.
  app.route('/api/webhooks', webhookRoutes({ db, config, runner, liveState }))
  app.route('/api/auth', authRoutes({ db, config }))

  // Everything else under /api requires a valid session.
  app.use('/api/*', requireSession(db))
  // Multi-tenant boundary: these groups configure the panel itself.
  for (const group of ['settings', 'system', 'users', 'proxy', 'images']) {
    app.use(`/api/${group}`, requireAdmin())
    app.use(`/api/${group}/*`, requireAdmin())
  }
  app.route('/api/projects', projectRoutes({ db, config, liveState, runner, poller, github, proxy }))
  app.route('/api/deployments', deploymentRoutes({ db, runner }))
  app.route('/api/github', githubRoutes({ db, config, github }))
  app.route('/api/settings', settingsRoutes({ db, config, github }))
  app.route('/api/system', systemRoutes({ db, config, poller }))
  app.route('/api/users', userRoutes({ db, liveState }))
  app.route('/api/account', accountRoutes({ db })) // self-service — every role
  app.route('/api/proxy', proxyApiRoutes({ db, proxy, liveState }))
  app.route('/api/images', imageRoutes({ db, config, liveState }))

  // WebSocket: session is validated before the upgrade happens.
  app.get(
    '/ws',
    async (c, next) => {
      const cookie = getCookie(c, COOKIE_NAME)
      const session = getSession(db, cookie)
      if (!session) {
        console.log(`[ws] unauthorized connection attempt (cookie: ${cookie ? 'present' : 'missing'})`)
        return c.text('unauthorized', 401)
      }
      // The socket keeps the identity it connected with (a mid-connection
      // role change applies on reconnect) — the hub uses it to gate what
      // the live stream may carry to this client.
      c.set('wsUser', db.query('SELECT id, role FROM users WHERE id = ?').get(session.user_id) ?? null)
      await next()
    },
    upgradeWebSocket(c => ({
      onOpen: (_evt, ws) => {
        console.log('[ws] connection opened')
        hub.add(ws.raw, c.get('wsUser'))
      },
      onMessage: (evt, ws) => hub.handleMessage(ws.raw, evt.data),
      onClose: (_evt, ws) => {
        console.log('[ws] connection closed')
        hub.remove(ws.raw)
      },
    }))
  )

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
