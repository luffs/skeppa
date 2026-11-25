import { test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackups, latestBackup } from '../src/lib/backups.js'
import { backupHours, backupKeep } from '../src/config.js'

// The panel's own backups: taken on a timer, pruned, and watched — a failure
// or a long silence is said once, and so is the end of it.

const HOUR = 3_600_000
const cleanups = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()()
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'skeppa-backups-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'skeppa.db')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
  db.close()
  const dir = join(root, 'backups')
  const said = []
  let clock = Date.parse('2026-11-20T03:00:00Z')
  const now = () => clock
  return { root, dbPath, dir, said, now, advance: ms => (clock += ms), notify: text => said.push(text) }
}

const quiet = { onError: () => {} }

test('the newest snapshot by name, whoever took it', () => {
  const s = setup()
  expect(latestBackup(s.dir)).toBeNull() // no directory yet
  mkdirSync(s.dir)
  writeFileSync(join(s.dir, 'skeppa-2026-11-01T03-00-00.db'), 'a')
  writeFileSync(join(s.dir, 'skeppa-2026-11-19T03-10-05.db'), 'abc')
  writeFileSync(join(s.dir, 'notes.txt'), 'not a snapshot')
  expect(latestBackup(s.dir)).toEqual({ at: '2026-11-19T03:10:05.000Z', bytes: 3, count: 2 })
})

test('a backup is taken, pruned to what is kept, and reported', async () => {
  const s = setup()
  const b = createBackups({ dbPath: s.dbPath, dir: s.dir, keep: 2, notify: s.notify, now: s.now, ...quiet })
  for (let i = 0; i < 3; i++) {
    await b.run()
    s.advance(24 * HOUR)
  }
  b.stop()
  expect(readdirSync(s.dir).sort()).toEqual(['skeppa-2026-11-21T03-00-00.db', 'skeppa-2026-11-22T03-00-00.db'])
  const info = b.info()
  expect(info).toMatchObject({ everyHours: 24, keep: 2, dir: s.dir, lastAt: '2026-11-22T03:00:00.000Z', count: 2, error: '', late: false })
  expect(info.bytes).toBeGreaterThan(0)
  expect(s.said).toEqual([])
  const copy = new Database(join(s.dir, 'skeppa-2026-11-22T03-00-00.db'), { readonly: true })
  expect(copy.query('SELECT x FROM t').get()).toEqual({ x: 1 })
  copy.close()
})

test('a failure is said once, and so is the next one that works', async () => {
  const s = setup()
  const b = createBackups({ dbPath: join(s.root, 'missing.db'), dir: s.dir, notify: s.notify, now: s.now, ...quiet })
  await b.run()
  await b.run()
  expect(s.said).toHaveLength(1)
  expect(s.said[0]).toContain('The database backup failed')
  expect(s.said[0]).toContain('the last good one is none')
  expect(b.info()).toMatchObject({ lastAt: '', count: 0 })
  expect(b.info().error).not.toBe('')
  expect(b.info()).not.toHaveProperty('bytes') // unknown is absent, never null

  // the database is back where it should be: the next one works, and says so
  copyFileSync(s.dbPath, join(s.root, 'missing.db'))
  await b.run()
  b.stop()
  expect(s.said.slice(1)).toEqual(['✔ Backups work again.'])
  expect(b.info()).toMatchObject({ error: '', errorAt: '', count: 1 })
})

test('late: none for twice the interval is said once — from boot when there never was one — and its end too', async () => {
  const s = setup()
  // the panel takes none here (a cron is meant to), and there is none
  const b = createBackups({ dbPath: s.dbPath, dir: s.dir, everyMs: 0, notify: s.notify, now: s.now, ...quiet })
  b.check()
  s.advance(47 * HOUR)
  b.check()
  expect(s.said).toEqual([])
  s.advance(2 * HOUR)
  b.check()
  b.check()
  expect(s.said).toHaveLength(1)
  expect(s.said[0]).toContain('no database backup at all')
  expect(s.said[0]).toContain('BACKUP_EVERY_HOURS=0')
  expect(b.info()).toMatchObject({ everyHours: 0, late: true })

  // the cron runs again: the newest in the directory is fresh
  await b.run()
  b.check()
  expect(s.said[1]).toContain('✔ Database backed up again')
  expect(b.info().late).toBe(false)

  // and with the timer on, twice its interval
  s.advance(13 * HOUR)
  const t = createBackups({ dbPath: s.dbPath, dir: s.dir, everyMs: 6 * HOUR, notify: s.notify, now: s.now, ...quiet })
  t.check()
  t.stop()
  expect(s.said[2]).toContain('No database backup for 13 hours')
})

test('the timer waits for what is due, a minute after boot at the soonest', async () => {
  const s = setup()
  const b = createBackups({ dbPath: s.dbPath, dir: s.dir, everyMs: 24 * HOUR, now: () => Date.now(), firstDelayMs: 30, notify: s.notify, ...quiet })
  b.start()
  await Bun.sleep(150)
  expect(readdirSync(s.dir)).toHaveLength(1) // none yet: due now, after the delay
  b.stop()
  const off = createBackups({ dbPath: s.dbPath, dir: join(s.root, 'off'), everyMs: 0, firstDelayMs: 1, notify: s.notify, ...quiet })
  off.start()
  await Bun.sleep(40)
  expect(latestBackup(join(s.root, 'off'))).toBeNull()
})

test('config: hours and how many to keep, warned back to the defaults when nonsense', () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    expect(backupHours(undefined)).toBe(24)
    expect(backupHours('0')).toBe(0)
    expect(backupHours('6')).toBe(6)
    expect(backupHours('daily')).toBe(24)
    expect(backupHours('-1')).toBe(24)
    expect(backupKeep(undefined)).toBe(14)
    expect(backupKeep('3')).toBe(3)
    expect(backupKeep('0')).toBe(14)
  } finally {
    console.warn = warn
  }
})
