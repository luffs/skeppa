import { store } from '../store.js'

// Image suggestions for the build/run image fields: Shipyard-managed images
// plus the panel default. Both ride along in LiveState, so this is a plain
// read of the mirror — no fetch, no shared cache to keep from going stale,
// and the datalists follow every Shipyard change on their own.
export function imageRefs() {
  const images = store.live.images ?? {}
  return [...new Set([...(images.managed ?? []).map(m => m.ref), images.defaultImage].filter(Boolean))]
}
