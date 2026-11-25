import { api } from '../api.js'
import { store } from '../store.js'

// Which server a project page is about: this panel, or another Skeppa
// reporting here (the Fleet). The project page provides one as `ship`, and
// everything under it injects it (default: this panel), so the same page and
// the same components work for both:
//
//   ship.api    the API — for a node, /api/… becomes /api/nodes/<id>/api/…,
//               which the master relays to that server's own routes
//   ship.url    the same rewrite for a link (a download)
//   ship.live   the live state the page reads: projects, groups, proxy,
//               system, images — for a node, what that server reports
//   ship.node   0 here, the node id otherwise
//   ship.online whether it reports right now (always here); ShipOffline.vue
//               says so on its pages, and its api refuses at once while not
//   ship.home   where "back" leads: the harbor, or the Fleet page
//   ship.link   a project's page on this ship
//   ship.page   one of its admin pages: 'system', 'shipyard', 'settings'

export const localShip = Object.freeze({
  node: 0,
  name: '',
  online: true,
  lastSeenAt: '',
  api,
  url: path => path,
  get live() {
    return store.live
  },
  home: '/',
  link: id => `/projects/${id}`,
  page: name => `/${name}`,
})

const EMPTY = Object.freeze({})

export function nodeShip(node) {
  node = Number(node)
  const url = path => (typeof path === 'string' && path.startsWith('/api/') ? `/api/nodes/${node}${path}` : path)
  const known = () => store.live.nodes?.[node] ?? null
  const name = () => known()?.name ?? `server ${node}`
  // A server known to be offline is not asked at all: the answer would be
  // the relay's 503 a round trip later. Unknown (the panel store not in yet)
  // goes through, and the relay says.
  const guarded = call => async (...args) => {
    const n = known()
    if (n && !n.online) throw Object.assign(new Error(`${name()} is offline — this waits until it reports again`), { status: 503 })
    return call(...args)
  }
  return Object.freeze({
    node,
    get name() {
      return name()
    },
    // Unknown counts as online, so a page does not flash "offline" while the
    // panel store comes in.
    get online() {
      return known()?.online ?? true
    },
    get lastSeenAt() {
      return known()?.lastSeenAt ?? ''
    },
    api: {
      get: guarded(path => api.get(url(path))),
      post: guarded((path, body) => api.post(url(path), body)),
      put: guarded((path, body) => api.put(url(path), body)),
      patch: guarded((path, body) => api.patch(url(path), body)),
      del: guarded(path => api.del(url(path))),
    },
    url,
    get live() {
      const state = store.live.nodeStates?.[node]
      return {
        projects: state?.projects ?? EMPTY,
        groups: state?.groups ?? EMPTY,
        proxy: state?.proxy ?? EMPTY,
        system: state?.system ?? EMPTY,
        images: state?.images ?? null,
        users: EMPTY,
      }
    },
    home: '/fleet',
    link: id => `/fleet/${node}/projects/${id}`,
    page: name => `/fleet/${node}/${name}`,
  })
}

// For components: `inject: shipInject`, then this.ship.
export const shipInject = { ship: { default: () => localShip } }

// For a route view that can be about another server (/fleet/:node/…): the
// `node` prop, `this.ship`, and the ship provided to everything under it.
// The router keys such views by server, so the ship is fixed for a view's life.
export const shipProvider = {
  props: { node: { type: [String, Number], default: 0 } },
  computed: {
    ship() {
      return Number(this.node) ? nodeShip(this.node) : localShip
    },
  },
  provide() {
    return { ship: this.ship }
  },
}
