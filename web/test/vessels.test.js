import { describe, test, expect } from 'vitest'
import { vesselState, summarizeVessels } from '../src/lib/vessels.js'

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
