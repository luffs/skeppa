// Snapshots the panel database. Safe to run while the panel is up.
// Usage: bun scripts/backup.js [dest-dir] [--keep N]
//   dest-dir  where snapshots land (default: DATA_DIR/backups)
//   --keep N  prune to the N newest snapshots in dest-dir (default 14; 0 = keep all)
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { loadConfig } from '../server/src/config.js'
import { backupDatabase, pruneBackups } from '../server/src/db/backup.js'

function fail(msg) {
  console.error(msg)
  console.error('usage: bun scripts/backup.js [dest-dir] [--keep N]')
  process.exit(1)
}

// Unrecognized arguments are refused rather than absorbed: silently reading
// `--keep=7` as a destination directory would write the snapshot to a folder
// of that name and quietly go on keeping 14.
const args = process.argv.slice(2)
let keep = 14
let destDir = null
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--keep') keep = parseInt(args[++i], 10)
  else if (arg.startsWith('--keep=')) keep = parseInt(arg.slice('--keep='.length), 10)
  else if (arg.startsWith('-')) fail(`unknown option: ${arg}`)
  else if (destDir === null) destDir = arg
  else fail(`unexpected extra argument: ${arg}`)
}
if (!Number.isInteger(keep) || keep < 0) fail('--keep needs a non-negative integer')

// Reading the database needs no master key — and a backup cron should not
// fail just because the key is somewhere this shell cannot see.
const config = loadConfig({ requireMasterKey: false })
const dir = destDir ?? join(config.dataDir, 'backups')

let dest
try {
  dest = backupDatabase(join(config.dataDir, 'skeppa.db'), dir)
} catch (err) {
  fail(`backup failed: ${err.message}`)
}
console.log(`backup written: ${dest} (${Math.round(statSync(dest).size / 1024)} kB)`)

// The snapshot is on disk by now. A prune that throws — an old file held open,
// permissions changed underneath it — must not make a cron wrapper report the
// backup itself as failed, so it warns and leaves the exit code alone.
if (keep > 0) {
  try {
    const pruned = pruneBackups(dir, keep)
    if (pruned.length) console.log(`pruned ${pruned.length} older snapshot(s), keeping ${keep}`)
  } catch (err) {
    console.error(`warning: could not prune old snapshots: ${err.message}`)
  }
}

console.log('')
console.log('note: ENV values inside are AES-encrypted — restoring also needs the master key,')
console.log(`      which is never part of a backup. Key file: ${process.env.MASTER_KEY_FILE ?? '(MASTER_KEY env — dev only)'}`)
console.log('      Copy it somewhere separate from the database snapshots.')
