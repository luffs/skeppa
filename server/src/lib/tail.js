// Reads the end of a (potentially huge) log file without loading all of it:
// only the final `maxBytes` are decoded, then the last `lines` lines returned.
const MAX_BYTES = 256 * 1024

export async function tailFile(path, { lines = 200, maxBytes = MAX_BYTES } = {}) {
  const file = Bun.file(path)
  if (!(await file.exists())) return { text: '', truncated: false, missing: true }

  const from = Math.max(0, file.size - maxBytes)
  const raw = await file.slice(from).text()
  const all = raw.replace(/\n+$/, '').split('\n')
  // Slicing mid-file lands inside a line — drop that partial first one.
  if (from > 0) all.shift()
  const tail = all.slice(-lines)
  return { text: tail.join('\n'), truncated: from > 0 || tail.length < all.length, missing: false }
}
