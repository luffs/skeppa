import { createHandlers } from 'lazy-storage/server/bun'
import { COOKIE_NAME, cookieFromHeader, sessionUser } from '../auth/sessions.js'

export const LIVE_PATH = '/live'

// The live stores over WebSocket at /live, next to Hono's own /ws (deploy
// logs). Bun takes one websocket handler per server, so the two share it:
// Hono tags its sockets with the route's events, lazy-storage with the user
// it authenticated at upgrade.
//
// `authenticate` reads the same session cookie as the API — the browser
// sends it on the upgrade and on the snapshot route alike — and a socket
// without one is told so and closed (code 4401), which the client treats as
// final until the app signs in again.
export function createLiveTransport({ db, liveStores, honoWebsocket, onError }) {
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
  const isHono = ws => Boolean(ws.data?.events)
  const websocket = {
    ...live.websocket, // maxPayloadLength, perMessageDeflate
    open: ws => (isHono(ws) ? honoWebsocket.open(ws) : live.websocket.open(ws)),
    message: (ws, message) => (isHono(ws) ? honoWebsocket.message(ws, message) : live.websocket.message(ws, message)),
    close: (ws, code, reason) => (isHono(ws) ? honoWebsocket.close(ws, code, reason) : live.websocket.close(ws, code, reason)),
  }
  return {
    websocket,
    // A Response for the live route (or undefined once upgraded); null when
    // the request is somebody else's.
    upgrade: (req, server) => live.upgrade(req, server),
    close: options => live.close(options),
  }
}
