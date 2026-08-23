import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, pruneBackups } from '../src/db/backup.js'

function sourceDb(dir) {
  const path = join(dir, 'skeppa.db')
  const db = new Database(path)
  db.query('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)').run()
  db.query("INSERT INTO things (name) VALUES ('anchor')").run()
  db.close()
  return path
}

test('backup is a working snapshot with a timestamped name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-backup-'))
  const src = sourceDb(dir)
  const dest = backupDatabase(src, join(dir, 'backups'), new Date('2026-01-02T03:04:05Z'))
  expect(dest.endsWith('skeppa-2026-01-02T03-04-05.db')).toBe(true)

  const copy = new Database(dest, { readonly: true })
  expect(copy.query('SELECT name FROM things').get().name).toBe('anchor')
  copy.close()
})

test('a backup can be taken while the panel holds the database open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-backup-live-'))
  const src = sourceDb(dir)
  const live = new Database(src) // the running panel
  const dest = backupDatabase(src, join(dir, 'backups'))
  const copy = new Database(dest, { readonly: true })
  expect(copy.query('SELECT COUNT(*) AS n FROM things').get().n).toBe(1)
  copy.close()
  live.close()
})

test('pruning keeps the newest N snapshots and ignores strangers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-backup-prune-'))
  for (const stamp of ['2026-01-01T00-00-00', '2026-01-02T00-00-00', '2026-01-03T00-00-00']) {
    writeFileSync(join(dir, `skeppa-${stamp}.db`), '')
  }
  writeFileSync(join(dir, 'notes.txt'), 'keep me')

  const pruned = pruneBackups(dir, 2)
  expect(pruned).toEqual(['skeppa-2026-01-01T00-00-00.db'])
  expect(readdirSync(dir).sort()).toEqual([
    'notes.txt',
    'skeppa-2026-01-02T00-00-00.db',
    'skeppa-2026-01-03T00-00-00.db',
  ])
})
