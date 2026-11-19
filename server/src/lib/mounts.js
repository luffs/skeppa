import { realpathSync } from 'node:fs'
import { posix } from 'node:path'

// Host directories bind-mounted into a container app (`projects.mounts`) —
// a network share mounted on the host, say. A bind mount is a way out of the
// container onto the host, so the rules are tight and live on the server:
//
// - only an admin sets them (routes/projects.js); a tenant's project may
//   carry what an admin gave it, never change it, and a Crew move never
//   hands them to a tenant (lib/reassign.js);
// - a host path lies under one of the roots the panel's config names
//   (MOUNT_ROOTS) — nothing is mountable until the admin names one;
// - never at, around or under what the panel keeps to itself (its data,
//   the apps, its config directory and master key — `guarded`);
// - checked twice: as written when saved, and on the real paths (symlinks
//   resolved) each time the container is created, so a share that grew a
//   symlink, or a root that moved, cannot reach past them.
//
// One mount per line, `host:target`, `:ro` after it for read-only — the
// shape of `podman run -v`. Paths travel in the engine's JSON API, never a
// shell, and colons are not allowed in them (they split the engine's Binds).

export const MAX_MOUNTS = 10
// Letters, digits and . _ @ + - with single inner spaces ("Media Library").
const SEGMENT_RE = /^[A-Za-z0-9._@+-]+(?: [A-Za-z0-9._@+-]+)*$/
// Container paths an app needs for itself, or that are the panel's own
// mounts: never covered.
const TARGET_RESERVED = ['/app', '/proc', '/sys', '/dev']

export const isUnder = (path, dir) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)

// '/mnt/nas/' -> '/mnt/nas'; null for anything that is not a clean absolute path.
export function cleanPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  const segs = path.split('/').slice(1)
  if (segs.length && segs[segs.length - 1] === '') segs.pop()
  if (!segs.length) return '/'
  return segs.every(s => SEGMENT_RE.test(s) && s !== '.' && s !== '..') ? `/${segs.join('/')}` : null
}

// MOUNT_ROOTS from the config: absolute paths, separated by colons or commas.
// `/` is never a root — that would make the whole host mountable.
export function parseMountRoots(text) {
  const roots = []
  const ignored = []
  for (const raw of String(text ?? '').split(/[:,]/).map(s => s.trim()).filter(Boolean)) {
    const root = cleanPath(raw)
    if (!root || root === '/') ignored.push(raw)
    else if (!roots.includes(root)) roots.push(root)
  }
  return { roots, ignored }
}

// Text -> { mounts: [{ host, target, readOnly }], error }. Blank lines are skipped.
export function parseMounts(text) {
  if (text == null || text === '') return { mounts: [], error: '' }
  if (typeof text !== 'string') return { mounts: [], error: 'must be text, one mount per line' }
  const mounts = []
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length > MAX_MOUNTS) return { mounts: [], error: `at most ${MAX_MOUNTS} mounts` }
  for (const line of lines) {
    const parts = line.split(':')
    const mode = parts.length === 3 ? parts[2] : 'rw'
    if (parts.length < 2 || parts.length > 3 || !['ro', 'rw'].includes(mode)) {
      return { mounts: [], error: `"${line}": write it as /host/path:/container/path, with :ro after it for read-only` }
    }
    const host = cleanPath(parts[0])
    const target = cleanPath(parts[1])
    if (!host || host === '/') return { mounts: [], error: `"${parts[0]}": not a host path that can be mounted` }
    if (!target || target === '/') return { mounts: [], error: `"${parts[1]}": not a container path that can be mounted on` }
    if (target === '/data' || TARGET_RESERVED.some(dir => isUnder(target, dir))) {
      return { mounts: [], error: `${target} is the container's own — mount somewhere else, /data/<name> or /mnt/<name> for example` }
    }
    if (mounts.some(m => m.target === target)) return { mounts: [], error: `${target} is mounted twice` }
    mounts.push({ host, target, readOnly: mode === 'ro' })
  }
  return { mounts, error: '' }
}

// The stored form: one normalized line per mount.
export const formatMounts = mounts =>
  mounts.map(m => `${m.host}:${m.target}${m.readOnly ? ':ro' : ''}`).join('\n')

// Why a host path may not be mounted, or '' when it may.
export function hostPathProblem(host, { roots, guarded }) {
  if (!roots.length) return 'no host path is mountable until MOUNT_ROOTS is set in the panel config'
  if (!roots.some(root => isUnder(host, root))) return `${host} is not under ${roots.join(' or ')} (MOUNT_ROOTS)`
  const kept = guarded.find(dir => isUnder(host, dir) || isUnder(dir, host))
  if (kept) return `${host} reaches ${kept}, which the panel keeps to itself`
  return ''
}

// The first problem with saved mount text, or ''.
export function mountsProblem(text, scope) {
  const { mounts, error } = parseMounts(text)
  if (error) return error
  for (const m of mounts) {
    const problem = hostPathProblem(m.host, scope)
    if (problem) return problem
  }
  return ''
}

// The engine's Binds for a project's mounts, checked again on the real paths
// right before the container is created. Throws with the reason a mount
// cannot be made — the create is refused rather than made without it.
// `realpath` is for the tests.
export function mountBinds(config, project, { realpath = realpathSync } = {}) {
  const { mounts, error } = parseMounts(project.mounts ?? '')
  if (error) throw new Error(`mounts: ${error}`)
  if (!mounts.length) return []
  const real = path => {
    try {
      return realpath(path)
    } catch {
      return path
    }
  }
  const scope = {
    roots: (config.mountRoots ?? []).map(real),
    guarded: (config.mountGuarded ?? []).map(real),
  }
  return mounts.map(m => {
    let host
    try {
      host = realpath(m.host)
    } catch {
      throw new Error(`mount ${m.host} is not there — is the share mounted on the host?`)
    }
    const problem = hostPathProblem(host, scope)
    if (problem) throw new Error(`mount ${m.host}${host !== m.host ? ` (really ${host})` : ''}: ${problem}`)
    return `${host}:${posix.normalize(m.target)}${m.readOnly ? ':ro' : ''}`
  })
}
