import { Hono } from 'hono'
import { getSecretSetting } from '../db/settings.js'
import { verifySignature } from '../github/webhook.js'

// No session on this route — authentication is the HMAC signature.
// Respond quickly; the actual deploy work happens asynchronously.
export function webhookRoutes({ db, config, runner, liveState }) {
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
    if (event !== 'push') return c.json({ ignored: event })

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'invalid JSON payload' }, 400)
    }
    if (payload.deleted) return c.json({ ignored: 'branch deleted' })

    const repo = payload.repository?.full_name
    const ref = payload.ref
    const matches = db.query('SELECT id, branch, auto_deploy FROM projects WHERE repo_full_name = ?').all(repo ?? '')
      .filter(p => ref === `refs/heads/${p.branch}`)

    const commitSha = payload.after ?? null
    const commitMessage = payload.head_commit?.message?.split('\n')[0] ?? null
    const pushedAt = payload.head_commit?.timestamp ?? new Date().toISOString()

    // Every push updates the recorded head commit, so the UI can show
    // pushed-but-undeployed commits; a deploy only runs with auto_deploy on.
    if (commitSha) {
      for (const p of matches) {
        db.query('UPDATE projects SET head_sha = ?, head_message = ?, head_pushed_at = ? WHERE id = ?')
          .run(commitSha, commitMessage, pushedAt, p.id)
        const live = liveState?.projects[p.id]
        if (live) live.headCommit = { sha: commitSha, message: commitMessage, pushedAt }
      }
    }

    const toDeploy = matches.filter(p => p.auto_deploy)
    queueMicrotask(() => {
      for (const p of toDeploy) {
        try {
          runner.enqueue(p.id, { trigger: 'webhook', commitSha, commitMessage })
        } catch (err) {
          console.error('webhook enqueue failed:', err)
        }
      }
    })
    return c.json({ matched: matches.length, queued: toDeploy.length }, 202)
  })

  return app
}
