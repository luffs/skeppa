// Turns restart counters into at most one alert per burst. Each sample is the
// current cumulative counter for one process; the watcher alerts when it grew
// by `threshold` within `windowMs`, then mutes that process for `cooldownMs`
// so a crash loop sends one message, not one per poll. A counter that goes
// BACKWARDS (a recreated container starts back at zero) only resets the
// baseline — a fresh start is not a crash.
export function createCrashWatch({ threshold = 3, windowMs = 10 * 60_000, cooldownMs = 30 * 60_000, onAlert }) {
  const seen = new Map() // key -> { last, events: [ms], mutedUntil }

  return {
    sample(key, label, count, now = Date.now()) {
      if (typeof count !== 'number') return
      const s = seen.get(key)
      if (!s) {
        // First sight is the baseline: restarts from before the panel started
        // watching are history, not news.
        seen.set(key, { last: count, events: [], mutedUntil: 0 })
        return
      }
      const delta = count - s.last
      s.last = count
      for (let i = 0; i < Math.min(delta, 50); i++) s.events.push(now)
      s.events = s.events.filter(t => now - t <= windowMs)
      if (s.events.length >= threshold && now >= s.mutedUntil) {
        s.mutedUntil = now + cooldownMs
        const n = s.events.length
        s.events = []
        onAlert(label, n)
      }
    },
  }
}
