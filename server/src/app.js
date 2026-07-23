import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { requireSession, getSession, COOKIE_NAME } from './auth/sessions.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { deploymentRoutes } from './routes/deployments.js'
import { githubRoutes, settingsRoutes } from './routes/github.js'
import { webhookRoutes } from './routes/webhooks.js'
import { systemRoutes } from './routes/system.js'

export function createApp({ db, config, liveState, hub, runner, github, poller, upgradeWebSocket }) {
  const app = new Hono()

  app.onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ error: 'internal error' }, 500)
  })

  // Public routes first: webhook (HMAC-authenticated) and login.
  app.route('/api/webhooks', webhookRoutes({ db, config, runner }))
  app.route('/api/auth', authRoutes({ db, config }))

  // Everything else under /api requires a valid session.
  app.use('/api/*', requireSession(db))
  app.route('/api/projects', projectRoutes({ db, config, liveState, runner, poller }))
  app.route('/api/deployments', deploymentRoutes({ db, runner }))
  app.route('/api/github', githubRoutes({ db, config, github }))
  app.route('/api/settings', settingsRoutes({ db, config, github }))
  app.route('/api/system', systemRoutes({ config }))

  // WebSocket: session is validated before the upgrade happens.
  app.get(
    '/ws',
    async (c, next) => {
      const session = getSession(db, getCookie(c, COOKIE_NAME))
      if (!session) return c.text('unauthorized', 401)
      await next()
    },
    upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => hub.add(ws.raw),
      onMessage: (evt, ws) => hub.handleMessage(ws.raw, evt.data),
      onClose: (_evt, ws) => hub.remove(ws.raw),
    }))
  )

  // Static SPA (prod build). In dev, Vite serves the frontend and proxies here.
  if (existsSync(config.webDist)) {
    const indexHtml = join(config.webDist, 'index.html')
    app.get('*', async c => {
      const reqPath = decodeURIComponent(new URL(c.req.url).pathname)
      if (reqPath.startsWith('/api') || reqPath === '/ws') return c.json({ error: 'not found' }, 404)
      const target = resolve(join(config.webDist, '.' + reqPath))
      if (target.startsWith(config.webDist)) {
        const file = Bun.file(target)
        if (await file.exists()) return new Response(file)
      }
      return new Response(Bun.file(indexHtml), { headers: { 'content-type': 'text/html' } })
    })
  }

  return app
}
