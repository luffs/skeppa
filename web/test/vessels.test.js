import { describe, test, expect } from 'vitest'
import { vesselState, summarizeVessels, statusWord, voyage, usualVoyage } from '../src/lib/vessels.js'

// A folded pier sums its vessels up with one state each — the most pressing
// — so the counts always add up to the number of vessels.
const live = (over = {}) => ({
  pm2: { status: 'online' },
  currentDeployment: null,
  lastDeployment: { id: 1, status: 'success' },
  deployedSha: 'a',
  headCommit: { sha: 'a' },
  ...over,
})

describe('vesselState', () => {
  test('the most pressing state wins', () => {
    expect(vesselState(live({ currentDeployment: { id: 2 }, pm2: { status: 'errored' } }))).toBe('underway')
    expect(vesselState(live({ pm2: { status: 'stopped' }, lastDeployment: { status: 'failed' } }))).toBe('down')
    expect(vesselState(live({ lastDeployment: { status: 'failed' }, headCommit: { sha: 'b' } }))).toBe('failed')
    expect(vesselState(live({ headCommit: { sha: 'b' } }))).toBe('ahead')
    expect(vesselState(live())).toBe('running')
    expect(vesselState(live({ pm2: { status: 'published' } }))).toBe('running')
  })

  // LiveState leaves out what is unknown (null is a deletion), so a fresh
  // project has no headCommit, no lastDeployment, an unknown process.
  test('missing pieces read as idle, never as trouble', () => {
    expect(vesselState(null)).toBe('idle')
    expect(vesselState({ pm2: { status: 'unknown' } })).toBe('idle')
    expect(vesselState({ pm2: { status: 'not published' } })).toBe('idle')
  })
})

test('the summary lists present states in a fixed order, with counts', () => {
  const lives = [live(), live(), live({ headCommit: { sha: 'b' } }), live({ pm2: { status: 'stopped' } }), null]
  expect(summarizeVessels(lives).map(s => s.text)).toEqual(['1 down', '1 with new commits', '2 running', '1 idle'])
  expect(summarizeVessels([])).toEqual([])
})

// One word for one state, in the row and on the project page alike.
test('statusWord says "never deployed" before the first voyage, the poller\'s word after', () => {
  expect(statusWord({ pm2: { status: 'not published' } })).toBe('never deployed')
  expect(statusWord({ pm2: { status: 'unknown' } })).toBe('never deployed')
  expect(statusWord(null)).toBe('never deployed')
  expect(statusWord({ pm2: { status: 'not published' }, currentDeployment: { id: 1 } })).toBe('not published')
  expect(statusWord({ pm2: { status: 'not published' }, lastDeployment: { status: 'success' } })).toBe('not published')
  // a process running without any voyage (started by hand) is what it is
  expect(statusWord({ pm2: { status: 'online' } })).toBe('online')
})

// A voyage's progress, against the project's last good deploys.
test('voyage: how far along a deploy is, against how long the last good ones took', () => {
  const T = Date.parse('2026-11-20T12:00:00.000Z')
  const at = s => new Date(T + s * 1000).toISOString()
  const done = (id, secs, status = 'success') => ({ id, status, startedAt: at(-1000 - id * 100), finishedAt: at(-1000 - id * 100 + secs) })
  const live = (startedAt, recent) => ({ currentDeployment: { id: 99, status: startedAt ? 'running' : 'queued', ...(startedAt ? { startedAt } : {}) }, recentDeployments: recent })
  const history = [done(1, 40), done(2, 60), done(3, 50), done(4, 500, 'failed'), done(5, 0)]

  expect(voyage({ currentDeployment: null }, T)).toBe(null)
  expect(voyage(live(null, history), T)).toEqual({ p: 0, overdue: false, expected: null, elapsed: 0 }) // queued
  // the median of 40, 50 and 60 s — the failed one and the instant one do not count
  expect(voyage(live(at(-25), history), T)).toEqual({ p: 0.5, overdue: false, expected: 50_000, elapsed: 25_000 })
  expect(voyage(live(at(-60), history), T).p).toBe(1) // past usual: full, not yet overdue
  expect(voyage(live(at(-60), history), T).overdue).toBe(false)
  expect(voyage(live(at(-86), history), T).overdue).toBe(true) // 1.5 × 50 s + 10 s
  // nothing to go by: creeping, never overdue
  const blind = voyage(live(at(-60), [done(4, 500, 'failed')]), T)
  expect(blind.p).toBe(0.5)
  expect(voyage(live(at(-3600), []), T).overdue).toBe(false)
})

test('usualVoyage: the median of the last good deploys, none to go by → null', () => {
  const d = (id, start, end, status = 'success') => ({ id, status, startedAt: new Date(start * 1000).toISOString(), finishedAt: new Date(end * 1000).toISOString() })
  expect(usualVoyage({ recentDeployments: [d(1, 0, 40), d(2, 100, 160), d(3, 200, 250), d(4, 300, 900, 'failed')] })).toBe(50_000)
  expect(usualVoyage({ recentDeployments: [d(1, 0, 40), d(2, 100, 160)] })).toBe(50_000) // even: halfway between
  // the one under way is not its own yardstick
  expect(usualVoyage({ currentDeployment: { id: 2 }, recentDeployments: [d(1, 0, 40), d(2, 100, 160)] })).toBe(40_000)
  expect(usualVoyage({ recentDeployments: [] })).toBe(null)
  expect(usualVoyage(null)).toBe(null)
})
