import { Hono } from 'hono'
import { setSetting, deleteSetting } from '../db/settings.js'
import { DOMAIN_RE, isValidPort } from '../lib/validate.js'

export function proxyApiRoutes({ db, proxy }) {
  const app = new Hono()

  app.get('/', async c => c.json(await proxy.status()))

  app.put('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    let cleared = false

    if ('base_domain' in body) {
      const domain = typeof body.base_domain === 'string' ? body.base_domain.trim().toLowerCase() : ''
      if (!domain) {
        deleteSetting(db, 'proxy_base_domain')
        cleared = true
      } else if (!DOMAIN_RE.test(domain)) {
        return c.json({ error: 'validation failed', fields: { base_domain: 'not a valid domain name' } }, 400)
      } else {
        setSetting(db, 'proxy_base_domain', domain)
      }
    }
    for (const [field, setting] of [['http_port', 'proxy_http_port'], ['admin_port', 'proxy_admin_port']]) {
      if (field in body) {
        const port = Number(body[field])
        if (!isValidPort(port)) {
          return c.json({ error: 'validation failed', fields: { [field]: 'must be a port between 1 and 65535' } }, 400)
        }
        setSetting(db, setting, String(port))
      }
    }

    // Apply failures are not fatal to saving — they surface via last_error.
    if (cleared) await proxy.stop().catch(() => {})
    else await proxy.apply().catch(() => {})
    return c.json(await proxy.status())
  })

  app.post('/apply', async c => {
    try {
      await proxy.apply()
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
    return c.json(await proxy.status())
  })

  return app
}
