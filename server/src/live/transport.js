import { createHandlers } from 'lazy-storage/server/bun'
import { COOKIE_NAME, cookieFromHeader, sessionUser } from '../auth/sessions.js'

export const LIVE_PATH = '/live'

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
