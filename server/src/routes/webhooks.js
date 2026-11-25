import { Hono } from 'hono'
import { getSecretSetting } from '../db/settings.js'
import { verifySignature } from '../github/webhook.js'
import { applyPush, pushSlice } from '../github/push.js'

// No session on this route — authentication is the HMAC signature.
// Respond quickly; the actual deploy work happens asynchronously.
// `onPush(slice)` hands a verified push on to the Fleet and says to how many
// servers it went.
export function webhookRoutes({ db, config, runner, liveState, github = null, onPush = null }) {
  const app = new Hono()

  app.post('/github', async c => {
    const secret = getSecretSetting(db, config.masterKey, 'github_webhook_secret')
    if (!secret) return c.json({ error: 'webhook secret not configured' }, 503)

    const raw = await c.req.text()
    if (!verifySignature(secret, raw, c.req.header('x-hub-signature-256'))) {
      return c.json({ error: 'invalid signature' }, 401)
    }

    const event = c.req.header('x-github-event')
    if (event === 'ping') return c.json({ pong: true })
    // The repo picker's cache: which repos an installation holds changed.
    const LISTING_EVENTS = ['installation', 'installation_repositories', 'repository']
    if (event !== 'push' && !LISTING_EVENTS.includes(event)) return c.json({ ignored: event })

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'invalid JSON payload' }, 400)
    }
    if (LISTING_EVENTS.includes(event)) {
      github?.forgetRepos(payload.installation?.id ?? null)
      return c.json({ forgotten: event })
    }
    if (payload.deleted) return c.json({ ignored: 'branch deleted' })
    const { matched, queued } = applyPush({ db, liveState, runner, github }, payload)
    // The Fleet: agents that run this repo hear the push too (nodes/links.js).
    const forwarded = onPush ? onPush(pushSlice(payload)) : 0
    return c.json({ matched, queued, ...(forwarded ? { forwarded } : {}) }, 202)
  })

  return app
}
