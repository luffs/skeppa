import { describe, test, expect } from 'vitest'
import { renderMarkdown, resolveRelative } from '../src/lib/markdown.js'
import { highlight, languageFor, escapeHtml } from '../src/lib/highlight.js'

// Both renderers feed v-html, and the document may be a tenant's while the
// session is an admin's. What is tested first is therefore not fidelity but
// that nothing the author writes can become markup.

// Every tag in `html`, by parsing it the way a browser would.
function tagsIn(html) {
  const box = document.createElement('div')
  box.innerHTML = html
  return [...box.querySelectorAll('*')]
}
const ALLOWED = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'HR', 'BR', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN'])

describe('markdown is safe by construction', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'text <iframe src="https://evil.example"></iframe> text',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](//evil.example/x)',
    '[x](https://ok.example/" onmouseover="alert(1))',
    '[x](docs/a.md" onclick="alert(1))',
    '![alt" onerror="alert(1)](https://evil.example/pixel.png)',
    '<https://ok.example/"onmouseover="alert(1)>',
    '```js"><script>alert(1)</script>\nconst a = "</code><script>alert(2)</script>"\n```',
    '| a | b |\n|---|---|\n| <script>alert(1)</script> | `<b>` |',
    '# <svg onload=alert(1)>',
    '- [x] <input autofocus onfocus=alert(1)>',
    '> <details open ontoggle=alert(1)>',
    '&lt;script&gt; stays text, and so does &#x3C;script&#x3E;',
  ]
  for (const source of hostile) {
    test(source.slice(0, 50).replace(/\n/g, '⏎'), () => {
      const html = renderMarkdown(source)
      for (const el of tagsIn(html)) {
        expect(ALLOWED.has(el.tagName)).toBe(true)
        for (const attr of el.attributes) {
          expect(['href', 'target', 'rel', 'data-path', 'class', 'style', 'start']).toContain(attr.name)
          expect(attr.name.startsWith('on')).toBe(false)
        }
        if (el.tagName === 'A') expect(el.getAttribute('href')).toMatch(/^(#$|https?:\/\/|mailto:)/)
        if (el.hasAttribute('style')) expect(el.getAttribute('style')).toMatch(/^text-align: (center|right)$/)
      }
    })
  }

  test('images are never loaded', () => {
    const html = renderMarkdown('![logo](https://evil.example/pixel.png) and ![diagram](docs/flow.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('data-path="docs/flow.png"')
  })

  test('an unclosed marker on a huge line does not hang the renderer', () => {
    const started = Date.now()
    renderMarkdown('**'.repeat(100_000) + ' [' .repeat(50_000))
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('absurd nesting ends as text instead of a stack overflow', () => {
    expect(() => renderMarkdown('>'.repeat(5000) + ' deep')).not.toThrow()
  })
})

describe('markdown renders what READMEs use', () => {
  test('headings, emphasis, code spans and snake_case', () => {
    const html = renderMarkdown('# Title\n\nSome **bold**, *em*, ~~old~~ and `a < b` in my_var_name.\n\nSetext\n---')
    expect(html).toBe('<h1>Title</h1><p>Some <strong>bold</strong>, <em>em</em>, <del>old</del> and <code>a &lt; b</code> in my_var_name.</p><h2>Setext</h2>')
  })

  test('fenced code is highlighted by its info string and never parsed as markdown', () => {
    const html = renderMarkdown('```js\nconst a = "**x**" // note\n```\n\n```\n# not a heading\n```')
    expect(html).toContain('<span class="tok-keyword">const</span>')
    expect(html).toContain('<span class="tok-string">&quot;**x**&quot;</span>')
    expect(html).toContain('<pre><code># not a heading</code></pre>')
  })

  test('nested, ordered and task lists', () => {
    const html = renderMarkdown('- one\n  - inner\n- [x] done\n- [ ] todo\n\n3. three\n4. four')
    expect(html).toBe(
      '<ul><li>one<ul><li>inner</li></ul></li><li><span class="task">☑</span> done</li><li><span class="task">☐</span> todo</li></ul>' +
      '<ol start="3"><li>three</li><li>four</li></ol>')
  })

  test('tables with alignment, quotes and rules', () => {
    const html = renderMarkdown('| Key | Default |\n|:--|--:|\n| `PORT` | 3000 |\n\n> quoted\n> text\n\n---')
    expect(html).toContain('<th>Key</th><th style="text-align: right">Default</th>')
    expect(html).toContain('<td><code>PORT</code></td><td style="text-align: right">3000</td>')
    expect(html).toContain('<blockquote><p>quoted\ntext</p></blockquote><hr>')
  })

  test('links: external open in a new tab, relative ones navigate the viewer, anchors stay text', () => {
    const html = renderMarkdown('[site](https://example.com) [api](../docs/api.md#auth) [top](#top) https://bare.example/x.',
      { baseDir: 'web/src' })
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>')
    expect(html).toContain('<a href="#" data-path="web/docs/api.md">api</a>')
    expect(html).toContain(' top ')
    expect(html).toContain('>https://bare.example/x</a>.')
  })

  test('a badge — an image inside a link — is one link with the alt text', () => {
    const html = renderMarkdown('[![build](https://ci.example/badge.svg)](https://ci.example/run)')
    expect(html).toBe('<p><a href="https://ci.example/run" target="_blank" rel="noopener noreferrer">build</a></p>')
  })

  test('raw html loses its tags and keeps its text; comments vanish', () => {
    const html = renderMarkdown('<p align="center"><b>Skeppa</b><br>deploys</p>\n\n<!-- a\nnote -->\n\nafter')
    expect(html).toBe('<p>Skeppa<br>deploys</p><p>after</p>')
  })
})

test('relative links resolve from the document’s folder and never leave the root', () => {
  expect(resolveRelative('', 'docs/a.md')).toBe('docs/a.md')
  expect(resolveRelative('docs', './b.md?x=1#frag')).toBe('docs/b.md')
  expect(resolveRelative('docs/deep', '../../README.md')).toBe('README.md')
  expect(resolveRelative('docs', '/LICENSE')).toBe('LICENSE')
  expect(resolveRelative('docs', 'my%20file.md')).toBe('docs/my file.md')
  expect(resolveRelative('docs', '../../etc/passwd')).toBeNull()
  expect(resolveRelative('', '%E0%A4%A')).toBeNull()
})

describe('highlight', () => {
  test('everything is escaped, matched or not', () => {
    const html = highlight('const s = "</span><script>x</script>" // <b>', 'js')
    expect(tagsIn(html).every(el => el.tagName === 'SPAN')).toBe(true)
    expect(html).toContain('&lt;script&gt;')
    expect(highlight('<b>&', null)).toBe(escapeHtml('<b>&'))
  })

  test('javascript: comments, strings, numbers, keywords', () => {
    const html = highlight('/* c */ let n = 0x1f + 42n // tail\nconst t = `a ${b}`', 'js')
    expect(html).toContain('<span class="tok-comment">/* c */</span>')
    expect(html).toContain('<span class="tok-keyword">let</span>')
    expect(html).toContain('<span class="tok-number">0x1f</span>')
    expect(html).toContain('<span class="tok-number">42n</span>')
    expect(html).toContain('<span class="tok-comment">// tail</span>')
    expect(html).toContain('<span class="tok-string">`a ${b}`</span>')
    // a keyword inside a string or an identifier is not a keyword
    expect(highlight('"return" newValue', 'js')).not.toContain('tok-keyword')
  })

  test('a CRLF file does not carry its \\r into a token', () => {
    expect(highlight('// one\r\n// two\r\n', 'js')).toBe(
      '<span class="tok-comment">// one</span>\n<span class="tok-comment">// two</span>\n')
  })

  test('.env files: comments and keys', () => {
    const html = highlight('# database\nDATABASE_URL=postgres://x # not a comment\nexport TOKEN=', 'env')
    expect(html).toBe('<span class="tok-comment"># database</span>\n<span class="tok-keyword">DATABASE_URL</span>=postgres://x # not a comment\n<span class="tok-keyword">export TOKEN</span>=')
  })

  test('language by file name', () => {
    expect(languageFor('src/index.js')).toBe('js')
    expect(languageFor('package.json')).toBe('js')
    expect(languageFor('.env.example')).toBe('env')
    expect(languageFor('web/.env')).toBe('env')
    expect(languageFor('README.md')).toBeNull()
    expect(languageFor('js')).toBe('js') // a fence's info string
  })
})
