import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// The secrets between this panel and its agents. Both carry the node id in
// the clear so a lookup needs no scan, and a random part this panel only
// keeps the SHA-256 of — high-entropy secrets need no slow hash, and a
// stolen database pairs nothing.
//
//   join code   skj_<node id>_<32 hex>   one-time, 10 minutes, pairs an agent
//   agent key   skn_<node id>_<64 hex>   what the agent dials with, until re-paired
//                                        or rotated (routes/nodes.js /:id/rotate)

export const JOIN_TTL_MS = 10 * 60 * 1000

const JOIN_RE = /^skj_(\d{1,9})_([0-9a-f]{32})$/
const KEY_RE = /^skn_(\d{1,9})_([0-9a-f]{64})$/

export const sha256 = text => createHash('sha256').update(text).digest('hex')

export function newJoinCode(nodeId) {
  return `skj_${nodeId}_${randomBytes(16).toString('hex')}`
}

export function newAgentKey(nodeId) {
  return `skn_${nodeId}_${randomBytes(32).toString('hex')}`
}

// { nodeId, secret } or null for anything that is not one.
export const parseJoinCode = code => parse(JOIN_RE, code)
export const parseAgentKey = key => parse(KEY_RE, key)

function parse(re, value) {
  const m = typeof value === 'string' ? re.exec(value.trim()) : null
  return m ? { nodeId: Number(m[1]), value: value.trim() } : null
}

// Whether `value` hashes to `hash` (hex), in constant time. An empty hash
// stands for "none" and matches nothing.
export function matchesHash(value, hash) {
  if (typeof hash !== 'string' || hash.length !== 64) return false
  const a = Buffer.from(sha256(value), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

// Who an `Authorization: Bearer skn_…` header is: the node row, or null.
// While a rotation is out, the new key dials in too — and the first time it
// does, it is the key from then on and the old one stops working.
export function nodeForKey(db, authorization) {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
  const parsed = m ? parseAgentKey(m[1]) : null
  if (!parsed) return null
  const node = db.query('SELECT * FROM nodes WHERE id = ?').get(parsed.nodeId)
  if (!node) return null
  if (matchesHash(parsed.value, node.key_hash)) return node
  if (matchesHash(parsed.value, node.next_key_hash)) return promoteKey(db, node.id)
  return null
}

// The rotated-to key becomes the key: the agent has it.
export function promoteKey(db, id) {
  db.query("UPDATE nodes SET key_hash = next_key_hash, next_key_hash = '' WHERE id = ? AND next_key_hash != ''").run(id)
  return db.query('SELECT * FROM nodes WHERE id = ?').get(id)
}
