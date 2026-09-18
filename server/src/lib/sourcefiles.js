import { open, realpath, readlink, readdir, stat, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, sep, basename } from 'node:path'

// Read-only access to a project's source/ checkout for the file viewer. The
// tree is NOT trusted: a tenant's repo (and their deploy script, which has
// source/ mounted writable) decides what is in it, and a symlink named
// README.md may point at the panel's master key. So nothing is served by the
// path that was asked for — only by where that path really leads:
//   - the requested path is whitelist-parsed into segments (no '..', no '\'),
//   - it is resolved with realpath and must land inside the real source root,
//   - a file is then opened, and on Linux the OPEN descriptor is asked where
//     it points (/proc/self/fd) and checked again, so swapping a directory for
//     a symlink between the check and the open gains nothing; everything
//     after that reads from the descriptor, never from the path again. That
//     is also why this is node:fs FileHandles rather than Bun.file(path):
//     a path-based read would walk the (possibly swapped) path a second time.
// Two things inside the tree stay out of reach: `.git` (noise, and none of
// the viewer's business) and a file named exactly `.env` — with
// write_env_file on, that is the panel's own plaintext copy of the Manifest, and
// the API only ever shows those values behind an explicit reveal.

export const TEXT_MAX = 512 * 1024 // larger files are download-only
const SNIFF_BYTES = 8 * 1024
const MAX_ENTRIES = 2000
const PATH_MAX = 1024

export class SourceFileError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const notFound = () => new SourceFileError(404, 'no such file')

// '' (the root) or 'a/b/c' → segments. Anything else is refused outright.
export function parseRelPath(input) {
  if (input == null || input === '') return []
  if (typeof input !== 'string' || input.length > PATH_MAX || input.includes('\0') || input.includes('\\')) {
    throw new SourceFileError(400, 'invalid path')
  }
  const segments = input.split('/').filter(Boolean)
  if (segments.some(s => s === '.' || s === '..')) throw new SourceFileError(400, 'invalid path')
  return segments
}

const isLocked = name => name === '.env'

// The segments of `real` below `realRoot`, or a throw when it is outside the
// root or somewhere the viewer does not go.
function segmentsInside(realRoot, real) {
  if (real === realRoot) return []
  if (!real.startsWith(realRoot + sep)) throw notFound()
  const segments = real.slice(realRoot.length + 1).split(sep)
  if (segments.includes('.git')) throw notFound()
  return segments
}

function fsError(err) {
  if (err instanceof SourceFileError) return err
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'ELOOP') return notFound()
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new SourceFileError(403, 'the panel user cannot read this')
  return err
}

async function resolveInside(root, relPath) {
  const requested = parseRelPath(relPath)
  let realRoot
  try {
    realRoot = await realpath(root)
  } catch {
    return null // nothing deployed yet
  }
  const real = await realpath(join(realRoot, ...requested))
  const segments = segmentsInside(realRoot, real)
  return { realRoot, real, segments, path: segments.join('/') }
}

async function listDirectory({ realRoot, real, path }) {
  const dirents = await readdir(real, { withFileTypes: true })
  const entries = []
  let truncated = false
  for (const d of dirents) {
    if (d.name === '.git') continue
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const full = join(real, d.name)
    let type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
    let size = null
    try {
      if (d.isSymbolicLink()) {
        // Shown as what it leads to — if that is somewhere the viewer goes.
        const target = await realpath(full)
        segmentsInside(realRoot, target)
        const s = await stat(target)
        type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'
        if (type === 'file') size = s.size
      } else if (type === 'file') {
        size = (await lstat(full)).size
      }
    } catch {
      type = 'other' // dangling, outside the tree, unreadable
    }
    entries.push({ name: d.name, type, size, ...(isLocked(d.name) ? { locked: true } : {}) })
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir')
    ? a.name.localeCompare(b.name)
    : a.type === 'dir' ? -1 : 1)
  return { type: 'dir', path, entries, truncated }
}

// An open descriptor on a regular file inside the root, or a throw. The
// caller owns the handle and must close it.
async function openInside({ realRoot, real }) {
  const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    let actual = real
    if (process.platform === 'linux') actual = await readlink(`/proc/self/fd/${handle.fd}`)
    const segments = segmentsInside(realRoot, actual)
    const name = segments.at(-1) ?? basename(actual)
    if (isLocked(name)) {
      throw new SourceFileError(403, 'this .env is the panel’s plaintext copy of the Manifest — read and reveal the values there')
    }
    const info = await handle.stat()
    if (!info.isFile()) throw new SourceFileError(400, 'not a regular file')
    return { handle, size: info.size, name, path: segments.join('/') }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

async function readFully(handle, length) {
  const buf = new Uint8Array(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await handle.read(buf, got, length - got, got)
    if (!bytesRead) break
    got += bytesRead
  }
  return buf.subarray(0, got)
}

// Text is what decodes as UTF-8 and carries no NUL. `complete` is false when
// only the head of a large file was read — a multi-byte character cut in two
// at the end must not make it look binary.
export function looksBinary(bytes, complete = true) {
  if (bytes.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete })
    return false
  } catch {
    return true
  }
}

// What is at `relPath` under `root`:
//   { type: 'missing' }                              — no checkout yet
//   { type: 'dir', path, entries, truncated }
//   { type: 'file', path, name, size, binary, tooLarge, text }
// `path` in the answer is the real one, so a symlinked README reports (and
// resolves its relative links from) where it actually lives.
export async function readSourcePath(root, relPath) {
  try {
    const at = await resolveInside(root, relPath)
    if (!at) return { type: 'missing' }
    if ((await stat(at.real)).isDirectory()) {
      const listing = await listDirectory(at)
      // Check–use–check: a directory cannot be pinned by descriptor here, so
      // make sure the path still leads where it did before trusting the names.
      if ((await realpath(join(at.realRoot, ...parseRelPath(relPath)))) !== at.real) throw notFound()
      return listing
    }
    const file = await openInside(at)
    try {
      const tooLarge = file.size > TEXT_MAX
      const bytes = await readFully(file.handle, tooLarge ? SNIFF_BYTES : file.size)
      const binary = looksBinary(bytes, !tooLarge)
      return {
        type: 'file',
        path: file.path,
        name: file.name,
        size: file.size,
        binary,
        tooLarge,
        text: binary || tooLarge ? '' : new TextDecoder().decode(bytes),
      }
    } finally {
      await file.handle.close().catch(() => {})
    }
  } catch (err) {
    throw fsError(err)
  }
}

// The file as a byte stream for download: { name, size, stream }. The stream
// reads from the verified descriptor and closes it when done or cancelled.
export async function openSourceDownload(root, relPath) {
  try {
    const at = await resolveInside(root, relPath)
    if (!at) throw notFound()
    const { handle, size, name } = await openInside(at)
    let position = 0
    const stream = new ReadableStream({
      async pull(controller) {
        // Never past the size promised in Content-Length, even if it grew.
        const want = Math.min(64 * 1024, size - position)
        const chunk = new Uint8Array(want)
        const { bytesRead } = want > 0 ? await handle.read(chunk, 0, want, position) : { bytesRead: 0 }
        if (!bytesRead) {
          await handle.close().catch(() => {})
          controller.close()
          return
        }
        position += bytesRead
        controller.enqueue(chunk.subarray(0, bytesRead))
      },
      async cancel() {
        await handle.close().catch(() => {})
      },
    })
    return { name, size, stream }
  } catch (err) {
    throw fsError(err)
  }
}
