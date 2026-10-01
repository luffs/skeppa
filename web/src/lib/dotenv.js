// .env text <-> the Manifest's variables, for the text view and paste-merge.
//
// The panel stores a key and a value per variable, nothing else, so parsing
// is lossy on purpose: comments, blank lines and order do not survive (the
// caller says so before anything is saved). Values must survive exactly,
// though — whatever serialize() writes, parse() reads back as the same value,
// quotes, backslashes, # and line breaks included.

// Same rule as the server (server/src/lib/validate.js).
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }

// Reads `text` as KEY=value lines. Accepted: an optional `export ` prefix,
// unquoted values (a `#` after whitespace starts a comment, so URLs keep
// their fragments), single quotes (literal, may span lines) and double quotes
// (\n \r \t \" \\ escapes, may span lines).
//
// Returns { vars: [{ key, value, line }], problems: [{ line, reason }],
// comments, duplicates }: later duplicates win; `comments` counts the comment
// lines and inline comments that will not be kept.
export function parseDotenv(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const byKey = new Map()
  const problems = []
  const duplicates = new Set()
  let comments = 0

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      comments++
      continue
    }
    const body = trimmed.replace(/^export\s+/, '')
    const eq = body.indexOf('=')
    if (eq < 0) {
      problems.push({ line: lineNo, reason: 'has no = — expected KEY=value' })
      continue
    }
    const key = body.slice(0, eq).trim()
    if (!ENV_KEY_RE.test(key)) {
      problems.push({ line: lineNo, reason: `"${key}" is not a valid name — letters, digits and _, not starting with a digit` })
      continue
    }

    let rest = body.slice(eq + 1).replace(/^[ \t]+/, '')
    let value
    const quote = rest[0]
    if (quote === '"' || quote === "'") {
      // A quoted value may run over several lines: keep reading until the
      // closing quote, a double quote's escapes honoured on the way.
      let out = ''
      let j = 1
      let closed = false
      let after = ''
      for (;;) {
        while (j < rest.length) {
          const ch = rest[j]
          if (quote === '"' && ch === '\\' && j + 1 < rest.length) {
            const next = rest[j + 1]
            out += ESCAPES[next] ?? `\\${next}` // an unknown escape stays as written
            j += 2
            continue
          }
          if (ch === quote) {
            closed = true
            after = rest.slice(j + 1)
            break
          }
          out += ch
          j++
        }
        if (closed || i + 1 >= lines.length) break
        out += '\n'
        i++
        rest = lines[i]
        j = 0
      }
      if (!closed) {
        problems.push({ line: lineNo, reason: `a ${quote === '"' ? 'double' : 'single'} quote opened here is never closed` })
        continue
      }
      const tail = after.trim()
      if (tail && !tail.startsWith('#')) {
        problems.push({ line: lineNo, reason: 'has text after the closing quote' })
        continue
      }
      if (tail) comments++
      value = out
    } else {
      const hash = rest.search(/[ \t]#/)
      if (hash >= 0) {
        comments++
        rest = rest.slice(0, hash)
      }
      value = rest.replace(/[ \t]+$/, '')
    }

    if (byKey.has(key)) duplicates.add(key)
    byKey.set(key, { key, value, line: lineNo })
  }

  return { vars: [...byKey.values()], problems, comments, duplicates: [...duplicates] }
}

// A value that would not read back unchanged without quotes gets them:
// whitespace anywhere (leading and trailing would be trimmed, a line break
// would end the line), a quote, or a # (it could start a comment).
function needsQuotes(value) {
  return /[\s"'#]/.test(value)
}

function quote(value) {
  return '"' + value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"'
}

// [{ key, value }] -> KEY=value lines, in the order given.
export function serializeDotenv(vars) {
  return vars
    .filter(v => v.key)
    .map(({ key, value }) => `${key}=${needsQuotes(value ?? '') ? quote(value) : (value ?? '')}`)
    .join('\n') + (vars.length ? '\n' : '')
}

// What saving `next` instead of `saved` (a Map of key -> value) would do.
export function diffVars(saved, next) {
  const nextKeys = new Set(next.map(v => v.key))
  return {
    added: next.filter(v => !saved.has(v.key)).map(v => v.key),
    changed: next.filter(v => saved.has(v.key) && saved.get(v.key) !== v.value).map(v => v.key),
    removed: [...saved.keys()].filter(k => !nextKeys.has(k)),
  }
}
