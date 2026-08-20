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

// A ref in the reserved namespace — built from a Containerfile, never pulled.
// True even when no definition matches, which is exactly the case worth
// warning about.
export function isManagedRef(images, ref) {
  const prefix = images?.managedPrefix
  return !!prefix && typeof ref === 'string' && ref.startsWith(prefix)
}
