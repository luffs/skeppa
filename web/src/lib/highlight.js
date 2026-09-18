// A deliberately small syntax highlighter for the file viewer: one regex pass
// per language, no grammar. Its output goes into v-html, so the rule that
// matters is structural — every character of the input passes through
// escapeHtml, matched or not, and the only markup that exists is the
// <span class="tok-…"> this file writes itself. A construct the regex
// misreads (a regex literal with a quote in it) gets the wrong colour, never
// the wrong text.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => ENTITIES[ch])

const JS_KEYWORDS =
  'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|' +
  'false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|' +
  'this|throw|true|try|typeof|undefined|var|void|while|yield'

// Each language: one global regex whose capture groups line up with `classes`.
const LANGUAGES = {
  js: {
    regex: new RegExp(
      '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' + // comments
      '|("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\[\\s\\S]|[^`\\\\])*`)' + // strings
      '|\\b(0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?)\\b' + // numbers
      `|\\b(${JS_KEYWORDS})\\b`,
      'g'
    ),
    classes: ['tok-comment', 'tok-string', 'tok-number', 'tok-keyword'],
  },
  // .env files: whole-line comments, and the key of each assignment.
  env: {
    regex: /^([ \t]*#.*)$|^([ \t]*(?:export[ \t]+)?[A-Za-z_][\w.]*)(?==)/gm,
    classes: ['tok-comment', 'tok-keyword'],
  },
}

const JS_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'javascript', 'typescript'])

// The language for a file name or a fenced block's info string, or null.
export function languageFor(name) {
  const lower = String(name ?? '').toLowerCase()
  const base = lower.split('/').pop()
  if (base === '.env' || base.startsWith('.env.') || base === 'env' || base === 'dotenv') return 'env'
  return JS_EXTENSIONS.has(base.split('.').pop()) ? 'js' : null
}

// Escaped HTML for `text`, with token spans when the language is known.
export function highlight(text, language) {
  // A CRLF checkout: a comment token would end in the \r, and a \r closing a
  // span renders as a second line break under white-space: pre.
  text = String(text).replace(/\r\n?/g, '\n')
  const lang = LANGUAGES[language]
  if (!lang) return escapeHtml(text)
  let html = ''
  let last = 0
  lang.regex.lastIndex = 0
  for (const match of text.matchAll(lang.regex)) {
    const group = match.findIndex((value, i) => i > 0 && value !== undefined)
    if (group < 1 || !match[0]) continue
    const start = match.index + match[0].indexOf(match[group])
    html += escapeHtml(text.slice(last, start))
    html += `<span class="${lang.classes[group - 1]}">${escapeHtml(match[group])}</span>`
    last = start + match[group].length
  }
  return html + escapeHtml(text.slice(last))
}
