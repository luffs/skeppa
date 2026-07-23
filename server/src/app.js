import { Hono } from 'hono'
import {cors} from 'hono/cors'
import { getCookie } from 'hono/cookie'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { requireSession, getSession, COOKIE_NAME } from './auth/sessions.js'
import { authRoutes } from './routes/auth.js'
import { projectRoutes } from './routes/projects.js'
import { deploymentRoutes } from './routes/deployments.js'
import { githubRoutes, settingsRoutes } from './routes/github.js'
import { webhookRoutes } from './routes/webhooks.js'

export function createApp({ db, config, liveState, hub, runner, github, poller, upgradeWebSocket }) {
  const app = new Hono()

  app.onError((err, c) => {
    console.error('unhandled error:', err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.use('*', cors({
    origin: (origin, c) => {
      if (!origin) return null
      try {
        const url = new URL(origin)
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin
        if (config.isProd && origin === config.skeppaApi) return origin
      } catch {
      }
      return null
    },
    credentials: true,
  }))

  // Public routes first: webhook (HMAC-authenticated) and login.
  app.route('/api/webhooks', webhookRoutes({ db, config, runner, liveState }))
  app.route('/api/auth', authRoutes({ db, config }))

  // Everything else under /api requires a valid session.
  app.use('/api/*', requireSession(db))
  app.route('/api/projects', projectRoutes({ db, config, liveState, runner, poller, github }))
  app.route('/api/deployments', deploymentRoutes({ db, runner }))
  app.route('/api/github', githubRoutes({ db, config, github }))
  app.route('/api/settings', settingsRoutes({ db, config, github }))

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
      await next()
    },
    upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => {
        console.log('[ws] connection opened')
        hub.add(ws.raw)
      },
      onMessage: (evt, ws) => hub.handleMessage(ws.raw, evt.data),
      onClose: (_evt, ws) => {
        console.log('[ws] connection closed')
        hub.remove(ws.raw)
      },
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
