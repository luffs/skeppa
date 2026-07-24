import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tailFile } from '../src/lib/tail.js'

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-tail-'))
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

test('returns the last N lines and flags truncation', async () => {
  const path = tmpFile('out.log', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  const { text, truncated, missing } = await tailFile(path, { lines: 3 })
  expect(text).toBe('line 48\nline 49\nline 50')
  expect(truncated).toBe(true)
  expect(missing).toBe(false)
})

test('returns the whole file untruncated when it is shorter than the limit', async () => {
  const path = tmpFile('out.log', 'only\ntwo\n')
  const { text, truncated } = await tailFile(path, { lines: 100 })
  expect(text).toBe('only\ntwo')
  expect(truncated).toBe(false)
})

test('drops the partial first line when reading past the byte cap', async () => {
  const path = tmpFile('out.log', 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n')
  // A 16-byte window lands mid-way through the "bbb" line.
  const { text, truncated } = await tailFile(path, { lines: 100, maxBytes: 16 })
  expect(text).toBe('cccccccccc')
  expect(truncated).toBe(true)
})

test('reports a missing file instead of throwing', async () => {
  const { text, missing } = await tailFile(join(tmpdir(), 'skeppa-does-not-exist.log'), { lines: 10 })
  expect(missing).toBe(true)
  expect(text).toBe('')
})

test('handles an empty file', async () => {
  const { text, truncated, missing } = await tailFile(tmpFile('empty.log', ''), { lines: 10 })
  expect(text).toBe('')
  expect(truncated).toBe(false)
  expect(missing).toBe(false)
})
