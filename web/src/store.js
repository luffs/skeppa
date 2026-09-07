import { reactive } from 'vue'

// `live` mirrors the server's LiveState. live.js composes it from the
// lazy-storage store mirrors once a user is signed in (projects merged across
// the fleets this user may see, the rest from the panel and harbor stores);
// the default here is the empty shape the views expect before that, and what
// tests seed directly.
export const store = reactive({
  user: null,
  connected: false, // the /live socket is open
  ready: false, // true once every opened store has delivered its snapshot
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
  if (!project?.subdomain || !domain) return ''
  // Tenant projects are routed under their owner's handle.
  const nested = project.owner_role === 'tenant' && project.owner_handle
  return `https://${project.subdomain}.${nested ? `${project.owner_handle}.` : ''}${domain}`
}

export function liveProject(projectId) {
  return store.live.projects?.[projectId] ?? null
}
