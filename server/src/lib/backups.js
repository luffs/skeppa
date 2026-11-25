import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { backupDatabase, pruneBackups } from '../db/backup.js'

// This panel's database backups, taken by the panel itself: a snapshot every
// BACKUP_EVERY_HOURS (default 24; 0 = off, for a cron of scripts/backup.js
// instead) into BACKUP_DIR (default DATA_DIR/backups), pruned to BACKUP_KEEP.
// Whoever takes them, the snapshots carry the same names, so the newest one
// in the directory is the last backup — the panel's own or a cron's.
//
// And watched, the way the disk is (lib/diskwatch.js): a backup that fails
// is the `backup` notification, once until one works again; so is having
// none newer than twice the interval (two days with the timer off), counted
// from this boot when there has never been one. Each comes with a word when
// it is over. Every panel watches its own; an agent's goes through its
// master like the rest.

const NAME = /^skeppa-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.db$/
const HOUR = 3_600_000
const FIRST_DELAY_MS = 60_000 // after boot, before a backup that is due
const RETRY_MS = HOUR // after a failed one

// The newest snapshot in `dir`: { at (ISO), bytes, count }, or null.
export function latestBackup(dir) {
  let names
  try {
    names = readdirSync(dir).filter(n => NAME.test(n)).sort()
  } catch {
    return null
  }
  if (!names.length) return null
  const newest = names[names.length - 1]
  const [, day, h, m, s] = NAME.exec(newest)
  let bytes
  try {
    bytes = statSync(join(dir, newest)).size
  } catch {
    bytes = undefined
  }
  return { at: new Date(`${day}T${h}:${m}:${s}Z`).toISOString(), bytes, count: names.length }
}

const ago = ms => (ms >= 2 * 86_400_000 ? `${Math.round(ms / 86_400_000)} days` : `${Math.round(ms / HOUR)} hours`)

export function createBackups({
  dbPath,
  dir,
  everyMs = 24 * HOUR,
  keep = 14,
  notify = () => {},
  now = () => Date.now(),
  bootAt = now(),
  firstDelayMs = FIRST_DELAY_MS,
  onError = err => console.error('[backup]', err?.message ?? err),
}) {
  const staleMs = everyMs > 0 ? 2 * everyMs : 48 * HOUR
  let last = latestBackup(dir)
  let error = ''
  let errorAt = ''
  let failedAlerted = false
  let staleAlerted = false
  let timer = null
  let running = false

  function schedule(ms) {
    clearTimeout(timer)
    timer = null
    if (everyMs <= 0) return
    const due = last ? Date.parse(last.at) + everyMs : now()
    const wait = ms ?? Math.max(firstDelayMs, due - now())
    timer = setTimeout(run, wait)
    timer.unref?.()
  }

  async function run() {
    if (running) return null
    running = true
    try {
      backupDatabase(dbPath, dir, new Date(now()))
      pruneBackups(dir, keep)
      last = latestBackup(dir)
      error = ''
      errorAt = ''
      if (failedAlerted) {
        failedAlerted = false
        notify('✔ Backups work again.')
      }
      check()
      schedule()
      return last
    } catch (err) {
      error = err.message ?? String(err)
      errorAt = new Date(now()).toISOString()
      onError(err)
      if (!failedAlerted) {
        failedAlerted = true
        notify(`⚠ The database backup failed: ${error}. Trying again in an hour; the last good one is ${last ? `from ${last.at.replace('T', ' ').slice(0, 16)} UTC` : 'none'}.`)
      }
      schedule(Math.min(RETRY_MS, everyMs))
      return null
    } finally {
      running = false
    }
  }

  // Once a minute or so: is the newest backup (whoever took it) recent?
  function check() {
    // A cron may have written one since, or someone cleared them: read again.
    last = latestBackup(dir)
    const fresh = last
    const since = fresh ? Date.parse(fresh.at) : bootAt
    const age = now() - since
    if (!staleAlerted && age > staleMs) {
      staleAlerted = true
      notify(fresh
        ? `⚠ No database backup for ${ago(age)} — the last is from ${fresh.at.replace('T', ' ').slice(0, 16)} UTC.${everyMs > 0 ? '' : ' Backups are not taken by the panel here (BACKUP_EVERY_HOURS=0): is the cron still running?'}`
        : `⚠ This server has no database backup at all.${everyMs > 0 ? '' : ' Backups are not taken by the panel here (BACKUP_EVERY_HOURS=0) — set it, or run scripts/backup.js from cron.'}`)
    } else if (staleAlerted && age <= staleMs) {
      staleAlerted = false
      notify(`✔ Database backed up again (${fresh.at.replace('T', ' ').slice(0, 16)} UTC).`)
    }
    return age
  }

  return {
    start() {
      schedule()
    },
    stop() {
      clearTimeout(timer)
      timer = null
    },
    run,
    check,
    // For the system record: '' and absent keys, never null (LiveState).
    info() {
      const info = {
        everyHours: everyMs > 0 ? Math.round((everyMs / HOUR) * 100) / 100 : 0,
        keep,
        dir,
        lastAt: last?.at ?? '',
        count: last?.count ?? 0,
        error,
        errorAt,
        late: staleAlerted,
      }
      if (Number.isFinite(last?.bytes)) info.bytes = last.bytes
      return info
    },
  }
}
