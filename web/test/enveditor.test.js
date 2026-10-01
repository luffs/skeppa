import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// The Manifest editor: rows, the text view, paste-merge, and multi-line values
// in rows — against a stubbed API that stores what Save all sends.

const stored = new Map()
const calls = []
vi.mock('../src/api.js', () => ({
  api: {
    get: async url => {
      calls.push(`GET ${url}`)
      const reveal = url.includes('reveal=1')
      return [...stored].sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, value: reveal ? value : null, masked: !reveal }))
    },
    put: async (url, body) => {
      calls.push(`PUT ${url}`)
      stored.clear()
      for (const { key, value } of body) stored.set(key, value)
      return { ok: true }
    },
  },
}))

import EnvEditor from '../src/components/EnvEditor.vue'

const PEM = '-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----'

beforeEach(() => {
  stored.clear()
  calls.length = 0
  stored.set('API_KEY', 'secret')
  stored.set('PRIVATE_KEY', PEM)
})

const settle = async () => { await flushPromises(); await flushPromises() }
const button = (wrapper, label) => wrapper.findAll('button').find(b => b.text() === label)
const preview = wrapper => wrapper.findAll('.env-preview li').map(li => li.text())

async function editor() {
  const wrapper = mount(EnvEditor, { props: { projectId: 7 } })
  await settle()
  return wrapper
}

test('a multi-line value gets a multi-line box in rows, and keeps its line breaks through an edit', async () => {
  const wrapper = await editor()
  // hidden: nothing to see, nothing editable to break
  expect(wrapper.findAll('textarea.multiline').length).toBe(0)

  await button(wrapper, 'Reveal values').trigger('click')
  await settle()
  const box = wrapper.find('textarea.multiline')
  expect(box.element.value).toBe(PEM)
  const pemRow = wrapper.findAll('.env-row').find(r => r.find('input.key').element.value === 'PRIVATE_KEY')
  expect(pemRow.find('input.value').exists()).toBe(false) // no single-line field that would strip the breaks

  await box.setValue(PEM.replace('AAAA', 'CCCC'))
  await button(wrapper, 'Save all').trigger('click')
  await settle()
  expect(stored.get('PRIVATE_KEY')).toBe(PEM.replace('AAAA', 'CCCC'))
  expect(stored.get('API_KEY')).toBe('secret')

  await button(wrapper, 'Hide values').trigger('click')
  await settle()
  expect(wrapper.find('input.value[disabled]').element.value).toBe('(multi-line value, 4 lines — reveal to see or edit)')
})

test('the text view shows the whole set, previews what a save does, and saves it', async () => {
  const wrapper = await editor()
  await button(wrapper, 'Edit as text').trigger('click')
  await settle()
  const text = wrapper.find('textarea.env-text')
  expect(text.element.value).toBe('API_KEY=secret\nPRIVATE_KEY="-----BEGIN KEY-----\\nAAAA\\nBBBB\\n-----END KEY-----"\n')
  expect(preview(wrapper)).toEqual(['No changes.'])

  await text.setValue('# keys for the shop\nAPI_KEY=rotated\nNEW_ONE="with spaces"\n')
  expect(preview(wrapper)).toEqual([
    'Comments are not saved (1) — only names and values are stored.',
    'New: NEW_ONE',
    'Changed: API_KEY',
    'Removed: PRIVATE_KEY',
  ])

  await button(wrapper, 'Save all').trigger('click')
  await settle()
  expect([...stored]).toEqual([['API_KEY', 'rotated'], ['NEW_ONE', 'with spaces']])
  expect(text.element.value).toBe('API_KEY=rotated\nNEW_ONE="with spaces"\n') // as stored: no comment
  expect(preview(wrapper)).toEqual(['No changes.'])
})

test('a bad line blocks both saving and going back to rows, and says where it is', async () => {
  const wrapper = await editor()
  await button(wrapper, 'Edit as text').trigger('click')
  await settle()
  await wrapper.find('textarea.env-text').setValue('API_KEY=secret\nnot a variable\n')
  expect(preview(wrapper)).toEqual(['Line 2 has no = — expected KEY=value.'])
  expect(button(wrapper, 'Save all').attributes('disabled')).toBeDefined()
  expect(button(wrapper, 'Back to rows').attributes('disabled')).toBeDefined()

  await wrapper.find('textarea.env-text').setValue('API_KEY=secret\nEXTRA="two\nlines"\n')
  await button(wrapper, 'Back to rows').trigger('click')
  await settle()
  expect(wrapper.findAll('.env-row input.key').map(i => i.element.value)).toEqual(['API_KEY', 'EXTRA'])
  expect(wrapper.find('textarea.multiline').element.value).toBe('two\nlines')
})

test('paste-merge adds and replaces without revealing the rest', async () => {
  const wrapper = await editor()
  await button(wrapper, 'Paste variables').trigger('click')
  const paste = wrapper.find('.env-paste textarea')
  await paste.setValue('export API_KEY=replaced\nDATABASE_URL=postgres://app@db/app # local\n')
  expect(preview(wrapper)).toEqual([
    'Comments are not saved (1) — only names and values are stored.',
    'New: DATABASE_URL',
    'Replaces the value of: API_KEY',
  ])
  await button(wrapper, 'Add to the list').trigger('click')
  await settle()
  expect(calls.some(c => c.includes('reveal=1'))).toBe(false) // nothing was shown or fetched in plaintext
  expect(wrapper.text()).toContain('1 added, 1 replaced — press Save all to store them.')

  await button(wrapper, 'Save all').trigger('click')
  await settle()
  expect(Object.fromEntries(stored)).toEqual({ API_KEY: 'replaced', DATABASE_URL: 'postgres://app@db/app', PRIVATE_KEY: PEM })
})
