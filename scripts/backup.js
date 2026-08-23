// Snapshots the panel database. Safe to run while the panel is up.
// Usage: bun scripts/backup.js [dest-dir] [--keep N]
//   dest-dir  where snapshots land (default: DATA_DIR/backups)
//   --keep N  prune to the N newest snapshots in dest-dir (default 14; 0 = keep all)
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { loadConfig } from '../server/src/config.js'
import { backupDatabase, pruneBackups } from '../server/src/db/backup.js'

const args = process.argv.slice(2)
let keep = 14
let destDir = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep') keep = parseInt(args[++i], 10)
  else destDir = args[i]
}
if (!Number.isInteger(keep) || keep < 0) {
  console.error('--keep needs a non-negative integer')
  process.exit(1)
}

// Reading the database needs no master key — and a backup cron should not
// fail just because the key is somewhere this shell cannot see.
const config = loadConfig({ requireMasterKey: false })
const dir = destDir ?? join(config.dataDir, 'backups')

const dest = backupDatabase(join(config.dataDir, 'skeppa.db'), dir)
console.log(`backup written: ${dest} (${Math.round(statSync(dest).size / 1024)} kB)`)

if (keep > 0) {
  const pruned = pruneBackups(dir, keep)
  if (pruned.length) console.log(`pruned ${pruned.length} older snapshot(s), keeping ${keep}`)
}

console.log('')
console.log('note: ENV values inside are AES-encrypted — restoring also needs the master key,')
console.log(`      which is never part of a backup. Key file: ${process.env.MASTER_KEY_FILE ?? '(MASTER_KEY env — dev only)'}`)
console.log('      Copy it somewhere separate from the database snapshots.')
