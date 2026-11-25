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
  live: { projects: {}, groups: {}, system: {}, users: {}, proxy: {}, images: {} },
  // The wall clock, ticked once a second so relative labels (timeAgo,
  // uptimeSince) are reactive: computeds re-evaluate each tick but the DOM
  // only patches when the rendered string actually changes, so "14s ago"
  // moves every second while "2m ago" costs nothing for a minute. Data
  // diffs cannot do this job — quantization suppresses them on purpose
  // when nothing meaningful changed. It is the server's clock, as near as
  // this browser can tell (serverNow): every time it is compared with is
  // the server's — a deploy's startedAt, a commit's pushedAt — so a
  // browser whose clock is off must not put a voyage a minute over.
  now: Date.now(),
  // How far the server's clock is ahead of this browser's, in ms; 0 until
  // an answer has said otherwise (noteServerDate).
  clockSkew: 0,
})

// The server's time now, by this browser's clock and the skew measured.
export function serverNow() {
  return Date.now() + store.clockSkew
}

// Recomputed from Date.now() each tick, so browser throttling of hidden
// tabs self-corrects the moment the tab is visible again.
setInterval(() => { store.now = serverNow() }, 1000)

// Measures the skew from an answer's Date header (api.js, every request):
// the header is the server's whole second, cut down, so its middle is set
// against the middle of the round trip. Under a second and a half of skew is
// within what the header can tell, and is left at 0; a slow answer (over 2 s
// there and back) is not used; and the skew only moves when it is off by a
// second or more, so the labels do not twitch with every request.
export function noteServerDate(header, sentAt, receivedAt = Date.now()) {
  const server = Date.parse(header ?? '')
  if (!Number.isFinite(server) || receivedAt - sentAt > 2000) return
  const skew = server + 500 - (sentAt + receivedAt) / 2
  const next = Math.abs(skew) < 1500 ? 0 : Math.round(skew)
  if (Math.abs(next - store.clockSkew) < 1000) return
  store.clockSkew = next
  store.now = serverNow()
}

// The app's public address, or '' when the project is not routed. The base
// domain rides along in LiveState, so links appear (and follow edits) without
// any request of their own.
// `domain` is this panel's base domain unless given — a project on another
// server reporting here (the Fleet page) routes under that server's.
export function appUrlFor(project, domain = store.live.proxy?.baseDomain) {
  if (!project?.subdomain || !domain) return ''
  // A tenant with a domain of their own routes there ('@' is the apex);
  // other tenant projects are routed under their owner's handle.
  if (project.owner_role === 'tenant' && project.owner_domain) {
    return `https://${project.subdomain === '@' ? '' : `${project.subdomain}.`}${project.owner_domain}`
  }
  const nested = project.owner_role === 'tenant' && project.owner_handle
  return `https://${project.subdomain}.${nested ? `${project.owner_handle}.` : ''}${domain}`
}

export function liveProject(projectId) {
  return store.live.projects?.[projectId] ?? null
}
