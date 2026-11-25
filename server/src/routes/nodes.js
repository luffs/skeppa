import { Hono } from 'hono'
import { normalizeGroupName, REPO_RE } from '../lib/validate.js'
import { newJoinCode, newAgentKey, parseJoinCode, sha256, matchesHash, promoteKey, JOIN_TTL_MS } from '../nodes/keys.js'
import { nodeInfo } from '../live/state.js'
import { nodeStoreId } from '../nodes/links.js'
import { recordEvent, listEvents, subjectOf } from '../nodes/events.js'

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
    // A new pairing looks at what the server deploys once more (links.js
    // seedRepos): a new machine in an old one's place brings its own.
    db.query("UPDATE nodes SET key_hash = ?, next_key_hash = '', join_hash = '', join_expires_at = '', repos_seeded = 0 WHERE id = ?").run(sha256(key), node.id)
    links.disconnect(node.id)
    links.refresh(node.id)
    recordEvent(db, { nodeId: node.id, nodeName: node.name, action: 'paired' })
    return c.json({ node: { id: node.id, name: node.name }, key })
  })

  return app
}

// Admin only (app.js): the nodes themselves.
export function nodeRoutes({ db, links }) {
  const app = new Hono()

  const rowOf = id => db.query('SELECT * FROM nodes WHERE id = ?').get(Number(id)) ?? null
  // A node's life, into the Fleet's log, as the signed-in admin's doing.
  const logNode = (c, row, action, subject = '') =>
    recordEvent(db, { nodeId: row.id, nodeName: row.name, username: c.get('user')?.username ?? '', action, subject })
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
    logNode(c, rowOf(id), 'created')
    return c.json({ node: nodeInfo(rowOf(id), false), ...join }, 201)
  })

  // The Fleet's log, newest first: ?node= one server, ?before= an id to page back.
  app.get('/events', c => {
    const node = c.req.query('node')
    const before = c.req.query('before')
    return c.json(listEvents(db, {
      nodeId: node && /^\d+$/.test(node) ? Number(node) : null,
      before: before && /^\d+$/.test(before) ? Number(before) : null,
      limit: Number(c.req.query('limit')) || 50,
    }))
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
    if (name !== row.name) logNode(c, { ...row, name }, 'renamed', `from ${row.name}`)
    return c.json(nodeInfo(rowOf(row.id), links.isOnline(row.id)))
  })

  // A fresh one-time code, to pair the server (again). The key it has keeps
  // working until the code is used.
  app.post('/:id/code', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    const join = issueCode(row.id)
    logNode(c, row, 'new join code')
    return c.json(join)
  })

  // A new key for a connected server, handed over its own socket: no join
  // code, nothing to run over there. The new key's hash waits beside the old
  // one while the agent writes it (agent/uplink.js rotateKey); its answer —
  // the key is on disk — retires the old key. An agent that cannot say (the
  // link drops, no answer in time) may or may not have it, so both keep
  // dialling in until it is heard with the new one (nodes/keys.js), and the
  // answer says the rotation is pending. An agent that says no changed
  // nothing.
  app.post('/:id/rotate', async c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    if (!row.key_hash) return c.json({ error: 'that server is not paired — pair it with a join code' }, 409)
    if (!links.isOnline(row.id)) return c.json({ error: 'that server is offline — it takes a new key over its own connection, so it has to be connected' }, 409)
    const key = newAgentKey(row.id)
    db.query('UPDATE nodes SET next_key_hash = ? WHERE id = ?').run(sha256(key), row.id)
    links.refresh(row.id)
    try {
      await links.call(row.id, 'rotateKey', { key })
    } catch (err) {
      if (err.code === 'offline' || err.code === 'timeout') {
        logNode(c, row, 'key rotation pending', err.message)
        return c.json({ pending: true, node: nodeInfo(rowOf(row.id), links.isOnline(row.id)) }, 202)
      }
      db.query("UPDATE nodes SET next_key_hash = '' WHERE id = ?").run(row.id)
      links.refresh(row.id)
      if (err.code === 'unknown-method') return c.json({ error: "that server's panel is too old to take a new key — update it first" }, 409)
      return nodeError(c, err)
    }
    promoteKey(db, row.id)
    links.refresh(row.id)
    logNode(c, row, 'key rotated')
    return c.json({ pending: false, node: nodeInfo(rowOf(row.id), links.isOnline(row.id)) })
  })

  // Take the key back now: the server is cut off until it is paired again.
  app.post('/:id/unpair', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    db.query("UPDATE nodes SET key_hash = '', next_key_hash = '' WHERE id = ?").run(row.id)
    links.disconnect(row.id, 'unpaired')
    links.refresh(row.id)
    logNode(c, row, 'unpaired')
    return c.json(nodeInfo(rowOf(row.id), false))
  })

  app.delete('/:id', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    db.query('DELETE FROM nodes WHERE id = ?').run(row.id)
    links.remove(row.id)
    logNode(c, row, 'removed') // its past stays in the log, under the name it had
    return c.json({ ok: true })
  })

  // The GitHub repositories that server may read through this panel's App
  // (links.js), and those it reports deploying that it may not: its Pairing.
  app.get('/:id/repos', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json(links.repos(row.id))
  })
  app.post('/:id/repos', async c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const repo = typeof body.repo === 'string' ? body.repo.trim() : ''
    if (!REPO_RE.test(repo)) return c.json({ error: 'validation failed', fields: { repo: 'owner/name' } }, 400)
    links.allowRepo(row.id, repo, 'allowed')
    logNode(c, row, 'allowed a repo', repo.toLowerCase())
    return c.json(links.repos(row.id))
  })
  app.delete('/:id/repos', c => {
    const row = rowOf(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    const repo = c.req.query('repo') ?? ''
    if (!REPO_RE.test(repo)) return c.json({ error: 'validation failed', fields: { repo: 'owner/name' } }, 400)
    if (links.disallowRepo(row.id, repo)) logNode(c, row, 'took a repo back', repo.toLowerCase())
    return c.json(links.repos(row.id))
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
    // A change goes into the Fleet's log (nodes/events.js), with what it was
    // about as the node reports it now — before a delete takes it away.
    const change = method !== 'GET'
    const bare = path.split('?')[0]
    const subject = change ? subjectOf(bare, links.get(nodeStoreId(row.id))?.state) : ''
    const log = (status, error = '') => change && recordEvent(db, {
      nodeId: row.id, nodeName: row.name, username: c.get('user')?.username ?? '', action: `${method} ${bare}`, subject, status, error,
    })
    let answer
    try {
      // A clone or a slug rename waits on git and the engine over there.
      answer = await links.call(row.id, 'request', { method, path, body }, { timeoutMs: 180_000 })
    } catch (err) {
      log(0, err.message)
      if (err.code === 'forbidden') return c.json({ error: `not through the fleet yet — use that server's own panel (${err.message})` }, 403)
      return nodeError(c, err)
    }
    const status = Number.isInteger(answer?.status) && answer.status >= 200 && answer.status <= 599 ? answer.status : 502
    log(status, status >= 400 ? String(answer?.json?.error ?? '') : '')
    // A project moored there, or pointed at a repo, by an admin here: that
    // server may read the repo from now on (links.js allowRepo).
    if (status < 300 && (method === 'POST' || method === 'PATCH') && /^\/api\/projects(\/\d+)?$/.test(bare)
      && typeof body?.repo_full_name === 'string' && REPO_RE.test(body.repo_full_name)) {
      links.allowRepo(row.id, body.repo_full_name, 'moored')
    }
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
