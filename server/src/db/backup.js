import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs'

// One consistent snapshot of the live database via VACUUM INTO — safe while
// the panel is running, and the copy arrives compacted. The master key is
// deliberately NOT part of a backup: the whole point of the key file is that
// no database copy can decrypt anything on its own.
export function backupDatabase(dbPath, destDir, now = new Date()) {
  mkdirSync(destDir, { recursive: true })
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const dest = join(destDir, `skeppa-${stamp}.db`)
  const db = new Database(dbPath, { readonly: true })
  try {
    db.query('VACUUM INTO ?').run(dest)
  } finally {
    db.close()
  }
  try {
    chmodSync(dest, 0o600)
  } catch { /* not a thing on Windows */ }
  return dest
}

// Timestamped names sort lexically, so pruning is a sort and a slice.
// Returns the file names it removed.
export function pruneBackups(destDir, keep) {
  // A zero would slice from the front and delete every snapshot there is.
  if (!keep) return []
  const stale = readdirSync(destDir)
    .filter(f => /^skeppa-\d{4}-\d{2}-\d{2}T.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep)
  for (const f of stale) rmSync(join(destDir, f))
  return stale
}
