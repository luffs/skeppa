import { reactive } from 'vue'
import { LazyWatch } from 'lazy-watch'

// `live` mirrors the server's LiveState. It is replaced wholesale on every
// full snapshot and patched with lazy-watch diffs in between. Because it sits
// inside a Vue reactive object, patched changes render automatically.
export const store = reactive({
  user: null,
  connected: false,
  ready: false, // true once the first full snapshot has arrived
  liveUpdatedAt: null, // ms timestamp of the last snapshot/diff received
  live: { projects: {}, system: {}, users: {}, proxy: {}, images: {} },
  // The wall clock, ticked once a second so relative labels (timeAgo,
  // uptimeSince) are reactive: computeds re-evaluate each tick but the DOM
  // only patches when the rendered string actually changes, so "14s ago"
  // moves every second while "2m ago" costs nothing for a minute. Data
  // diffs cannot do this job — quantization suppresses them on purpose
  // when nothing meaningful changed.
  now: Date.now(),
})

// Recomputed from Date.now() each tick, so browser throttling of hidden
// tabs self-corrects the moment the tab is visible again.
setInterval(() => { store.now = Date.now() }, 1000)

// The app's public address, or '' when the project is not routed. The base
// domain rides along in LiveState, so links appear (and follow edits) without
// any request of their own.
export function appUrlFor(project) {
  const domain = store.live.proxy?.baseDomain
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
