import { test, expect } from 'vitest'
import { parseDotenv, serializeDotenv, diffVars } from '../src/lib/dotenv.js'

// The Manifest's text view and paste-merge. Values are secrets the apps
// depend on, so the one hard rule: what the text view writes, it reads back
// exactly — whatever the value holds.

const AWKWARD = {
  PLAIN: 'value',
  EMPTY: '',
  SPACES: '  leading and trailing  ',
  HASH: 'https://example.com/page#section',
  HASH_ALONE: '#not-a-comment',
  SPACE_HASH: 'keep # this',
  DOUBLE: 'say "hi"',
  SINGLE: "it's",
  BACKSLASH_N: 'a regex with \\n in it', // a literal backslash and n: two characters, not a line break
  BACKSLASH_END: 'ends with \\',
  WINDOWS_PATH: 'C:\\Users\\app',
  TAB: 'a\tb',
  PEM: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----',
  CRLF: 'line one\r\nline two',
  EQUALS: 'a=b=c',
  UNICODE: 'café ⛵',
}

test('every value survives text and back, exactly', () => {
  const vars = Object.entries(AWKWARD).map(([key, value]) => ({ key, value }))
  const text = serializeDotenv(vars)
  const parsed = parseDotenv(text)
  expect(parsed.problems).toEqual([])
  expect(parsed.duplicates).toEqual([])
  expect(Object.fromEntries(parsed.vars.map(v => [v.key, v.value]))).toEqual(AWKWARD)
  // and a multi-line value is one line of text, so rows and lines stay in step
  expect(text.trim().split('\n').length).toBe(vars.length)
})

test('reads what people paste: export, quotes of both kinds, comments, blank lines', () => {
  const { vars, problems, comments } = parseDotenv([
    '# database',
    'export DATABASE_URL=postgres://app@localhost/app   # local only',
    '',
    "SINGLE='literal \\n stays'",
    'DOUBLE="tab\\there"',
    'SPACED =  trimmed value  ',
    'URL=https://example.com/#top',
    'MULTI="first',
    'second"',
    "ALSO_MULTI='one",
    "two'",
  ].join('\n'))
  expect(problems).toEqual([])
  expect(comments).toBe(2) // the comment line and the inline comment
  expect(Object.fromEntries(vars.map(v => [v.key, v.value]))).toEqual({
    DATABASE_URL: 'postgres://app@localhost/app',
    SINGLE: 'literal \\n stays',
    DOUBLE: 'tab\there',
    SPACED: 'trimmed value',
    URL: 'https://example.com/#top',
    MULTI: 'first\nsecond',
    ALSO_MULTI: 'one\ntwo',
  })
  expect(vars.find(v => v.key === 'MULTI').line).toBe(8)
})

test('says which lines are wrong and why, and keeps reading after them', () => {
  const { vars, problems } = parseDotenv([
    'GOOD=1',
    'just some words',
    'BAD-NAME=x',
    '1ST=x',
    'TRAILING="quoted" extra',
    'ALSO_GOOD=2',
    'OPEN="never closed',
  ].join('\n'))
  expect(problems).toEqual([
    { line: 2, reason: 'has no = — expected KEY=value' },
    { line: 3, reason: '"BAD-NAME" is not a valid name — letters, digits and _, not starting with a digit' },
    { line: 4, reason: '"1ST" is not a valid name — letters, digits and _, not starting with a digit' },
    { line: 5, reason: 'has text after the closing quote' },
    { line: 7, reason: 'a double quote opened here is never closed' },
  ])
  expect(vars.map(v => v.key)).toEqual(['GOOD', 'ALSO_GOOD'])
})

test('a key given twice is reported, and the last one wins', () => {
  const { vars, duplicates } = parseDotenv('A=1\nB=2\nA=3\n')
  expect(duplicates).toEqual(['A'])
  expect(Object.fromEntries(vars.map(v => [v.key, v.value]))).toEqual({ A: '3', B: '2' })
})

test('Windows line endings in pasted text are not part of any value', () => {
  expect(parseDotenv('A=1\r\nB="x"\r\n').vars).toEqual([{ key: 'A', value: '1', line: 1 }, { key: 'B', value: 'x', line: 2 }])
})

test('the diff names what a save would add, change and remove', () => {
  const saved = new Map([['KEEP', 'same'], ['EDIT', 'old'], ['GONE', 'x']])
  expect(diffVars(saved, [{ key: 'KEEP', value: 'same' }, { key: 'EDIT', value: 'new' }, { key: 'NEW', value: '1' }]))
    .toEqual({ added: ['NEW'], changed: ['EDIT'], removed: ['GONE'] })
})
