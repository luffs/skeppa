import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../src/github/webhook.js'

const SECRET = 'wh-secret'
const sign = payload => 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')

test('accepts a valid signature', () => {
  const payload = JSON.stringify({ ref: 'refs/heads/main' })
  expect(verifySignature(SECRET, payload, sign(payload))).toBe(true)
})

test('rejects a signature made with another secret', () => {
  const payload = '{"a":1}'
  const bad = 'sha256=' + createHmac('sha256', 'other').update(payload).digest('hex')
  expect(verifySignature(SECRET, payload, bad)).toBe(false)
})

test('rejects when the payload was modified', () => {
  const sig = sign('{"a":1}')
  expect(verifySignature(SECRET, '{"a":2}', sig)).toBe(false)
})

test('rejects malformed or missing headers', () => {
  expect(verifySignature(SECRET, 'x', undefined)).toBe(false)
  expect(verifySignature(SECRET, 'x', '')).toBe(false)
  expect(verifySignature(SECRET, 'x', 'sha1=abcdef')).toBe(false)
  expect(verifySignature(SECRET, 'x', 'sha256=zzzz')).toBe(false)
  expect(verifySignature(SECRET, 'x', 'sha256=abcd')).toBe(false) // wrong length
})
