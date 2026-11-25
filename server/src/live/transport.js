import { createHandlers } from 'lazy-storage/server/bun'
import { COOKIE_NAME, cookieFromHeader, sessionUser } from '../auth/sessions.js'

export const LIVE_PATH = '/live'
export const INSPECT_PATH = `${LIVE_PATH}/inspect`

// lazy-storage's inspector at /live/inspect: the live stores, their records
// and who has them open, for admins and nobody else — it shows every record
// of every store whatever `authorize` above says, deploy and build logs
// (which echo ENV values) and the fleet's mirrors included. Read only: the
// stores are the bridge's (live/stores.js) and keep no history, so there is
// nothing to revert, and a look never opens a store (`has`) — a fleet
// server's log is followed only for someone who opened it on its page.
// Its page is its own: one document under a CSP that loads nothing else,
// refusing what another site's page asks (lazy-storage/server inspector.js).
export function inspectorAuthorize(db) {
  return (request, { write }) => {
    if (write) return false
    const user = sessionUser(db, cookieFromHeader(request.headers.get('cookie'), COOKIE_NAME))?.user
    return user?.role === 'admin' ? { id: user.id } : false
  }
}

// The names beside the keys the stores keep: a user's id, or the master an
// agent's hub serves.
export function inspectorNameOf(db) {
  return key => {
    if (key === 'master') return 'the master'
    if (!/^[0-9]+$/.test(key)) return null
    return db.query('SELECT username FROM users WHERE id = ?').get(Number(key))?.username ?? null
  }
}

// The live stores over WebSocket at /live — the server's only socket: live
// state and deploy logs both ride it, each as a store.
//
// `authenticate` reads the same session cookie as the API — the browser
// sends it on the upgrade and on the snapshot route alike — and a socket
// without one is told so and closed (code 4401), which the client treats as
// final until the app signs in again.
export function createLiveTransport({ db, liveStores, onError }) {
  const live = createHandlers({
    stores: liveStores,
    path: LIVE_PATH,
    authenticate: req => {
      const user = sessionUser(db, cookieFromHeader(req.headers.get('cookie'), COOKIE_NAME))?.user
      // What rides on the sessions: enough to authorize stores, nothing more
      return user ? { id: user.id, username: user.username, role: user.role, handle: user.handle } : null
    },
    authorize: (user, id) => liveStores.canOpen(user, id),
    inspector: { authorize: inspectorAuthorize(db), nameOf: inspectorNameOf(db) },
    onError,
  })
  return {
    websocket: live.websocket,
    // A Response for the live route (or undefined once upgraded); null when
    // the request is somebody else's.
    upgrade: (req, server) => live.upgrade(req, server),
    close: options => live.close(options),
  }
}
