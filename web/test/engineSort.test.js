import { describe, test, expect, beforeEach } from 'vitest'
import { sortRows, nextSort, loadSort, saveSort, DEFAULT_SORT } from '../src/lib/engineSort.js'

const NOW = 1_000_000_000
const row = (name, over = {}) => ({ name, projectLabel: name, status: 'online', uptime: NOW - 1000, cpu: 1, memory: 10, restarts: 0, pid: 1, ...over })
const names = rows => rows.map(r => r.name)

describe('sorting the engine room tables', () => {
  const rows = [
    row('b', { memory: 300, cpu: null, status: 'stopped', uptime: 0, restarts: 4 }),
    row('a', { memory: 100, cpu: 5, uptime: NOW - 5000 }),
    row('c', { memory: 200, cpu: 2, status: 'errored', uptime: NOW - 100 }),
  ]

  test('names go A→Z by default', () => {
    expect(names(sortRows(rows, DEFAULT_SORT, NOW))).toEqual(['a', 'b', 'c'])
  })

  test('readings sort by value both ways', () => {
    expect(names(sortRows(rows, { key: 'mem', dir: 'desc' }, NOW))).toEqual(['b', 'c', 'a'])
    expect(names(sortRows(rows, { key: 'mem', dir: 'asc' }, NOW))).toEqual(['a', 'c', 'b'])
  })

  test('a missing reading stays last whichever way the column runs', () => {
    expect(names(sortRows(rows, { key: 'cpu', dir: 'desc' }, NOW))).toEqual(['a', 'c', 'b'])
    expect(names(sortRows(rows, { key: 'cpu', dir: 'asc' }, NOW))).toEqual(['c', 'a', 'b'])
    // not running: no uptime to compare
    expect(names(sortRows(rows, { key: 'up', dir: 'desc' }, NOW))).toEqual(['a', 'c', 'b'])
  })

  test('status puts what needs a look first', () => {
    expect(names(sortRows(rows, { key: 'status', dir: 'asc' }, NOW))).toEqual(['c', 'b', 'a'])
  })

  test('ties fall back to the name, so the order holds between polls', () => {
    const same = [row('z'), row('m'), row('a')]
    expect(names(sortRows(same, { key: 'restarts', dir: 'desc' }, NOW))).toEqual(['a', 'm', 'z'])
  })

  test('a click flips the sorted column and starts another its own way', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' })
    expect(nextSort({ key: 'name', dir: 'asc' }, 'mem')).toEqual({ key: 'mem', dir: 'desc' })
    expect(nextSort({ key: 'mem', dir: 'desc' }, 'project')).toEqual({ key: 'project', dir: 'asc' })
  })
})

describe('remembering the sort', () => {
  beforeEach(() => localStorage.clear())

  test('round-trips, and anything unreadable is the default', () => {
    saveSort('k', { key: 'cpu', dir: 'desc' })
    expect(loadSort('k')).toEqual({ key: 'cpu', dir: 'desc' })
    localStorage.setItem('k', '{"key":"nope","dir":"asc"}')
    expect(loadSort('k')).toEqual(DEFAULT_SORT)
    localStorage.setItem('k', 'not json')
    expect(loadSort('k')).toEqual(DEFAULT_SORT)
  })
})
