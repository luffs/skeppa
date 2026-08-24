import { test, expect } from 'bun:test'
import { createCrashWatch } from '../src/live/crashwatch.js'

const MIN = 60_000

function watch(over = {}) {
  const alerts = []
  const w = createCrashWatch({ onAlert: (label, n) => alerts.push([label, n]), ...over })
  return { w, alerts }
}

test('the first sample is a baseline, not news', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 41, 0) // pre-existing restarts from before the panel watched
  expect(alerts).toEqual([])
})

test('three restarts inside the window alert once, then the cooldown mutes', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 0, 0)
  w.sample('1', 'app', 1, 1 * MIN)
  w.sample('1', 'app', 2, 2 * MIN)
  expect(alerts).toEqual([])
  w.sample('1', 'app', 3, 3 * MIN)
  expect(alerts).toEqual([['app', 3]])
  // the loop keeps crashing — still inside the cooldown, no second message
  w.sample('1', 'app', 9, 5 * MIN)
  expect(alerts.length).toBe(1)
  // after the cooldown a fresh burst alerts again
  w.sample('1', 'app', 12, 40 * MIN)
  expect(alerts.length).toBe(2)
})

test('slow restarts that never cluster stay quiet', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 0, 0)
  for (let i = 1; i <= 6; i++) w.sample('1', 'app', i, i * 11 * MIN) // one per 11 min
  expect(alerts).toEqual([])
})

test('a counter reset (recreated container) is a fresh start, not a crash', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 8, 0)
  w.sample('1', 'app', 0, 1 * MIN) // deploy recreated the container
  w.sample('1', 'app', 2, 2 * MIN)
  expect(alerts).toEqual([])
  w.sample('1', 'app', 3, 3 * MIN)
  expect(alerts).toEqual([['app', 3]])
})

test('processes are tracked separately', () => {
  const { w, alerts } = watch()
  w.sample('1', 'a', 0, 0)
  w.sample('2', 'b', 0, 0)
  w.sample('1', 'a', 2, MIN)
  w.sample('2', 'b', 1, MIN)
  w.sample('1', 'a', 3, 2 * MIN)
  expect(alerts).toEqual([['a', 3]])
})

test('a counter reset drops the crash history behind it', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 0, 0)
  w.sample('1', 'app', 2, 1 * MIN) // two crashes, one short of the threshold
  w.sample('1', 'app', 0, 2 * MIN) // deploy recreated the container
  w.sample('1', 'app', 1, 3 * MIN) // one ordinary restart of the new one
  expect(alerts).toEqual([]) // crashes from the old container must not count
})

test('a counter reset lifts the cooldown so a new crash loop is heard', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 0, 0)
  w.sample('1', 'app', 3, 1 * MIN)
  expect(alerts.length).toBe(1) // alerted, and now muted for 30 minutes
  w.sample('1', 'app', 0, 2 * MIN) // redeployed to fix it — and it still crashes
  w.sample('1', 'app', 3, 4 * MIN)
  expect(alerts.length).toBe(2) // muting a brand new process would hide this
})

test('rebase absorbs a panel-caused restart instead of counting it', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 0, 0)
  w.sample('1', 'app', 2, 1 * MIN) // two real crashes, one short of the threshold
  w.rebase('1') // the panel deploys: the reload will bump the counter
  w.sample('1', 'app', 3, 2 * MIN) // the +1 lands as a fresh baseline
  w.sample('1', 'app', 4, 3 * MIN) // one ordinary restart of the new code
  expect(alerts).toEqual([]) // neither the deploy nor the old history may alert
})

test('rebase lifts the cooldown so the redeployed process is heard again', () => {
  const { w, alerts } = watch()
  w.sample('1', 'app', 0, 0)
  w.sample('1', 'app', 3, 1 * MIN)
  expect(alerts.length).toBe(1) // alerted and muted for 30 minutes
  w.rebase('1') // operator deploys a fix — which does not work
  w.sample('1', 'app', 4, 2 * MIN)
  w.sample('1', 'app', 7, 4 * MIN)
  expect(alerts.length).toBe(2) // the stale mute must not hide the new loop
})
