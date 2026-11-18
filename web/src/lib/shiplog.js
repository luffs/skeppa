import { store } from '../store.js'
import { timeAgo, duration } from './format.js'

// The ship's log: every project's deployment tail (LiveState
// `recentDeployments`) plus unsighted commits, newest first.
//
// The server sends each project's last RECENT_DEPLOYMENTS_LIMIT voyages —
// kept equal to server/src/live/state.js by web/test/shiplog.test.js. More
// than the log shows at first, so "Show more" needs no request; but a
// project with a full tail may have older voyages the client never got. Past
// the point where the first such tail runs out, the merged log would quietly
// skip that project's history while showing everyone else's, so it stops
// there: the horizon.
export const RECENT_DEPLOYMENTS_LIMIT = 20

// The dot already says how it went; the words say it once.
const TEXT = {
  success: id => `#${id} made port`,
  failed: id => `#${id} ran aground`,
  running: id => `#${id} under way…`,
  queued: id => `#${id} waiting to depart`,
  cancelled: id => `#${id} called off`,
}
const DOT = { success: 'green', failed: 'red', running: 'blue pulse', queued: 'amber', cancelled: '' }

const at = iso => (iso ? new Date(iso).getTime() : 0)

// Under a day heading the day is said already: the last hour reads as
// "12m ago", anything older as the clock time, in the viewer's zone.
export function whenInDay(ts, now = store.now) {
  if (!ts) return ''
  if (now - ts < 3_600_000) return timeAgo(new Date(ts).toISOString(), now)
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// `lives` are LiveState project entries; `ownerOf(info)` tags someone else's
// entries ('' for your own). Returns { entries, horizon } — horizon is the
// instant older entries were cut at, or 0 when nothing was cut.
export function logEntries(lives, ownerOf = () => '') {
  const entries = []
  let horizon = 0
  for (const p of lives) {
    const info = p?.info
    if (!info) continue
    const base = { owner: ownerOf(info), project: info.name, projectId: info.id }
    const tail = p.recentDeployments ?? []
    for (const d of tail) {
      const when = d.finishedAt || d.startedAt || d.createdAt
      entries.push({
        ...base,
        key: `d${d.id}`,
        ts: at(when),
        text: (TEXT[d.status] ?? (id => `#${id} ${d.status}`))(d.id),
        meta: [whenInDay(at(when)), d.trigger, d.commitSha?.slice(0, 7), duration(d.startedAt, d.finishedAt)]
          .filter(v => v && v !== '—')
          .join(' · '),
        dot: DOT[d.status] ?? '',
      })
    }
    if (tail.length >= RECENT_DEPLOYMENTS_LIMIT) {
      const oldest = Math.min(...tail.map(d => at(d.finishedAt || d.startedAt || d.createdAt)))
      horizon = Math.max(horizon, oldest)
    }
    if (p.headCommit?.sha && !p.currentDeployment && p.headCommit.sha !== p.deployedSha) {
      entries.push({
        ...base,
        key: `c${info.id}`,
        ts: at(p.headCommit.pushedAt),
        text: `new commits on ${info.branch}`,
        meta: [whenInDay(at(p.headCommit.pushedAt)), 'push', p.headCommit.sha.slice(0, 7)].filter(Boolean).join(' · '),
        dot: 'amber',
      })
    }
  }
  return {
    entries: entries.filter(e => e.ts >= horizon).sort((a, b) => b.ts - a.ts),
    horizon,
  }
}

const startOfDay = ms => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// "Today", "Yesterday", then "Mon 16 Nov" (with the year once it is not
// this one), in the viewer's own time zone. Unknown instants are "Earlier".
export function dayLabel(ts, now = store.now) {
  if (!ts) return 'Earlier'
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(ts)
  const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${d.getFullYear()}`
}

// Consecutive entries under one heading per day; entries arrive newest first.
export function byDay(entries, now = store.now) {
  const days = []
  for (const e of entries) {
    const label = dayLabel(e.ts, now)
    if (days.at(-1)?.label !== label) days.push({ label, entries: [] })
    days.at(-1).entries.push(e)
  }
  return days
}
