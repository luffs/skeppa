import { reactive } from 'vue'
import { api } from '../api.js'

// Image suggestions for the build/run image fields: Shipyard-managed images
// plus the panel default. Fetched once per session and shared — the list
// changes rarely, and several fields across two views want the same options.
export const imageRefs = reactive([])

let loading = null

export function loadImageRefs() {
  if (!loading) {
    loading = api.get('/api/images')
      .then(d => {
        const refs = [...new Set([...d.managed.map(m => m.ref), d.default_image].filter(Boolean))]
        imageRefs.splice(0, imageRefs.length, ...refs)
      })
      .catch(() => {
        loading = null // suggestions are optional — let a later view retry
      })
  }
  return loading
}
