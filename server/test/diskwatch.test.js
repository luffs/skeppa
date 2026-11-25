import { test, expect } from 'bun:test'
import { createDiskWatch } from '../src/lib/diskwatch.js'

// A disk nearly full is said once when it crosses 90 %, and once more when
// it is back under 85 % — not on every check in between.
test('a full disk is said once, and once when it is back', () => {
  const said = []
  let disk = { total: 100e9, free: 50e9 }
  const watch = createDiskWatch({ read: () => disk, notify: text => said.push(text) })
  expect(watch.check()).toBe(50)
  disk = { total: 100e9, free: 8e9 }
  expect(watch.check()).toBe(92)
  watch.check()
  disk = { total: 100e9, free: 12e9 } // 88 %: still over the clearing line
  watch.check()
  expect(said).toHaveLength(1)
  expect(said[0]).toBe('⚠ Disk 92% full — 8.0 GB free of 100.0 GB. Builds and apps that write will start failing; prune images in the Shipyard or clear space.')
  disk = { total: 100e9, free: 20e9 }
  watch.check()
  expect(said[1]).toBe('✔ Disk back at 80% — 20.0 GB free.')
  expect(watch.alerted).toBe(false)
})

test('an unknown disk says nothing', () => {
  const said = []
  const watch = createDiskWatch({ read: () => undefined, notify: text => said.push(text) })
  expect(watch.check()).toBeNull()
  expect(createDiskWatch({ read: () => ({ total: 0, free: 0 }), notify: () => said.push('x') }).check()).toBeNull()
  expect(said).toEqual([])
})
