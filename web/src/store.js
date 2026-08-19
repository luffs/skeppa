import { reactive } from 'vue'
import { LazyWatch } from 'lazy-watch'
import { api } from './api.js'

// `live` mirrors the server's LiveState. It is replaced wholesale on every
// full snapshot and patched with lazy-watch diffs in between. Because it sits
// inside a Vue reactive object, patched changes render automatically.
export const store = reactive({
  user: null,
  connected: false,
  ready: false, // true once the first full snapshot has arrived
  liveUpdatedAt: null, // ms timestamp of the last snapshot/diff received
  live: { projects: {}, system: {}, users: {} },
  // Harbor gate status. Not part of LiveState (it changes only when someone
  // edits it), but several views need the base domain to build app links, so
  // it is fetched once and shared.
  gate: null,
})

let gatePromise = null

export function loadGate() {
  if (!gatePromise) {
    gatePromise = api.get('/api/proxy')
      .then(gate => (store.gate = gate))
      .catch(() => null) // routing is optional — views just skip app links
  }
  return gatePromise
}

// Called by the settings view after it saves, so the shared copy (and the
// links built from it) do not go stale until the next reload.
export function setGate(gate) {
  store.gate = gate
  gatePromise = Promise.resolve(gate)
}

// The app's public address, or '' when the project is not routed.
export function appUrlFor(project) {
  const domain = store.gate?.base_domain
  return project?.subdomain && domain ? `https://${project.subdomain}.${domain}` : ''
}

export function applyFullState(state) {
  store.live = state
  store.ready = true
  store.liveUpdatedAt = Date.now()
}

export function applyStateDiff(diff) {
  LazyWatch.patch(store.live, diff)
  store.liveUpdatedAt = Date.now()
}

export function liveProject(projectId) {
  return store.live.projects?.[projectId] ?? null
}
