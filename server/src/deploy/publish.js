import { join, dirname } from 'node:path'
import { lstatSync, readdirSync, mkdirSync, copyFileSync, renameSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

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

// A file whose name carries a content hash, under the directories bundlers
// put them in: Vite's /assets/index-BxQ3abc1.js, CRA's /static/js/main.3f2a1b9c.js.
// Its content can never change under that name, so the gate tells browsers
// to keep it for a year (proxy/index.js), and a publish keeps the previous
// build's ones for one more deploy (below). RE2 syntax — Caddy evaluates it
// too. A miss only costs caching; a non-hashed name under /assets/ that
// happens to end in 8+ word characters would be cached as immutable.
export const HASHED_ASSET_PATTERN = '^/(?:assets|static)/(?:[^/]+/)*[^/]*[.-][A-Za-z0-9_-]{8,}\\.[A-Za-z0-9]+$'
const HASHED_ASSET = new RegExp(HASHED_ASSET_PATTERN)
export const isHashedAsset = relPath => HASHED_ASSET.test(`/${relPath}`)

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
      throw new PublishError(`publish directory "${publishDir}" not found — did the build produce it?${candidatesHint(workDir)}`)
    }
    if (stat.isSymbolicLink()) throw new PublishError(`publish directory "${publishDir}" goes through a symlink — refusing to publish`)
    if (!stat.isDirectory()) throw new PublishError(`publish directory "${publishDir}" is not a directory`)
  }
  if (!existsSync(dir)) throw new PublishError('nothing to publish — the working directory does not exist')
  return dir
}

// Where a build seems to have put a site instead: directories with the usual
// names that hold an index.html, a few levels below the working directory
// (web/dist, client/dist…). Only a hint for the error message — what is
// published is always exactly the configured directory.
const SITE_DIR_NAMES = new Set(['dist', 'build', 'out', 'public', '_site'])

export function findPublishCandidates(workDir, { maxDepth = 3, limit = 5 } = {}) {
  const found = []
  let budget = 5000 // entries looked at — a monorepo must not stall the error
  const walk = (dir, rel, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit || --budget <= 0) return
      // lstat semantics: a symlinked directory is not walked into
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (SITE_DIR_NAMES.has(entry.name) && existsSync(join(full, 'index.html'))) found.push(relPath)
      else if (depth < maxDepth) walk(full, relPath, depth + 1)
    }
  }
  walk(workDir, '', 1)
  return found
}

function candidatesHint(workDir) {
  const found = existsSync(workDir) ? findPublishCandidates(workDir) : []
  return found.length ? ` Built sites found at: ${found.join(', ')} (relative to the working directory)` : ''
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

// Old hashed assets, kept for one more deploy. A page loaded before the
// deploy still holds the old index.html, and lazy-loads chunks by their old
// names; without them a click into a route not loaded yet is a 404. The
// files carried this time are listed next to the snapshot, so the deploy
// after drops them instead of carrying them forever. The previous snapshot
// is this code's own copy — regular files only — so nothing to follow.
const carriedList = target => `${target}.carried`

function readCarried(target) {
  try {
    return new Set(JSON.parse(readFileSync(carriedList(target), 'utf8')))
  } catch {
    return new Set()
  }
}

function carryHashedAssets(current, staging, alreadyCarried) {
  const carried = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      const src = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(src, relPath)
      } else if (entry.isFile() && isHashedAsset(relPath) && !alreadyCarried.has(relPath)) {
        const dst = join(staging, ...relPath.split('/'))
        if (existsSync(dst)) continue // the new build has it too
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
        carried.push(relPath)
      }
    }
  }
  if (existsSync(current)) walk(current, '')
  return carried
}

// Copies workDir/publishDir into `target`, replacing what was there in one
// swap. Returns { files, bytes, symlinks, hidden, carried, hasIndex }. On
// any failure the previously published site is left exactly as it was.
export function publishStatic({ workDir, publishDir, target }) {
  const root = resolvePublishRoot(workDir, publishDir)
  const staging = `${target}.next`
  const previous = `${target}.old`
  const tally = { files: 0, bytes: 0, symlinks: 0, hidden: 0 }
  let carried

  rmSync(staging, { recursive: true, force: true })
  try {
    copyTree(root, staging, tally)
    carried = carryHashedAssets(target, staging, readCarried(target))
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
  // Best-effort bookkeeping: without the list, the next publish would
  // carry these once more — one extra generation, nothing worse.
  try {
    if (carried.length) writeFileSync(carriedList(target), JSON.stringify(carried))
    else rmSync(carriedList(target), { force: true })
  } catch {
    // ignored
  }
  return { ...tally, carried: carried.length, hasIndex: existsSync(join(target, 'index.html')) }
}

// Removes a published snapshot (no longer a static site, and the gate no
// longer serves the app's files).
export function unpublishStatic(target) {
  for (const dir of [target, `${target}.next`, `${target}.old`, carriedList(target)]) rmSync(dir, { recursive: true, force: true })
}
