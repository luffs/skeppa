import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Simple homemade migration runner: numbered .sql files applied in order,
// each recorded in a `migrations` table so it only ever runs once.
export function migrate(db, migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(db.query('SELECT name FROM migrations').all().map(r => r.name))
  const files = readdirSync(migrationsDir).filter(f => /^\d+.*\.sql$/.test(f)).sort()
  const ran = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const apply = db.transaction(() => {
      db.exec(sql)
      db.query('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString())
    })
    apply()
    ran.push(file)
  }
  return ran
}
