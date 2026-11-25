// The Fleet's log (server nodes/events.js) in words: what an entry's
// `action` — a node's life, or a relayed `METHOD /api/path` — amounts to.

const LIFE = {
  created: 'added to the fleet',
  paired: 'paired',
  renamed: 'renamed',
  'new join code': 'made a new join code',
  unpaired: 'unpaired',
  'key rotated': 'gave it a new key',
  'key rotation pending': 'sent it a new key (not confirmed)',
  removed: 'removed from the fleet',
  offline: 'went offline',
  back: 'reporting again',
}

// [method, path pattern, words] — the first that matches says it. A path's
// last segment can be read into the words with $1.
const CHANGES = [
  ['POST', /^\/api\/projects$/, 'moored a project'],
  ['POST', /^\/api\/projects\/\d+\/deploy$/, 'deployed'],
  ['POST', /^\/api\/projects\/\d+\/pm2\/(start|stop|restart)$/, '$1'],
  ['POST', /^\/api\/projects\/\d+\/clone$/, 'cloned'],
  ['POST', /^\/api\/projects\/\d+\/slug$/, 'changed the slug'],
  ['POST', /^\/api\/projects\/\d+\/refresh-head$/, 'checked the remote'],
  ['PATCH', /^\/api\/projects\/\d+$/, 'changed Rigging'],
  ['PUT', /^\/api\/projects\/\d+\/env$/, 'saved the Manifest'],
  ['DELETE', /^\/api\/projects\/\d+$/, 'scuttled'],
  ['POST', /^\/api\/groups$/, 'made a pier'],
  ['POST', /^\/api\/groups\/\d+\/deploy$/, 'deployed the pier'],
  ['PATCH', /^\/api\/groups\/\d+$/, 'renamed the pier'],
  ['DELETE', /^\/api\/groups\/\d+$/, 'removed the pier'],
  ['POST', /^\/api\/images$/, 'made an image'],
  ['PATCH', /^\/api\/images\/\d+$/, 'changed the Containerfile'],
  ['POST', /^\/api\/images\/\d+\/build$/, 'built'],
  ['DELETE', /^\/api\/images\/\d+$/, 'removed the image'],
  ['POST', /^\/api\/images\/pull$/, 'pulled an image'],
  ['POST', /^\/api\/images\/remove$/, 'removed an image from the store'],
  ['POST', /^\/api\/images\/prune$/, 'pruned the image store'],
  ['POST', /^\/api\/system\/(?:pm2|containers)\/[^/]+\/(start|stop|restart|remove)$/, '$1'],
  ['PUT', /^\/api\/proxy$/, 'changed the harbor gate'],
  ['POST', /^\/api\/proxy\/apply$/, 'reloaded the harbor gate'],
  ['PUT', /^\/api\/settings$/, 'changed the settings'],
  ['POST', /^\/api\/settings\/notify\/test$/, 'sent a test notification'],
]

// What the entry says happened, in words.
export function describeAction(action) {
  if (Object.hasOwn(LIFE, action)) return LIFE[action]
  const m = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(action ?? '')
  if (!m) return action ?? ''
  const [, method, path] = m
  for (const [verb, pattern, words] of CHANGES) {
    const hit = verb === method && pattern.exec(path)
    if (hit) return words.replace('$1', hit[1] ?? '')
  }
  return action
}

// The process a system action named, for its subject: …/pm2/<name>/restart.
export function processOf(action) {
  return /\/api\/system\/(?:pm2|containers)\/([^/]+)\//.exec(action ?? '')?.[1] ?? ''
}

// How it went: ok, failed (with why), or a node's life (nothing to say).
export function outcomeOf(event) {
  if (!/^(POST|PUT|PATCH|DELETE) /.test(event.action ?? '')) return { tone: '', text: '' }
  if (event.error || event.status >= 400 || event.status === 0) {
    return { tone: 'red', text: event.status ? String(event.status) : 'failed', why: event.error || '' }
  }
  return { tone: 'green', text: '✓', why: '' }
}
