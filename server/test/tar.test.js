import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tarArchive } from '../src/lib/tar.js'

const CONTENT = 'FROM docker.io/oven/bun:1\nRUN echo hej\n'

test('produces a structurally valid ustar archive', () => {
  const archive = tarArchive([{ name: 'Containerfile', content: CONTENT }])
  const dec = new TextDecoder()

  // one header block + one padded content block + two terminator blocks
  expect(archive.length % 512).toBe(0)
  expect(archive.length).toBe(512 + 512 + 1024)

  expect(dec.decode(archive.subarray(0, 13))).toBe('Containerfile')
  expect(dec.decode(archive.subarray(257, 262))).toBe('ustar')
  expect(parseInt(dec.decode(archive.subarray(124, 135)), 8)).toBe(CONTENT.length)
  expect(dec.decode(archive.subarray(512, 512 + CONTENT.length))).toBe(CONTENT)

  // checksum: sum of header bytes with the checksum field read as spaces
  const header = archive.slice(0, 512)
  const stored = parseInt(dec.decode(header.subarray(148, 154)), 8)
  header.fill(32, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  expect(stored).toBe(sum)

  // archive ends with two zero blocks
  expect(archive.subarray(1024).every(b => b === 0)).toBe(true)
})

test('rejects names longer than the ustar limit', () => {
  expect(() => tarArchive([{ name: 'x'.repeat(101), content: '' }])).toThrow(/too long/)
})

test.if(!!Bun.which('tar'))('round-trips through the system tar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-tar-'))
  const archivePath = join(dir, 'ctx.tar')
  writeFileSync(archivePath, tarArchive([{ name: 'Containerfile', content: CONTENT }]))

  const proc = Bun.spawn([Bun.which('tar'), '-xf', archivePath, '-C', dir], { stderr: 'pipe' })
  expect(await proc.exited).toBe(0)
  expect(readFileSync(join(dir, 'Containerfile'), 'utf8')).toBe(CONTENT)
})
