import { store } from '../store.js'

// Relative labels default to the store's ticking clock, which is what makes
// them live: any computed or template calling them reads store.now and
// re-renders as time passes. Pass `now` explicitly for a fixed instant.
export function timeAgo(iso, now = store.now) {
  if (!iso) return '—'
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function duration(startIso, endIso) {
  if (!startIso || !endIso) return '—'
  const s = (new Date(endIso) - new Date(startIso)) / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

export function uptimeSince(ms, now = store.now) {
  if (!ms) return '—'
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export function bytes(n) {
  if (n == null) return '—'
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

export function secondsToHuman(s) {
  if (s == null) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}
