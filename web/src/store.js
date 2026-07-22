import { reactive } from 'vue'
import { LazyWatch } from 'lazy-watch'

// `live` mirrors the server's LiveState. It is replaced wholesale on every
// full snapshot and patched with lazy-watch diffs in between. Because it sits
// inside a Vue reactive object, patched changes render automatically.
export const store = reactive({
  user: null,
  connected: false,
  live: { projects: {} },
})

export function applyFullState(state) {
  store.live = state
}

export function applyStateDiff(diff) {
  LazyWatch.patch(store.live, diff)
}

export function liveProject(projectId) {
  return store.live.projects?.[projectId] ?? null
}
