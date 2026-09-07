import { Hono } from 'hono'
import { sendNotification, notifyUrl } from '../lib/notify.js'
import { randomBytes } from 'node:crypto'
import {
  getSetting, setSetting, setSecretSetting, deleteSetting,
  getFirebaseConfig, FIREBASE_CONFIG_KEYS,
} from '../db/settings.js'

// GitHub's app-manifest flow: the panel prepares a manifest, the browser
// form-POSTs it to github.com, and GitHub redirects back with a one-time code
// that converts into the new app's credentials. The state ties the callback to
// a creation started from this panel — without it, a crafted link could plant
// an attacker's app credentials into the settings.
const MANIFEST_STATE_TTL_MS = 15 * 60_000
const MANIFEST_CODE_RE = /^[A-Za-z0-9_-]{1,255}$/
const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

export function githubRoutes({ db, config, github }) {
  const app = new Hono()
  const pendingManifestStates = new Map() // state → expiry (ms since epoch)

  // Tenant-reachable: the moor form needs a repo list. A tenant sees only
  // repos from installations owned by their linked GitHub account; without
  // a link they see none (and moor via git URL instead).
  app.get('/repos', async c => {
    const user = c.get('user')
    if (user && user.role !== 'admin' && !user.github_login) return c.json([])
    try {
      return c.json(await github.listRepos(user && user.role !== 'admin' ? user.github_login : null))
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  // Everything below configures the app itself — admin space. Registered
  // after /repos on purpose: Hono middleware only guards routes added
  // after it.
  app.use('*', async (c, next) => {
    if (c.get('user') && c.get('user').role !== 'admin') return c.json({ error: 'admins only' }, 403)
    await next()
  })

  // One call answering the first-run checklist: credentials present? app
  // reachable on GitHub? installed anywhere? how many repos can it see?
  // GitHub-side failures land in `error` rather than failing the request, so
  // the checklist can still render the steps it does know.
  app.get('/setup', async c => {
    const { appId, privateKey, webhookSecret } = github.credentials()
    const out = {
      configured: Boolean(appId && privateKey && webhookSecret),
      app: null,
      install_url: null,
      installed: false,
      repos: null,
      error: null,
    }
    if (!out.configured) return c.json(out)
    try {
      const info = await github.getApp()
      out.app = { name: info.name, slug: info.slug, html_url: info.html_url }
      if (info.slug) out.install_url = `https://github.com/apps/${encodeURIComponent(info.slug)}/installations/new`
      out.installed = (await github.listInstallations()).length > 0
      if (out.installed) out.repos = (await github.listRepos()).length
    } catch (err) {
      out.error = err.message
    }
    return c.json(out)
  })

  app.get('/webhook-deliveries', async c => {
    try {
      return c.json(await github.listWebhookDeliveries())
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  app.post('/webhook-deliveries/:id/redeliver', async c => {
    const id = c.req.param('id')
    if (!/^\d+$/.test(id)) return c.json({ error: 'malformed delivery id' }, 400)
    try {
      await github.redeliverWebhookDelivery(id)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  // Prepare the handoff to GitHub. The frontend supplies its origin (the
  // panel only knows localhost behind the proxy) and submits the returned
  // manifest to the returned action URL as a top-level form POST.
  app.post('/manifest', async c => {
    const body = await c.req.json().catch(() => ({}))
    let origin
    try {
      const url = new URL(String(body.origin ?? ''))
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol')
      origin = url.origin
    } catch {
      return c.json({ error: 'origin must be an http(s) URL' }, 400)
    }
    const organization = String(body.organization ?? '').trim()
    if (organization && !GITHUB_ORG_RE.test(organization)) {
      return c.json({ error: 'organization must be a GitHub organization name' }, 400)
    }

    for (const [state, expiresAt] of pendingManifestStates) {
      if (expiresAt < Date.now()) pendingManifestStates.delete(state)
    }
    const state = randomBytes(16).toString('hex')
    pendingManifestStates.set(state, Date.now() + MANIFEST_STATE_TTL_MS)

    // App names are ≤34 chars and editable on GitHub's confirmation page —
    // this is only a suggestion.
    const host = new URL(origin).hostname
    const name = `skeppa-${host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 34).replace(/-+$/, '')
    return c.json({
      action: organization
        ? `https://github.com/organizations/${organization}/settings/apps/new?state=${state}`
        : `https://github.com/settings/apps/new?state=${state}`,
      state,
      manifest: {
        name,
        url: origin,
        description: 'Created by Skeppa — deploys pushes to this server.',
        hook_attributes: { url: `${origin}/api/webhooks/github` },
        redirect_url: `${origin}/settings`, // back to the settings page with ?code=&state=
        setup_url: `${origin}/settings`, // and back again after the user installs the app
        public: false,
        default_permissions: { contents: 'read', metadata: 'read' },
        default_events: ['push'],
      },
    })
  })

  // Complete the flow: swap the callback code for credentials and store them
  // exactly like the manually pasted ones.
  app.post('/manifest/convert', async c => {
    const body = await c.req.json().catch(() => ({}))
    const code = String(body.code ?? '')
    const state = String(body.state ?? '')
    if (!MANIFEST_CODE_RE.test(code)) return c.json({ error: 'malformed code' }, 400)
    const expiresAt = pendingManifestStates.get(state)
    if (!expiresAt || expiresAt < Date.now()) {
      return c.json({
        error:
          'this app creation is unknown or expired — press Create GitHub App again ' +
          '(if the app already exists on GitHub, paste its credentials manually instead)',
      }, 400)
    }
    pendingManifestStates.delete(state)

    let converted
    try {
      converted = await github.convertManifestCode(code)
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
    if (!converted?.id || !converted.slug || !converted.pem || !converted.webhook_secret) {
      return c.json({ error: 'GitHub returned an incomplete app — create it manually instead' }, 502)
    }
    setSetting(db, 'github_app_id', String(converted.id))
    setSecretSetting(db, config.masterKey, 'github_private_key', converted.pem)
    setSecretSetting(db, config.masterKey, 'github_webhook_secret', converted.webhook_secret)
    github.reset()
    return c.json({
      app_id: String(converted.id),
      slug: converted.slug,
      install_url: `https://github.com/apps/${encodeURIComponent(converted.slug)}/installations/new`,
    })
  })

  return app
}

const hostOf = url => {
  try {
    return url ? new URL(url).hostname : ''
  } catch {
    return ''
  }
}

export function settingsRoutes({ db, config, github, notifyFn = sendNotification }) {
  const app = new Hono()

  // Secrets are write-only through this API: only presence is reported back.
  app.get('/', c => {
    return c.json({
      github_app_id: getSetting(db, 'github_app_id'),
      has_private_key: getSetting(db, 'github_private_key') != null,
      has_webhook_secret: getSetting(db, 'github_webhook_secret') != null,
      firebase_config: getFirebaseConfig(db),
      // The webhook URL is a credential: presence and host only, like the
      // other secrets — enough for the form to say what is configured.
      has_notify_url: Boolean(notifyUrl(db, config.masterKey)),
      notify_url_host: hostOf(notifyUrl(db, config.masterKey)),
    })
  })

  // One message through the configured webhook, so the URL can be verified
  // from the form instead of by waiting for something to break.
  app.post('/notify/test', async c => {
    if (!notifyUrl(db, config.masterKey)) return c.json({ error: 'no webhook URL configured' }, 400)
    const ok = await notifyFn(db, config.masterKey, '⛵ Test notification from Skeppa — failed deploys and restart bursts will look like this.')
    return c.json({ ok }, ok ? 200 : 502)
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
    if ('notify_url' in body) {
      const raw = typeof body.notify_url === 'string' ? body.notify_url.trim() : ''
      if (!raw) {
        deleteSetting(db, 'notify_url')
      } else {
        let parsed
        try {
          parsed = new URL(raw)
        } catch {
          return c.json({ error: 'notify_url must be a valid URL' }, 400)
        }
        if (!/^https?:$/.test(parsed.protocol) || raw.length > 2000) {
          return c.json({ error: 'notify_url must be an http(s) URL' }, 400)
        }
        setSecretSetting(db, config.masterKey, 'notify_url', raw)
      }
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
