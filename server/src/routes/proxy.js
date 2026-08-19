import { Hono } from 'hono'
import { setSetting, deleteSetting } from '../db/settings.js'
import { DOMAIN_RE, isValidPort } from '../lib/validate.js'
import { getProxyInfo } from '../live/state.js'

export function proxyApiRoutes({ db, proxy, liveState = null }) {
  const app = new Hono()

  app.get('/', async c => c.json(await proxy.status()))

  app.put('/', async c => {
    const body = await c.req.json().catch(() => ({}))

    // Validate every field before writing any of them. Settings used to be
    // committed as they were parsed, so a bad port after a good domain left
    // the domain saved while the 400 skipped the LiveState push and the Caddy
    // reload — the database, every open client and the running proxy then
    // disagreed until the panel restarted.
    const pending = [] // [key, value] — a null value means delete
    let cleared = false

    if ('base_domain' in body) {
      const domain = typeof body.base_domain === 'string' ? body.base_domain.trim().toLowerCase() : ''
      if (!domain) {
        pending.push(['proxy_base_domain', null])
        cleared = true
      } else if (!DOMAIN_RE.test(domain)) {
        return c.json({ error: 'validation failed', fields: { base_domain: 'not a valid domain name' } }, 400)
      } else {
        pending.push(['proxy_base_domain', domain])
      }
    }
    for (const [field, setting] of [['http_port', 'proxy_http_port'], ['admin_port', 'proxy_admin_port']]) {
      if (field in body) {
        const port = Number(body[field])
        if (!isValidPort(port)) {
          return c.json({ error: 'validation failed', fields: { [field]: 'must be a port between 1 and 65535' } }, 400)
        }
        pending.push([setting, String(port)])
      }
    }

    for (const [key, value] of pending) {
      if (value === null) deleteSetting(db, key)
      else setSetting(db, key, value)
    }

    // The base domain is part of LiveState, so every open client's app links
    // follow the change without refetching anything.
    if (liveState) liveState.proxy = getProxyInfo(db)

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
