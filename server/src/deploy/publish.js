import { join } from 'node:path'
import { lstatSync, readdirSync, mkdirSync, copyFileSync, renameSync, rmSync, existsSync } from 'node:fs'

// Publishing a static site: after a successful build, the publish directory is
// copied into a panel-owned snapshot (APPS_DIR/<slug>/public) and the harbor
// gate serves that — never the working tree. Three reasons, the first a
// security boundary:
//
// - Symlinks. Caddy's file server follows them, and the working tree is
//   whatever the repo and its build put there: a link from dist/ to the master
//   key or another tenant's checkout would be served over HTTPS. The snapshot
//   holds only regular files and directories this code created, so there is
//   nothing to follow.
// - Half-built sites. Most builds empty their output first; serving it live
//   would break the site for the length of every deploy, and leave it broken
//   after a failed one. The snapshot is swapped in whole, after the build.
// - Hidden files. A publish directory of '.' would otherwise serve .git and
//   any .env. Dot-entries stay out, except .well-known (ACME, security.txt).

export class PublishError extends Error {}

const KEEP_DOT = new Set(['.well-known'])

// Every segment from the working directory down to the publish directory must
// be a real directory: a symlinked `dist` (or a symlinked parent of it) would
// make the copy read from wherever it points.
function resolvePublishRoot(workDir, publishDir) {
  let dir = workDir
  for (const segment of (publishDir || '').split('/').filter(s => s && s !== '.')) {
    dir = join(dir, segment)
    let stat
    try {
      stat = lstatSync(dir)
    } catch {
      throw new PublishError(`publish directory "${publishDir}" not found — did the build produce it?`)
    }
    if (stat.isSymbolicLink()) throw new PublishError(`publish directory "${publishDir}" goes through a symlink — refusing to publish`)
    if (!stat.isDirectory()) throw new PublishError(`publish directory "${publishDir}" is not a directory`)
  }
  if (!existsSync(dir)) throw new PublishError('nothing to publish — the working directory does not exist')
  return dir
}

function copyTree(from, to, tally) {
  mkdirSync(to, { recursive: true })
  // withFileTypes reports the entry itself (lstat semantics): a symlink is a
  // symlink here, whatever it points at.
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && !KEEP_DOT.has(entry.name)) {
      tally.hidden++
      continue
    }
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isSymbolicLink()) {
      tally.symlinks++
    } else if (entry.isDirectory()) {
      copyTree(src, dst, tally)
    } else if (entry.isFile()) {
      copyFileSync(src, dst)
      tally.files++
      tally.bytes += lstatSync(dst).size
    }
    // sockets, fifos, devices: not part of a website
  }
}

// Copies workDir/publishDir into `target`, replacing what was there in one
// swap. Returns { files, bytes, symlinks, hidden, hasIndex }. On any failure
// the previously published site is left exactly as it was.
export function publishStatic({ workDir, publishDir, target }) {
  const root = resolvePublishRoot(workDir, publishDir)
  const staging = `${target}.next`
  const previous = `${target}.old`
  const tally = { files: 0, bytes: 0, symlinks: 0, hidden: 0 }

  rmSync(staging, { recursive: true, force: true })
  try {
    copyTree(root, staging, tally)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err instanceof PublishError ? err : new PublishError(`could not copy the site: ${err.message}`)
  }

  // Swap: the old snapshot steps aside, the new one takes its name. If the
  // second rename fails the old one is put back.
  rmSync(previous, { recursive: true, force: true })
  const hadPrevious = existsSync(target)
  if (hadPrevious) renameSync(target, previous)
  try {
    renameSync(staging, target)
  } catch (err) {
    if (hadPrevious) renameSync(previous, target)
    rmSync(staging, { recursive: true, force: true })
    throw new PublishError(`could not swap the new site in: ${err.message}`)
  }
  rmSync(previous, { recursive: true, force: true })
  return { ...tally, hasIndex: existsSync(join(target, 'index.html')) }
}

// Removes a published snapshot (runtime switched away from static).
export function unpublishStatic(target) {
  for (const dir of [target, `${target}.next`, `${target}.old`]) rmSync(dir, { recursive: true, force: true })
}
