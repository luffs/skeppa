import { store } from '../store.js'

// The Shipyard's data as the forms need it. LiveState deliberately keeps the
// definitions (from the DB, always there) apart from the engine's store (best
// effort, and a diff cannot carry a null inside an array) — so the join lives
// here, once, for everyone who has to answer "does this image exist?".

export function liveImages() {
  return store.ready ? (store.live.images ?? null) : null
}

// `exists` stays null until a listing actually succeeded: an unreachable
// engine says nothing rather than "not built" about every image.
export function managedWithStore(images) {
  const local = images?.local ?? []
  const listed = images?.storeListed
  return (images?.managed ?? []).map(img => {
    const hit = local.find(l => l.tags.includes(img.ref))
    return { ...img, exists: listed ? !!hit : null, size: hit?.size ?? null }
  })
}

// Registry images in the local store, one entry per tag — a single image can
// carry several. Managed ones are left out: they belong to the Shipyard list,
// where they are named by definition rather than by what the store happens to
// hold.
export function registryImages(images) {
  const byRef = new Map()
  for (const img of images?.local ?? []) {
    if (img.managed) continue
    for (const ref of img.tags) if (!byRef.has(ref)) byRef.set(ref, { ref, size: img.size })
  }
  return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref))
}

// A starting point for a server whose store is still empty. Fully qualified on
// purpose: rootless podman resolves an unqualified name against its own
// registry configuration, which may not have one. Floating major tags rather
// than pins — and a suggestion that has gone stale is a visible "not in store"
// plus a failed pull, never a silently wrong image.
export const COMMON_IMAGES = [
  'docker.io/oven/bun:1',
  'docker.io/library/node:22',
  'docker.io/library/python:3.13-slim',
  'docker.io/library/golang:1.23',
  'docker.io/library/debian:bookworm-slim',
]

// FROM <ref> [AS <stage>] — lowercase spelling and --flags allowed.
const FROM_RE = /^[ \t]*FROM[ \t]+(?:--\S+[ \t]+)*(\S+)(?:[ \t]+AS[ \t]+(\S+))?/gim

// The bases the Shipyard's own Containerfiles build on. Unlike a curated list
// these never go stale, and they are the user's own choices. A multi-stage
// build's internal stage names and `scratch` are not images, so they stay out,
// and neither is anything built out of a variable.
export function fromBases(images) {
  const refs = []
  const stages = new Set()
  for (const img of images?.managed ?? []) {
    for (const [, ref, alias] of (img.containerfile ?? '').matchAll(FROM_RE)) {
      if (alias) stages.add(alias.toLowerCase())
      const isStage = stages.has(ref.toLowerCase())
      if (ref !== 'scratch' && !ref.includes('$') && !isStage) refs.push(ref)
    }
  }
  return refs
}

// What to offer when the lists of what actually exists have little to give.
// Anything already on offer is dropped, so this only ever names images that are
// not there yet.
export function suggestedImages(images, offered = []) {
  const taken = new Set(offered.filter(Boolean))
  return [...new Set([...fromBases(images), ...COMMON_IMAGES])].filter(ref => !taken.has(ref))
}

// Engines disagree on whether an image id wears the `sha256:` prefix, so
// compare the digest itself.
const bareId = id => String(id ?? '').replace(/^sha256:/, '')

// Where a running container stands against the tag it was started from:
// 'stale' when something pulled or rebuilt that tag underneath it (a restart
// moves the app onto the newer image), 'current' when the two ids agree, and
// 'unknown' whenever either id is missing — an engine that listed neither
// says nothing, and silence must never be rendered as "up to date".
export function containerImageState(images, container) {
  const running = bareId(container?.imageId)
  if (!running) return 'unknown'
  const inStore = (images?.local ?? []).find(img => img.tags.includes(container?.image))
  const current = bareId(inStore?.id)
  if (!current) return 'unknown'
  return current === running ? 'current' : 'stale'
}

export function runsSupersededImage(images, container) {
  return containerImageState(images, container) === 'stale'
}

// A ref in the reserved namespace — built from a Containerfile, never pulled.
// True even when no definition matches, which is exactly the case worth
// warning about.
export function isManagedRef(images, ref) {
  const prefix = images?.managedPrefix
  return !!prefix && typeof ref === 'string' && ref.startsWith(prefix)
}

// What the table row shows instead of the list: how many projects depend on
// the image, and how many of them are running something older than the store
// holds. The second number is the one worth a colour — it is the only one a
// button can do anything about.
export function imageUserCounts(live, refs, slugs) {
  const users = imageUsers(live, refs, slugs)
  return { total: users.length, outdated: users.filter(u => u.imageState === 'stale').length }
}

const UNKNOWN_USER = { id: null, name: '', builds: false, runs: false, restartable: false, imageState: 'unknown' }

// How each project in an image's `used_by` list depends on it. The server
// decides *who* uses an image (live/images.js projectsUsing, the same list
// that gates the delete); this reads the same two fields to say *how*, which
// is what tells a restart ("recreate the container on the image in the store")
// apart from a deploy (the only thing that re-runs a build in a new sandbox).
// An empty field means the panel default, exactly as the server reads it.
//
// `reason` is why a restart would not help, and it is the point of the list
// as much as the names are: the count on the button is smaller than the count
// of names, and without a reason per name the difference is unaccountable.
export function imageUsers(live, refs, slugs) {
  const images = live?.images
  const bySlug = new Map(
    Object.values(live?.projects ?? {}).filter(p => p?.info?.slug).map(p => [p.info.slug, p])
  )
  // The engine's own view of what each project is running right now, which is
  // the only thing that can say whether a tag moved underneath it.
  const containerOf = new Map(
    Object.values(live?.system?.containers ?? {}).filter(c => c?.slug).map(c => [c.slug, c])
  )
  const fallback = images?.defaultImage ?? ''
  // One entry in the engine's store can wear several tags, and the server's
  // `used_by` is the union over all of them, so "how" is asked of the set.
  const wanted = new Set((refs ?? []).filter(Boolean))
  return (slugs ?? []).map(slug => {
    const project = bySlug.get(slug)
    const info = project?.info
    // A slug with no project in the mirror is still a user the server counted
    // — list it, say nothing about it.
    if (!info) return { ...UNKNOWN_USER, slug, name: slug, reason: '' }
    const builds = wanted.has(info.build_image || fallback)
    const runs = info.runtime === 'container' && wanted.has(info.run_image || info.build_image || fallback)
    // deployed_runtime is what exists, runtime what the next deploy will do.
    const isContainer = (info.deployed_runtime || info.runtime) === 'container'
    const online = project.pm2?.status === 'online'
    // Restart is a recreate, so it is how a container moves onto a newly
    // pulled image — but only for one that is a container now and is actually
    // running: restarting also starts, and would silently undo a deliberate
    // stop.
    const restartable = runs && isContainer && online
    return {
      slug,
      id: info.id,
      name: info.name,
      builds,
      runs,
      restartable,
      imageState: runs ? containerImageState(images, containerOf.get(slug)) : 'unknown',
      // Short, because the usage column next to it already says how the
      // project uses the image; this only has to say what to do instead.
      reason: restartable ? ''
        : !runs ? (builds ? 'needs a deploy, not a restart' : 'does not run it')
          : !isContainer ? 'not deployed as a container yet'
            : 'stopped',
    }
  })
}
