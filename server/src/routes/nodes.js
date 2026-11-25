import { Hono } from 'hono'
import { normalizeGroupName } from '../lib/validate.js'
import { newJoinCode, newAgentKey, parseJoinCode, sha256, matchesHash, JOIN_TTL_MS } from '../nodes/keys.js'
import { nodeInfo } from '../live/state.js'

// Same rule as a pier's name: one line, 40 characters, no control characters.
const normalizeNodeName = normalizeGroupName

// No session: the one-time code is the credential. It is spent on use, and
// whatever key the node had before stops working (links.disconnect).
export function nodeJoinRoutes({ db, links }) {
  const app = new Hono()

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = parseJoinCode(body.code)
    const node = parsed ? db.query('SELECT * FROM nodes WHERE id = ?').get(parsed.nodeId) : null
    const valid = node && matchesHash(parsed.value, node.join_hash) && Date.parse(node.join_expires_at) > Date.now()
    if (!valid) return c.json({ error: 'that code is not valid, or it has expired — make a new one on the Fleet page' }, 401)
    const key = newAgentKey(node.id)
    db.query("UPDATE nodes SET key_hash = ?, join_hash = '', join_expires_at = '' WHERE id = ?").run(sha256(key), node.id)
    links.disconnect(node.id)
    links.refresh(node.id)
    return c.json({ node: { id: node.id, name: node.name }, key })
  })

  return app
}

// Admin only (app.js): the nodes themselves.
export function nodeRoutes({ db, links }) {
  const app = new Hono()

  const rowOf = id => db.query('SELECT * FROM nodes WHERE id = ?').get(Number(id)) ?? null
  const nameTaken = (name, exceptId = -1) =>
    Boolean(db.query('SELECT 1 FROM nodes WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId))

  function issueCode(id) {
    const code = newJoinCode(id)
    const expiresAt = new Date(Date.now() + JOIN_TTL_MS).toISOString()
    db.query('UPDATE nodes SET join_hash = ?, join_expires_at = ? WHERE id = ?').run(sha256(code), expiresAt, id)
    links.refresh(id)
    return { code, expiresAt }
  }

  app.get('/', c => {
    const rows = db.query('SELECT * FROM nodes ORDER BY name').all()
    return c.json(rows.map(row => nodeInfo(row, links.isOnline(row.id))))
  })

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const name = normalizeNodeName(body.name)
    if (!name) return c.json({ error: 'validation failed', fields: { name: 'one line, at most 40 characters' } }, 400)
    if (nameTaken(name)) return c.json({ error: 'validation failed', fields: { name: 'another server has that name' } }, 400)
    const id = Number(db.query('INSERT INTO nodes (name) VALUES (?)').run(name).lastInsertRowid)
    const join = issueCode(id)
    return c.json({ node: nodeInfo(rowOf(id), false), ...join }, 201)
  })

  app.patch('/:id', async c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const name = normalizeNodeName(body.name)
    if (!name) return c.json({ error: 'validation failed', fields: { name: 'one line, at most 40 characters' } }, 400)
    if (nameTaken(name, row.id)) return c.json({ error: 'validation failed', fields: { name: 'another server has that name' } }, 400)
    db.query('UPDATE nodes SET name = ? WHERE id = ?').run(name, row.id)
    links.refresh(row.id)
    return c.json(nodeInfo(rowOf(row.id), links.isOnline(row.id)))
  })

  // A fresh one-time code, to pair the server (again). The key it has keeps
  // working until the code is used.
  app.post('/:id/code', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json(issueCode(row.id))
  })

  // Take the key back now: the server is cut off until it is paired again.
  app.post('/:id/unpair', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    db.query("UPDATE nodes SET key_hash = '' WHERE id = ?").run(row.id)
    links.disconnect(row.id, 'unpaired')
    links.refresh(row.id)
    return c.json(nodeInfo(rowOf(row.id), false))
  })

  app.delete('/:id', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    db.query('DELETE FROM nodes WHERE id = ?').run(row.id)
    links.remove(row.id)
    return c.json({ ok: true })
  })

  // A deployment on that server, with its log — asked of the agent itself.
  app.get('/:id/deployments/:deploymentId', async c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    const deploymentId = Number(c.req.param('deploymentId'))
    if (!Number.isInteger(deploymentId) || deploymentId < 1) return c.json({ error: 'not found' }, 404)
    try {
      const deployment = await links.call(row.id, 'deployment', { id: deploymentId })
      return deployment ? c.json(deployment) : c.json({ error: 'not found' }, 404)
    } catch (err) {
      return nodeError(c, err)
    }
  })

  // The agent's own API, relayed: /api/nodes/:id/api/projects/3/deploy is
  // POST /api/projects/3/deploy on that server, run there through its own
  // routes as its admin. The agent decides what it lets through
  // (agent/uplink.js FLEET_PATHS); this only carries the call and its answer.
  app.all('/:id/api/*', async c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    const url = new URL(c.req.url)
    const marker = `/nodes/${row.id}/api/`
    const at = url.pathname.indexOf(marker)
    if (at < 0) return c.json({ error: 'not found' }, 404)
    const path = `/api/${url.pathname.slice(at + marker.length)}${url.search}`
    const method = c.req.method
    const body = method === 'GET' || method === 'DELETE' ? undefined : await c.req.json().catch(() => undefined)
    // Asking about a repo on that server (a branch list, suggestions, a
    // project moved to it) lets its GitHub token follow (nodes/answers.js).
    if (/^\/api\/github\/repos\/(branches|suggest)$/.test(`/api/${url.pathname.slice(at + marker.length)}`)) {
      links.grantRepo(row.id, url.searchParams.get('repo'))
    }
    if (typeof body?.repo_full_name === 'string') links.grantRepo(row.id, body.repo_full_name)
    let answer
    try {
      // A clone or a slug rename waits on git and the engine over there.
      answer = await links.call(row.id, 'request', { method, path, body }, { timeoutMs: 180_000 })
    } catch (err) {
      if (err.code === 'forbidden') return c.json({ error: `not through the fleet yet — use that server's own panel (${err.message})` }, 403)
      return nodeError(c, err)
    }
    const status = Number.isInteger(answer?.status) && answer.status >= 200 && answer.status <= 599 ? answer.status : 502
    if (typeof answer?.base64 === 'string') {
      // A download from that server's file viewer: the same headers this
      // panel's own sets, whatever the agent said — only the file name comes
      // from there, and only in the shape our routes write it.
      const disposition = /^attachment; filename="[\w.-]*"(; filename\*=UTF-8''[\w%.~-]*)?$/.test(answer.disposition ?? '') ? answer.disposition : 'attachment'
      return new Response(Buffer.from(answer.base64, 'base64'), {
        status,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': disposition,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          'Cache-Control': 'no-store',
        },
      })
    }
    return c.json(answer?.json ?? null, status)
  })

  return app
}

function nodeError(c, err) {
  if (err.code === 'offline') return c.json({ error: 'that server is offline' }, 503)
  if (err.code === 'timeout') return c.json({ error: `that server did not answer: ${err.message}` }, 504)
  return c.json({ error: `that server said: ${err.message}` }, 502)
}
