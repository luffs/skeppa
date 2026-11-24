import { test, expect } from 'bun:test'
import { createCpuMeter } from '../src/live/cpumeter.js'

const S = 1e9 // ns in a second
const sample = (total, at, key = 'c@t0') => ({ key, total, at })

test('percent of one core between two readings, nothing on the first', () => {
  const m = createCpuMeter()
  expect(m.sample('a', sample(10 * S, 0))).toBe(null)
  expect(m.sample('a', sample(10.5 * S, 5000))).toBe(10) // 0.5 s over 5 s
  expect(m.sample('a', sample(20.5 * S, 10_000))).toBe(200) // two cores busy
})

test('a new run of the container starts over instead of comparing across it', () => {
  const m = createCpuMeter()
  m.sample('a', sample(50 * S, 0))
  expect(m.sample('a', sample(0.1 * S, 5000, 'c@t1'))).toBe(null) // restarted: new key
  expect(m.sample('a', sample(0.6 * S, 10_000, 'c@t1'))).toBe(10)
  // a counter that went backwards under the same key is a new run too
  expect(m.sample('a', sample(0.2 * S, 15_000, 'c@t1'))).toBe(null)
})

test('readings too close together repeat the last figure and keep the base', () => {
  const m = createCpuMeter()
  m.sample('a', sample(0, 0))
  expect(m.sample('a', sample(1 * S, 10_000))).toBe(10)
  expect(m.sample('a', sample(1.4 * S, 10_300))).toBe(10)
  expect(m.sample('a', sample(1.5 * S, 15_000))).toBe(10) // still against the 10 s base
})

test('a stopped container, and one the engine no longer lists, are forgotten', () => {
  const m = createCpuMeter()
  m.sample('a', sample(0, 0))
  expect(m.sample('a', null)).toBe(null)
  expect(m.sample('a', sample(1 * S, 5000))).toBe(null) // no base left
  m.sample('b', sample(0, 0))
  m.keepOnly(new Set(['a']))
  expect(m.sample('b', sample(1 * S, 5000))).toBe(null)
})
