import { test, expect, vi, beforeEach } from 'vitest'
import { store, noteServerDate, serverNow } from '../src/store.js'
import { api } from '../src/api.js'

// The server's clock, as near as the browser can tell: every time the views
// set against store.now is the server's (a deploy's startedAt), so a browser
// whose clock is off must not throw a voyage a minute out.
beforeEach(() => { store.clockSkew = 0 })

const T = Date.parse('2026-11-20T12:00:00.000Z')
const header = ms => new Date(ms).toUTCString() // whole seconds, as a Date header has them

test('a server a minute ahead: the skew is taken from the middle of its second and of the round trip', () => {
  noteServerDate(header(T + 60_000), T - 100, T + 100)
  expect(store.clockSkew).toBe(60_500)
  expect(serverNow() - Date.now()).toBe(60_500)
})

test('within what a whole-second header can tell, nothing is corrected', () => {
  noteServerDate(header(T + 800), T - 50, T + 50)
  expect(store.clockSkew).toBe(0)
  noteServerDate(header(T - 1000), T - 50, T + 50)
  expect(store.clockSkew).toBe(0)
})

test('a slow answer, a missing header and a jitter under a second change nothing', () => {
  noteServerDate(header(T + 60_000), T - 1500, T + 1500) // 3 s there and back
  expect(store.clockSkew).toBe(0)
  noteServerDate(null, T, T)
  expect(store.clockSkew).toBe(0)
  noteServerDate(header(T - 30_000), T - 100, T + 100)
  expect(store.clockSkew).toBe(-29_500)
  noteServerDate(header(T - 30_000), T - 600, T + 300) // the same second, measured a little differently
  expect(store.clockSkew).toBe(-29_500)
})

test('every API answer is measured', async () => {
  const now = Date.now()
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { headers: { date: header(now + 120_000) } }))
  try {
    await api.get('/api/anything')
    expect(Math.abs(store.clockSkew - 120_000)).toBeLessThan(1500)
    expect(Math.abs(store.now - (Date.now() + store.clockSkew))).toBeLessThan(1000)
  } finally {
    fetch.mockRestore()
  }
})
