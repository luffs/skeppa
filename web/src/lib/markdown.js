import { escapeHtml, highlight, languageFor } from './highlight.js'

// A small Markdown renderer for the file viewer. Homemade on purpose: its
// output goes into v-html, and the README on screen may be a tenant's while
// the session is an admin's — so safety has to be structural, not a
// sanitizer's configuration. The structure: no input character reaches the
// output except through escapeHtml, and every tag and attribute in the
// result is written by this file. Raw HTML in the source is dropped (its
// text stays), images are never fetched (a remote one would report the
// viewer's address to a host the author picked) and a link is only a link
// when its target is http(s)/mailto or a path inside the project.
//
// Covers what READMEs use: headings, paragraphs, fenced and indented code,
// nested and task lists, quotes, tables, rules, emphasis, code spans, links.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const INDENTED = /^(?: {4}|\t)(.*)$/
const MAX_DEPTH = 12 // quotes in lists in quotes… — beyond this it is just text

const startsBlock = line =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || line.startsWith('<!--')

// --- inline ------------------------------------------------------------------

// Bodies are length-capped: an unclosed `**` would otherwise send a lazy
// quantifier to the end of the text from every position that opens one.
const SPAN = '[\\s\\S]{0,1000}?'
const INLINE = new RegExp([
  '\\\\(?<escaped>[\\\\`*_{}\\[\\]()#+\\-.!|<>~])',
  `(?<tick>\`+)(?<code>${SPAN}[^\`])\\k<tick>(?!\`)`,
  '(?<image>!)?\\[(?<label>(?:[^\\[\\]]|\\[[^\\[\\]]*\\]){0,1000})\\]' +
    '\\([ \\t]*<?(?<target>[^\\s()<>]*(?:\\([^\\s()<>]*\\)[^\\s()<>]*)*)>?(?:[ \\t]+(?:"[^"]*"|\'[^\']*\'))?[ \\t]*\\)',
  '<(?<auto>(?:https?:\\/\\/|mailto:)[^\\s<>]+)>',
  '(?<comment><!--[\\s\\S]*?-->)',
  '(?<tag><\\/?[a-zA-Z][^<>]*>)',
  '(?<bare>\\bhttps?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?\'")\\]])',
  `\\*\\*(?=\\S)(?<strongStar>${SPAN}\\S)\\*\\*`,
  `(?<!\\w)__(?=\\S)(?<strongLine>${SPAN}\\S)__(?!\\w)`,
  `\\*(?=[^\\s*])(?<emStar>${SPAN}[^\\s*])\\*`,
  `(?<!\\w)_(?=[^\\s_])(?<emLine>${SPAN}[^\\s_])_(?!\\w)`,
  `~~(?=\\S)(?<strike>${SPAN}\\S)~~`,
].join('|'), 'g')

// <a …> for a target worth linking, or '' — then the label stays plain text.
function anchorFor(target, ctx) {
  if (/^(?:https?:\/\/|mailto:)/i.test(target)) {
    return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">`
  }
  // In-page anchors have nowhere to go here; any other scheme (javascript:,
  // data:, protocol-relative) is not a link at all.
  if (!target || target.startsWith('#') || target.startsWith('//') || /^[a-zA-Z][\w+.-]*:/.test(target)) return ''
  const path = ctx.resolveLink(target)
  return path == null ? '' : `<a href="#" data-path="${escapeHtml(path)}">`
}

function inline(text, ctx, inLink = false) {
  let html = ''
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    html += escapeHtml(text.slice(last, match.index))
    last = match.index + match[0].length
    const g = match.groups
    if (g.escaped !== undefined) html += escapeHtml(g.escaped)
    else if (g.code !== undefined) html += `<code>${escapeHtml(g.code.replace(/^ (.*) $/s, '$1'))}</code>`
    else if (g.label !== undefined) {
      // An image is never loaded — it becomes its alt text, linked to the file.
      const label = g.image ? escapeHtml(g.label || g.target) : inline(g.label, ctx, true)
      const open = inLink ? '' : anchorFor(g.target, ctx)
      html += open ? `${open}${label}</a>` : label
    } else if (g.auto !== undefined || g.bare !== undefined) {
      const url = g.auto ?? g.bare
      const open = inLink ? '' : anchorFor(url, ctx)
      html += open ? `${open}${escapeHtml(url)}</a>` : escapeHtml(url)
    } else if (g.tag !== undefined) html += /^<br\b/i.test(g.tag) ? '<br>' : ''
    else if (g.comment !== undefined) html += ''
    else if (g.strongStar !== undefined || g.strongLine !== undefined) html += `<strong>${inline(g.strongStar ?? g.strongLine, ctx, inLink)}</strong>`
    else if (g.emStar !== undefined || g.emLine !== undefined) html += `<em>${inline(g.emStar ?? g.emLine, ctx, inLink)}</em>`
    else if (g.strike !== undefined) html += `<del>${inline(g.strike, ctx, inLink)}</del>`
  }
  return html + escapeHtml(text.slice(last))
}

// --- blocks ------------------------------------------------------------------

const cells = row =>
  row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim())

function table(lines, i, ctx) {
  const head = cells(lines[i])
  const align = cells(lines[i + 1]).map(rule =>
    rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : '')
  const cell = (tag, text, col) =>
    `<${tag}${align[col] ? ` style="text-align: ${align[col]}"` : ''}>${inline(text ?? '', ctx)}</${tag}>`
  let html = `<div class="table-scroll"><table><thead><tr>${head.map((t, c) => cell('th', t, c)).join('')}</tr></thead><tbody>`
  i += 2
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    const row = cells(lines[i++])
    html += `<tr>${head.map((_, c) => cell('td', row[c], c)).join('')}</tr>`
  }
  return { html: html + '</tbody></table></div>', next: i }
}

function list(lines, i, ctx, depth) {
  const first = ITEM.exec(lines[i])
  const indent = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let loose = false
  let blank = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      blank = true
      continue
    }
    const m = RULE.test(line) ? null : ITEM.exec(line)
    const lineIndent = /^[ \t]*/.exec(line)[0].length
    if (m && Math.abs(m[1].length - indent) <= 1 && /\d/.test(m[2]) === ordered) {
      if (blank && items.length) loose = true
      items.push({ lines: [m[3]], content: m[1].length + m[2].length + 1 })
    } else if (items.length && lineIndent >= indent + 2) {
      const item = items.at(-1)
      if (blank) item.lines.push('')
      item.lines.push(line.slice(Math.min(lineIndent, item.content)))
    } else if (items.length && !blank && !startsBlock(line)) {
      items.at(-1).lines.push(line.trim()) // a paragraph continuing unindented
    } else break
    blank = false
  }
  const rendered = items.map(item => {
    const task = /^\[([ xX])\][ \t]+/.exec(item.lines[0])
    if (task) item.lines[0] = item.lines[0].slice(task[0].length)
    let inner = blocks(item.lines, ctx, depth + 1)
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1')
    const box = task ? `<span class="task">${task[1] === ' ' ? '☐' : '☑'}</span> ` : ''
    return `<li>${box}${inner}</li>`
  }).join('')
  const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : ''
  return { html: ordered ? `<ol${start}>${rendered}</ol>` : `<ul>${rendered}</ul>`, next: i }
}

function blocks(lines, ctx, depth = 0) {
  if (depth > MAX_DEPTH) return `<p>${escapeHtml(lines.join('\n'))}</p>`
  let html = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m
    if (!line.trim()) {
      i++
    } else if ((m = FENCE.exec(line))) {
      const closing = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}[ \\t]*$`)
      const body = []
      for (i++; i < lines.length && !closing.test(lines[i]); i++) body.push(lines[i])
      i++
      html += `<pre><code>${highlight(body.join('\n'), languageFor(m[2]))}</code></pre>`
    } else if (line.startsWith('<!--')) {
      while (i < lines.length && !lines[i].includes('-->')) i++
      i++
    } else if ((m = HEADING.exec(line))) {
      html += `<h${m[1].length}>${inline(m[2], ctx)}</h${m[1].length}>`
      i++
    } else if (RULE.test(line)) {
      html += '<hr>'
      i++
    } else if (QUOTE.test(line)) {
      const body = []
      for (; i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i])); i++) {
        body.push(QUOTE.exec(lines[i])?.[1] ?? lines[i])
      }
      html += `<blockquote>${blocks(body, ctx, depth + 1)}</blockquote>`
    } else if (ITEM.test(line)) {
      const out = list(lines, i, ctx, depth)
      html += out.html
      i = out.next
    } else if (INDENTED.test(line)) {
      const body = []
      for (; i < lines.length && (INDENTED.test(lines[i]) || !lines[i].trim()); i++) {
        body.push(INDENTED.exec(lines[i])?.[1] ?? '')
      }
      html += `<pre><code>${escapeHtml(body.join('\n').replace(/\n+$/, ''))}</code></pre>`
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && lines[i + 1].includes('-') &&
               cells(line).length === cells(lines[i + 1]).length) {
      const out = table(lines, i, ctx)
      html += out.html
      i = out.next
    } else {
      const body = [line]
      for (i++; i < lines.length && lines[i].trim(); i++) {
        // Before startsBlock: under a paragraph, `---` is a heading, not a rule.
        const underline = SETEXT.exec(lines[i])
        if (underline) {
          const level = underline[1][0] === '=' ? 1 : 2
          html += `<h${level}>${inline(body.join('\n'), ctx)}</h${level}>`
          body.length = 0
          i++
          break
        }
        if (startsBlock(lines[i])) break
        body.push(lines[i])
      }
      if (body.length) html += `<p>${inline(body.join('\n'), ctx)}</p>`
    }
  }
  return html
}

// `href` as a path from the project root, given the directory the document
// lives in — or null when it climbs out of the root. A leading slash means
// the root, as it does on GitHub. Query and fragment are dropped.
export function resolveRelative(baseDir, href) {
  let target = String(href).replace(/[?#].*$/, '')
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  const segments = target.startsWith('/') ? [] : String(baseDir ?? '').split('/').filter(Boolean)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part !== '..') segments.push(part)
    else if (!segments.length) return null
    else segments.pop()
  }
  return segments.join('/')
}

// HTML for a Markdown document. `baseDir` is where the document lives, so
// its relative links can be offered as in-viewer navigation (`data-path`).
export function renderMarkdown(source, { baseDir = '' } = {}) {
  const ctx = { resolveLink: href => resolveRelative(baseDir, href) }
  return blocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), ctx)
}
