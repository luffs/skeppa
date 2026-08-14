// Minimal ustar writer — just enough to hand the container engine an
// in-memory build context (a Containerfile, no directories, no deps).
// Deterministic output: fixed mode, mtime 0.
const BLOCK = 512

const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0'

export function tarArchive(files) {
  const enc = new TextEncoder()
  const parts = []

  for (const { name, content } of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content
    if (enc.encode(name).length > 100) throw new Error(`tar entry name too long: ${name}`)

    const header = new Uint8Array(BLOCK)
    const put = (str, offset) => header.set(enc.encode(str), offset)
    put(name, 0) //                      name (100)
    put(octal(0o644, 8), 100) //         mode
    put(octal(0, 8), 108) //             uid
    put(octal(0, 8), 116) //             gid
    put(octal(data.length, 12), 124) //  size
    put(octal(0, 12), 136) //            mtime
    put('        ', 148) //              checksum counts as spaces first
    put('0', 156) //                     typeflag: regular file
    put('ustar\0', 257) //               magic
    put('00', 263) //                    version
    let sum = 0
    for (const byte of header) sum += byte
    put(octal(sum, 7) + ' ', 148) //     checksum: 6 octal digits, NUL, space

    parts.push(header, data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) parts.push(new Uint8Array(pad))
  }

  parts.push(new Uint8Array(BLOCK * 2)) // end-of-archive marker

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
