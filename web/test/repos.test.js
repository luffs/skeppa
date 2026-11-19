import { describe, test, expect } from 'vitest'
import { searchWords, matchesRepo, sortRepos, groupRepos, inScope, highlight } from '../src/lib/repos.js'

// The repository picker's logic: search in any word order, three sorts that
// never shuffle ties, groups only when there is more than one account, and
// highlighting as plain text pieces (the template wraps them, no HTML).
const repo = (full, extra = {}) => {
  const [owner, name] = full.split('/')
  return { full_name: full, owner, name, description: '', pushed_at: '', created_at: '', archived: false, ...extra }
}
const names = list => list.map(r => r.full_name)

describe('search', () => {
  const r = repo('luff/skeppa-panel', { description: 'Self-hosted deploy panel' })
  test('every word, in any order, in the name or the description', () => {
    expect(matchesRepo(r, searchWords('skep pan'))).toBe(true)
    expect(matchesRepo(r, searchWords('PANEL luff'))).toBe(true)
    expect(matchesRepo(r, searchWords('deploy self'))).toBe(true)
    expect(matchesRepo(r, searchWords('skeppa blog'))).toBe(false)
    expect(matchesRepo(r, searchWords('   '))).toBe(true)
  })
})

describe('sorting', () => {
  const list = [
    repo('a/zeta', { pushed_at: '2026-11-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' }),
    repo('b/Alpha', { pushed_at: '2026-11-10T00:00:00Z', created_at: '2024-01-01T00:00:00Z' }),
    repo('a/beta', { pushed_at: '', created_at: '2025-06-01T00:00:00Z' }),
    repo('c/alpha', { pushed_at: '2026-11-10T00:00:00Z', created_at: '2024-01-01T00:00:00Z' }),
  ]
  test('by name: A–Z by repository name, case aside, the full name breaking ties', () => {
    expect(names(sortRepos(list, 'name'))).toEqual(['b/Alpha', 'c/alpha', 'a/beta', 'a/zeta'])
  })
  test('by last push and by creation: newest first, never-pushed last, ties by name', () => {
    expect(names(sortRepos(list, 'pushed'))).toEqual(['b/Alpha', 'c/alpha', 'a/zeta', 'a/beta'])
    expect(names(sortRepos(list, 'created'))).toEqual(['a/beta', 'b/Alpha', 'c/alpha', 'a/zeta'])
  })
  test('the input is left as it was', () => {
    const before = names(list)
    sortRepos(list, 'name')
    expect(names(list)).toEqual(before)
  })
})

describe('groups', () => {
  test('one account is a plain list', () => {
    expect(groupRepos([repo('a/x'), repo('a/y')]).map(g => g.owner)).toEqual([null])
    expect(groupRepos([])).toEqual([])
  })
  test('several accounts are groups, A–Z, each in the order it was given', () => {
    const groups = groupRepos([repo('zed/b'), repo('Amy/c'), repo('zed/a')])
    expect(groups.map(g => [g.owner, names(g.repos)])).toEqual([['Amy', ['Amy/c']], ['zed', ['zed/b', 'zed/a']]])
  })
  test('yours first, the others A–Z after; Mine shows only yours', () => {
    const list = [repo('Amy/c'), repo('zed/b', { mine: true }), repo('bob/x'), repo('zed/a', { mine: true })]
    const groups = groupRepos(list)
    expect(groups.map(g => [g.owner, g.mine])).toEqual([['zed', true], ['Amy', false], ['bob', false]])
    expect(names(groups[0].repos)).toEqual(['zed/b', 'zed/a'])
    expect(names(list.filter(r => inScope(r, 'mine')))).toEqual(['zed/b', 'zed/a'])
    expect(list.filter(r => inScope(r, 'all')).length).toBe(4)
    expect(groupRepos([repo('zed/a', { mine: true })])).toEqual([{ owner: null, mine: true, repos: [repo('zed/a', { mine: true })] }])
  })
})

describe('highlight', () => {
  test('the matched stretches as hits, the rest as plain pieces', () => {
    expect(highlight('skeppa-panel', ['pan', 'skep'])).toEqual([
      { text: 'skep', hit: true }, { text: 'pa-', hit: false }, { text: 'pan', hit: true }, { text: 'el', hit: false },
    ])
  })
  test('overlapping words merge, case is kept, no words is no hits', () => {
    expect(highlight('Banana', ['ana', 'nan'])).toEqual([{ text: 'B', hit: false }, { text: 'anana', hit: true }])
    expect(highlight('Blog', [])).toEqual([{ text: 'Blog', hit: false }])
  })
  test('markup in a name stays text', () => {
    expect(highlight('<b>x</b>', ['x']).map(s => s.text).join('')).toBe('<b>x</b>')
  })
})
