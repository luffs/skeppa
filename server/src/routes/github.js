import { Hono } from 'hono'
import { getSetting, setSetting, setSecretSetting } from '../db/settings.js'

export function githubRoutes({ db, config, github }) {
  const app = new Hono()

  app.get('/repos', async c => {
    try {
      return c.json(await github.listRepos())
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  return app
}

export function settingsRoutes({ db, config, github }) {
  const app = new Hono()

  // Secrets are write-only through this API: only presence is reported back.
  app.get('/', c => {
    return c.json({
      github_app_id: getSetting(db, 'github_app_id'),
      has_private_key: getSetting(db, 'github_private_key') != null,
      has_webhook_secret: getSetting(db, 'github_webhook_secret') != null,
    })
  })

  app.put('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    if (body.github_app_id != null) {
      if (!/^\d+$/.test(String(body.github_app_id).trim())) {
        return c.json({ error: 'github_app_id must be numeric' }, 400)
      }
      setSetting(db, 'github_app_id', String(body.github_app_id).trim())
    }
    if (typeof body.github_private_key === 'string' && body.github_private_key.trim()) {
      const pem = body.github_private_key.trim()
      if (!pem.includes('PRIVATE KEY')) return c.json({ error: 'github_private_key must be a PEM private key' }, 400)
      setSecretSetting(db, config.masterKey, 'github_private_key', pem)
    }
    if (typeof body.github_webhook_secret === 'string' && body.github_webhook_secret.trim()) {
      setSecretSetting(db, config.masterKey, 'github_webhook_secret', body.github_webhook_secret.trim())
    }
    github.reset()
    return c.json({ ok: true })
  })

  return app
}
