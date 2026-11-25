// The Fleet's log (fleet_events, 022): who did what to which server, from
// this panel, and when — for when several servers are run from one place and
// "who restarted that, and was it from here?" needs an answer. The agent's own
// stdout says `master: METHOD path` too; this is the side that knows who.
//
// `action` is either a node's life — created, paired, renamed, new code,
// unpaired, removed, offline, back — or a relayed change, `METHOD /api/path`.

export const KEEP_EVENTS = 5000

// A relayed path's subject, read off what the node reports right now: the
// project, pier or image it names, by name. '' when there is none to say.
export function subjectOf(path, nodeState) {
  const m = /^\/api\/(projects|groups|images)\/(\d+)/.exec(path ?? '')
  if (!m) return ''
  const [, kind, id] = m
  if (kind === 'projects') return nodeState?.projects?.[id]?.info?.name ?? `project ${id}`
  if (kind === 'groups') return nodeState?.groups?.[id]?.name ?? `pier ${id}`
  return nodeState?.images?.managed?.find(i => String(i.id) === id)?.name ?? `image ${id}`
}

export function recordEvent(db, { nodeId, nodeName = '', username = '', action, subject = '', status = 0, error = '' }) {
  db.query(`INSERT INTO fleet_events (node_id, node_name, username, action, subject, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(nodeId), String(nodeName).slice(0, 80), String(username).slice(0, 80), String(action).slice(0, 300),
      String(subject).slice(0, 120), Number.isInteger(status) ? status : 0, String(error ?? '').slice(0, 300))
  // Now and then, not every time: the newest KEEP_EVENTS stay.
  if (Math.random() < 0.05) prune(db)
}

export function prune(db, keep = KEEP_EVENTS) {
  db.query('DELETE FROM fleet_events WHERE id <= (SELECT id FROM fleet_events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(keep)
}

// Newest first; `nodeId` narrows to one server, `before` (an id) pages back.
export function listEvents(db, { nodeId = null, before = null, limit = 50 } = {}) {
  const where = []
  const args = []
  if (nodeId != null) {
    where.push('node_id = ?')
    args.push(Number(nodeId))
  }
  if (before != null) {
    where.push('id < ?')
    args.push(Number(before))
  }
  const n = Math.max(1, Math.min(200, Number(limit) || 50))
  return db.query(
    `SELECT id, node_id, node_name, username, action, subject, status, error, created_at FROM fleet_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
  ).all(...args, n)
}
