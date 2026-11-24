// Container CPU, measured by the panel itself: the CPU time a container used
// between two of the poller's own readings, over the time between them — a
// percentage of one core, the same unit pm2 reports (100 = one core busy).
//
// The engine's one-shot stats carry a "previous" reading of their own
// (precpu_stats), but which moment podman puts there is up to podman, and a
// stale one turned the reading into an average over who knows how long:
// containers idle for hours read 25% until restarted. Two readings the panel
// took itself have no such question — the figure is the load since the last
// poll (5 s while someone watches, a minute otherwise).
//
// A sample is { key, total, at }: `total` the cgroup's CPU time in ns (it
// only grows within one run), `at` the engine's own timestamp for the reading
// in ms, and `key` what makes a run one run (container id + start time) — a
// recreated or restarted container counts from zero again, so a reading
// across that boundary is dropped instead of computed.
const MIN_INTERVAL_MS = 1000

export function createCpuMeter() {
  const last = new Map() // name -> { key, total, at, value }

  return {
    // The percentage for this reading, or null while there is nothing to
    // compare it with (first sight, a new run, a stopped container).
    sample(name, s) {
      if (!s || typeof s.total !== 'number' || !Number.isFinite(s.at)) {
        last.delete(name)
        return null
      }
      const prev = last.get(name)
      if (!prev || prev.key !== s.key || s.total < prev.total) {
        last.set(name, { ...s, value: null })
        return null
      }
      const elapsed = s.at - prev.at
      // Two readings too close together say more about timer noise than
      // about load: keep the older one as the base and repeat what it said.
      if (elapsed < MIN_INTERVAL_MS) return prev.value
      const value = ((s.total - prev.total) / (elapsed * 1e6)) * 100
      last.set(name, { ...s, value })
      return value
    },

    // Forget containers the engine no longer lists.
    keepOnly(names) {
      for (const name of last.keys()) if (!names.has(name)) last.delete(name)
    },
  }
}
