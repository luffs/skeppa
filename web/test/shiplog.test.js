import { describe, test, expect } from 'vitest'
import { logEntries, byDay, dayLabel, whenInDay, RECENT_DEPLOYMENTS_LIMIT } from '../src/lib/shiplog.js'
import { RECENT_DEPLOYMENTS_LIMIT as SERVER_LIMIT } from '../../server/src/live/state.js'

// The ship's log merges each project's deployment tail. A tail the server
// cut off may hide older voyages, so the merged log stops where the first
// such tail runs out — and the client can only tell a cut tail by its length.
test('the client knows how long a tail the server sends', () => {
  expect(RECENT_DEPLOYMENTS_LIMIT).toBe(SERVER_LIMIT)
})

const H = 3_600_000
const NOW = new Date(2026, 10, 18, 15, 0).getTime() // 18 Nov 2026, 15:00 local
const voyage = (id, msAgo) => {
  const iso = new Date(NOW - msAgo).toISOString()
  return { id, status: 'success', trigger: 'manual', commitSha: null, startedAt: iso, finishedAt: iso, createdAt: iso }
}
const project = (id, tail, extra = {}) => ({
  info: { id, name: `p${id}`, branch: 'main' }, recentDeployments: tail, deployedSha: 'a', headCommit: null, ...extra,
})

describe('logEntries', () => {
  test('newest first across projects, with unsighted commits among them', () => {
    const { entries, horizon } = logEntries([
      project(1, [voyage(3, 1 * H), voyage(1, 5 * H)]),
      project(2, [voyage(2, 3 * H)], { headCommit: { sha: 'b'.repeat(40), pushedAt: new Date(NOW - 2 * H).toISOString() } }),
    ])
    expect(entries.map(e => e.key)).toEqual(['d3', 'c2', 'd2', 'd1'])
    expect(horizon).toBe(0)
  })

  // p1 sent a full tail reaching back 20 hours; p2's one voyage from 30
  // hours ago is older than anything p1 could still show — so is anything
  // of p1's own past its tail. Showing p2's would claim p1 was quiet then.
  test('a full tail sets the horizon, and nothing older is shown', () => {
    const full = Array.from({ length: RECENT_DEPLOYMENTS_LIMIT }, (_, i) => voyage(100 - i, (i + 1) * H))
    const { entries, horizon } = logEntries([project(1, full), project(2, [voyage(7, 30 * H)])])
    expect(horizon).toBe(NOW - RECENT_DEPLOYMENTS_LIMIT * H)
    expect(entries.length).toBe(RECENT_DEPLOYMENTS_LIMIT)
    expect(entries.some(e => e.key === 'd7')).toBe(false)
  })

  test('someone else\'s entries carry the owner tag', () => {
    const { entries } = logEntries([project(1, [voyage(1, H)])], info => (info.id === 1 ? 'bob' : ''))
    expect(entries[0].owner).toBe('bob')
  })
})

describe('days', () => {
  test('Today, Yesterday, then the date — with the year only when it differs', () => {
    expect(dayLabel(NOW - H, NOW)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 18, 0, 5).getTime(), NOW)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 17, 23, 55).getTime(), NOW)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 10, 16, 12).getTime(), NOW)).toBe('Mon 16 Nov')
    expect(dayLabel(new Date(2025, 11, 31, 12).getTime(), NOW)).toBe('Wed 31 Dec 2025')
    expect(dayLabel(0, NOW)).toBe('Earlier')
  })

  test('entries are grouped under one heading per day, in order', () => {
    const days = byDay([{ ts: NOW - H }, { ts: NOW - 2 * H }, { ts: NOW - 26 * H }], NOW)
    expect(days.map(d => [d.label, d.entries.length])).toEqual([['Today', 2], ['Yesterday', 1]])
  })
})

// Under a day heading the day is said already: the clock time, or how long
// ago for the last hour. The dot says how a voyage went, the text once.
test('entries read short: number and outcome, then time, trigger, sha, duration', () => {
  const now = Date.now()
  const iso = ms => new Date(now - ms).toISOString()
  const d = { id: 7, status: 'failed', trigger: 'webhook', commitSha: 'abcdef1234', startedAt: iso(3 * H + 12_000), finishedAt: iso(3 * H), createdAt: iso(3 * H) }
  const { entries } = logEntries([project(1, [d])])
  expect(entries[0].text).toBe('#7 ran aground')
  const clock = new Date(now - 3 * H).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  expect(entries[0].meta).toBe(`${clock} · webhook · abcdef1 · 12.0s`)
})

test('whenInDay: minutes ago within the hour, the clock time after', () => {
  expect(whenInDay(NOW - 12 * 60_000, NOW)).toBe('12m ago')
  expect(whenInDay(new Date(2026, 10, 18, 9, 5).getTime(), NOW)).toBe('09:05')
  expect(whenInDay(0, NOW)).toBe('')
})

// The same particulars, each on its own, for the log laid out as a table;
// what is not known is '' there and left out of the one-line meta.
test('an entry carries its particulars apart as well as in one line', () => {
  const now = Date.now()
  const iso = ms => new Date(now - ms).toISOString()
  const d = { id: 7, status: 'success', trigger: 'webhook', commitSha: 'abcdef1234', startedAt: iso(3 * H + 12_000), finishedAt: iso(3 * H), createdAt: iso(3 * H) }
  const queued = { id: 8, status: 'queued', trigger: 'manual', commitSha: null, startedAt: null, finishedAt: null, createdAt: iso(630_000) } // ten and a half minutes: the clock may be a moment behind
  const head = { sha: 'c'.repeat(40), pushedAt: iso(2 * H) }
  const { entries } = logEntries([project(1, [queued, d], { headCommit: head })])
  const facts = e => [e.key, e.when, e.trigger, e.sha, e.took]
  const clock = ms => new Date(now - ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  expect(entries.map(facts)).toEqual([
    ['d8', '10m ago', 'manual', '', ''],
    ['c1', clock(2 * H), 'push', 'ccccccc', ''],
    ['d7', clock(3 * H), 'webhook', 'abcdef1', '12.0s'],
  ])
  expect(entries.map(e => e.meta)).toEqual(['10m ago · manual', `${clock(2 * H)} · push · ccccccc`, `${clock(3 * H)} · webhook · abcdef1 · 12.0s`])
})
