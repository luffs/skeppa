import { Hono } from 'hono'
import {
  getSetting, setSetting, setSecretSetting, deleteSetting,
  getFirebaseConfig, FIREBASE_CONFIG_KEYS,
} from '../db/settings.js'

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
      firebase_config: getFirebaseConfig(db),
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
    if ('firebase_config' in body) {
      if (body.firebase_config === null) {
        deleteSetting(db, 'firebase_config')
      } else {
        const cfg = body.firebase_config
        if (typeof cfg !== 'object' || Array.isArray(cfg)) {
          return c.json({ error: 'firebase_config must be an object or null' }, 400)
        }
        if (typeof cfg.apiKey !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(cfg.apiKey)) {
          return c.json({ error: 'firebase_config.apiKey is missing or malformed' }, 400)
        }
        const kept = {}
        for (const key of FIREBASE_CONFIG_KEYS) {
          if (typeof cfg[key] === 'string' && cfg[key].length <= 256) kept[key] = cfg[key]
        }
        setSetting(db, 'firebase_config', JSON.stringify(kept))
      }
    }
    github.reset()
    return c.json({ ok: true })
  })

  return app
}
