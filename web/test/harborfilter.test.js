import { test, expect } from 'vitest'
import { filterWords, matchesSearch, matchesState, stateCounts } from '../src/lib/harborFilter.js'

// The harbor's filter: words in any order over name, repository, branch,
// pier and owner; states the same as the rows' (lib/vessels.js).
const info = { name: 'api', repo_full_name: 'luff/shop-api', git_url: '', branch: 'release/2' }

test('every word, in any order, across name, repo, branch, pier and owner', () => {
  const w = filterWords
  expect(matchesSearch(info, w('shop api'))).toBe(true)
  expect(matchesSearch(info, w('RELEASE'))).toBe(true)
  expect(matchesSearch(info, w('kund api'), { pierName: 'Kunder' })).toBe(true)
  expect(matchesSearch(info, w('bob'), { ownerName: 'bob' })).toBe(true)
  expect(matchesSearch(info, w('api blog'))).toBe(false)
  expect(matchesSearch(info, w('   '))).toBe(true)
})

const live = over => ({ pm2: { status: 'online' }, lastDeployment: { status: 'success' }, deployedSha: 'a', headCommit: { sha: 'a' }, ...over })

test('the state filters let through the states the rows show', () => {
  const ahead = live({ headCommit: { sha: 'b' } })
  const down = live({ pm2: { status: 'stopped' } })
  const failed = live({ lastDeployment: { status: 'failed' } })
  const fine = live()
  for (const l of [ahead, down, failed]) expect(matchesState(l, 'attention')).toBe(true)
  expect(matchesState(fine, 'attention')).toBe(false)
  expect(matchesState(fine, 'running')).toBe(true)
  expect(matchesState(down, 'running')).toBe(false)
  expect(matchesState(down, '')).toBe(true)
  expect(matchesState(down, 'nonsense')).toBe(true)
  expect(stateCounts([ahead, down, failed, fine, null])).toEqual({ attention: 3, running: 1 })
})
