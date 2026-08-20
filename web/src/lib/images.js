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

// A ref in the reserved namespace — built from a Containerfile, never pulled.
// True even when no definition matches, which is exactly the case worth
// warning about.
export function isManagedRef(images, ref) {
  const prefix = images?.managedPrefix
  return !!prefix && typeof ref === 'string' && ref.startsWith(prefix)
}
