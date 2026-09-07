// Follow the panel's live stores from a terminal, the way the frontend will:
// sign in, open stores over one socket at /live, print each snapshot and
// then every patch as it arrives.
//
//   bun scripts/live-mirror.js http://127.0.0.1:3000 <username> <password> [store ...]
//
// Without store ids: harbor and your own fleet — and, for an admin, panel
// and every user's fleet. A running deployment's log is `deploy-<id>`.
// `--once` exits after the snapshots have landed.
import { createClient, createConnection, webSocketTransport } from 'lazy-storage'

const args = process.argv.slice(2)
const once = args.includes('--once')
const [base, username, password, ...stores] = args.filter(a => a !== '--once')
if (!base || !username || !password) {
  console.error('usage: bun scripts/live-mirror.js <panel url> <username> <password> [store ...] [--once]')
  process.exit(2)
}

const login = await fetch(new URL('/api/auth/login', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
if (!login.ok) {
  console.error(`login failed: ${login.status} ${await login.text()}`)
  process.exit(1)
}
const me = await login.json()
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

let wanted = stores
if (!wanted.length) {
  wanted = ['harbor', `fleet-${me.id}`]
  if (me.role === 'admin') {
    const users = await (await fetch(new URL('/api/users', base), { headers: { cookie } })).json()
    wanted.push('panel', ...users.filter(u => u.id !== me.id).map(u => `fleet-${u.id}`))
  }
}

// Bun's WebSocket takes headers; the browser sends the cookie on its own.
class CookieSocket extends WebSocket {
  constructor(url) {
    super(url, { headers: { cookie } })
  }
}
const wsUrl = new URL('/live', base)
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const connection = createConnection({
  transport: webSocketTransport(wsUrl.href, { WebSocket: CookieSocket, fetch: false }),
})
connection.on('status', status => console.log(`# socket ${status}`))
connection.on('closed', closed => closed && console.log(`# socket closed: ${closed.code} ${closed.message}`))

// Each kind of store declares its arrays of records (server/src/live/stores.js)
const registersFor = id => {
  if (id === 'panel') return ['images/managed', 'images/local']
  if (id.startsWith('fleet-')) return ['projects/*/recentDeployments']
  return [] // harbor, deploy-<id>
}

let pendingSnapshots = wanted.length
for (const id of wanted) {
  const db = createClient({ connection, store: id, initial: {}, registers: registersFor(id), undo: false, presence: false })
  db.on('closed', closed => {
    console.log(`# ${id}: closed — ${closed.code}: ${closed.message}`)
    if (once && --pendingSnapshots === 0) process.exit(0)
  })
  db.on('error', err => console.log(`# ${id}: error ${err.code ?? ''} ${err.message}`))
  db.watch((diff, _inverse, meta) => {
    if (meta?.snapshot) {
      console.log(`# ${id}: snapshot v${db.version}`)
      console.log(JSON.stringify(db.state, null, 2))
      if (once && --pendingSnapshots === 0) process.exit(0)
    } else {
      console.log(`# ${id}: patch v${db.version}`)
      console.log(JSON.stringify(diff))
    }
  })
  db.connect()
}
