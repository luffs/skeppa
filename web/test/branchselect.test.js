import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// The branch select: the repository's branches once they are read, typed
// otherwise — and a branch the list does not hold is kept, never changed.

const calls = []
vi.mock('../src/api.js', () => ({
  api: {
    get: async url => {
      calls.push(url)
      const repo = new URLSearchParams(url.split('?')[1]).get('repo')
      if (repo.startsWith('gone/')) throw new Error('GitHub said no')
      return { default_branch: 'main', branches: ['dev', 'main', 'release/2'], more: repo === 'big/repo' }
    },
  },
}))

import BranchSelect from '../src/components/BranchSelect.vue'

beforeEach(() => { calls.length = 0 })
const settle = async () => { await flushPromises(); await flushPromises() }
let n = 0
const fresh = () => `o/r${++n}` // the list is kept per repository: a new one is read again

async function show(props) {
  const wrapper = mount(BranchSelect, { props })
  await settle()
  return wrapper
}
const options = w => w.findAll('option').map(o => o.text())

test('the repository\'s branches, the default marked, the one in use selected', async () => {
  const repo = fresh()
  const w = await show({ repo, modelValue: 'release/2' })
  expect(calls).toEqual([`/api/github/repos/branches?repo=${encodeURIComponent(repo)}`])
  expect(options(w)).toEqual(['dev', 'main (default)', 'release/2'])
  expect(w.find('select').element.value).toBe('release/2')
  await w.find('select').setValue('dev')
  expect(w.emitted('update:modelValue').at(-1)).toEqual(['dev'])
})

test('a branch the list does not hold stays, marked — and is not changed by opening', async () => {
  const w = await show({ repo: fresh(), modelValue: 'old-thing' })
  expect(options(w)[0]).toBe('old-thing — not on GitHub')
  expect(w.find('select').element.value).toBe('old-thing')
  expect(w.emitted('update:modelValue')).toBeUndefined()
})

test('no branch yet: the default one', async () => {
  const w = await show({ repo: fresh(), modelValue: '' })
  expect(w.emitted('update:modelValue')).toEqual([['main']])
})

test('typed instead: before a repository, when it cannot be read, or by choice', async () => {
  const none = await show({ repo: '', modelValue: 'main' })
  expect(none.find('select').exists()).toBe(false)
  expect(none.find('input').element.value).toBe('main')
  expect(calls).toEqual([])

  const broken = await show({ repo: 'gone/repo', modelValue: 'main' })
  expect(broken.find('select').exists()).toBe(false)
  expect(broken.text()).toContain("Couldn't read the branches (GitHub said no)")

  const picked = await show({ repo: fresh(), modelValue: 'main' })
  await picked.findAll('button').find(b => b.text() === 'Type a name').trigger('click')
  await picked.find('input').setValue('not-pushed-yet')
  expect(picked.emitted('update:modelValue').at(-1)).toEqual(['not-pushed-yet'])
  await picked.findAll('button').find(b => b.text() === 'Pick from the list').trigger('click')
  expect(picked.find('select').exists()).toBe(true)
})

test('read once per repository; a long list says it was cut', async () => {
  const repo = fresh()
  await show({ repo, modelValue: 'main' })
  await show({ repo, modelValue: 'dev' })
  expect(calls.length).toBe(1)
  const big = await show({ repo: 'big/repo', modelValue: 'main' })
  expect(big.text()).toContain('Only the first 3 are listed')
})
