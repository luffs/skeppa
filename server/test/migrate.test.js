import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'

function tempMigrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-mig-'))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

test('applies migrations in order and records them', () => {
  const dir = tempMigrations({
    '001_users.sql': 'CREATE TABLE t1 (id INTEGER PRIMARY KEY);',
    '002_more.sql': 'ALTER TABLE t1 ADD COLUMN name TEXT;',
    'notes.txt': 'should be ignored',
  })
  const db = new Database(':memory:')
  const ran = migrate(db, dir)
  expect(ran).toEqual(['001_users.sql', '002_more.sql'])
  db.query('INSERT INTO t1 (id, name) VALUES (1, ?)').run('a')
  expect(db.query('SELECT name FROM migrations ORDER BY id').all().map(r => r.name))
    .toEqual(['001_users.sql', '002_more.sql'])
})

test('is idempotent and picks up only new files', () => {
  const files = { '001_a.sql': 'CREATE TABLE a (id INTEGER);' }
  const dir = tempMigrations(files)
  const db = new Database(':memory:')
  expect(migrate(db, dir)).toEqual(['001_a.sql'])
  expect(migrate(db, dir)).toEqual([])
  writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (id INTEGER);')
  expect(migrate(db, dir)).toEqual(['002_b.sql'])
})

test('a failing migration rolls back and is not recorded', () => {
  const dir = tempMigrations({
    '001_ok.sql': 'CREATE TABLE ok (id INTEGER);',
    '002_bad.sql': 'CREATE TABLE bad (id INTEGER); THIS IS NOT SQL;',
  })
  const db = new Database(':memory:')
  expect(() => migrate(db, dir)).toThrow()
  expect(db.query('SELECT name FROM migrations').all().map(r => r.name)).toEqual(['001_ok.sql'])
  // the partial CREATE from 002 must have been rolled back
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='bad'").get()).toBeNull()
})

test('the real schema applies cleanly', () => {
  const db = new Database(':memory:')
  const real = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
  const ran = migrate(db, real)
  expect(ran.length).toBeGreaterThan(0)
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  for (const t of ['users', 'sessions', 'settings', 'projects', 'env_vars', 'deployments']) {
    expect(tables).toContain(t)
  }
})
