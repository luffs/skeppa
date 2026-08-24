import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
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

// Bun.Archive (Bun 1.4+) is libarchive — a tar implementation we did not
// write. Reading our bytes back with it is what proves they are a real
// archive rather than merely self-consistent. This replaces a test that
// shelled out to the system tar, which had to be installed to run at all
// and could not be handed a Windows temp path.
test('round-trips through an independent tar reader', async () => {
  const archive = new Bun.Archive(tarArchive([{ name: 'Containerfile', content: CONTENT }]))
  const files = await archive.files()
  expect([...files.keys()]).toEqual(['Containerfile'])
  expect(files.get('Containerfile').size).toBe(CONTENT.length)
  expect(await files.get('Containerfile').text()).toBe(CONTENT)
})

// The block arithmetic that concatenates entries only runs when there is more
// than one, and images.js sends a single Containerfile today — so nothing else
// would notice if a second entry started at the wrong offset.
test('round-trips a multi-entry context', async () => {
  const second = 'exec "$@"'
  const archive = new Bun.Archive(tarArchive([
    { name: 'Containerfile', content: CONTENT },
    { name: 'entrypoint.sh', content: second },
  ]))
  const files = await archive.files()
  expect([...files.keys()]).toEqual(['Containerfile', 'entrypoint.sh'])
  expect(await files.get('Containerfile').text()).toBe(CONTENT)
  expect(await files.get('entrypoint.sh').text()).toBe(second)
})

test('extracts to disk as a regular readable file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-tar-'))
  const archive = new Bun.Archive(tarArchive([{ name: 'Containerfile', content: CONTENT }]))
  expect(await archive.extract(dir)).toBe(1)
  expect(readFileSync(join(dir, 'Containerfile'), 'utf8')).toBe(CONTENT)
})
