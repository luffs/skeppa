import { reactive } from 'vue'
import { api } from '../api.js'

// Image suggestions for the build/run image fields: Shipyard-managed images
// plus the panel default. Fetched once per session and shared — the list
// changes rarely, and several fields across two views want the same options.
// The Shipyard is the only place that changes it, and it refetches after every
// mutation, so it seeds this list through setImageRefs rather than leaving the
// cached copy stale until a page reload.
export const imageRefs = reactive([])

let loading = null

function apply(data) {
  const refs = [...new Set([...data.managed.map(m => m.ref), data.default_image].filter(Boolean))]
  imageRefs.splice(0, imageRefs.length, ...refs)
}

export function loadImageRefs() {
  if (!loading) {
    loading = api.get('/api/images')
      .then(apply)
      .catch(() => {
        loading = null // suggestions are optional — let a later view retry
      })
  }
  return loading
}

// Adopt a payload the caller already fetched, and count it as the load — so a
// view opened afterwards uses these refs instead of issuing its own request.
export function setImageRefs(data) {
  apply(data)
  loading = Promise.resolve()
}
