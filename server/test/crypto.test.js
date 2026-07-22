import { test, expect } from 'bun:test'
import { encrypt, decrypt } from '../src/lib/crypto.js'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

test('encrypt/decrypt round-trip', () => {
  const { value, iv } = encrypt('secret value with åäö and \n newlines', KEY)
  expect(decrypt(value, iv, KEY)).toBe('secret value with åäö and \n newlines')
})

test('every encryption uses a unique IV and ciphertext', () => {
  const a = encrypt('same', KEY)
  const b = encrypt('same', KEY)
  expect(a.iv).not.toBe(b.iv)
  expect(a.value).not.toBe(b.value)
})

test('tampered ciphertext fails authentication', () => {
  const { value, iv } = encrypt('secret', KEY)
  const raw = Buffer.from(value, 'base64')
  raw[0] ^= 0xff
  expect(() => decrypt(raw.toString('base64'), iv, KEY)).toThrow()
})

test('wrong key fails authentication', () => {
  const { value, iv } = encrypt('secret', KEY)
  expect(() => decrypt(value, iv, OTHER_KEY)).toThrow()
})

test('rejects keys that are not 32 bytes', () => {
  expect(() => encrypt('x', 'deadbeef')).toThrow()
  expect(() => decrypt('AAAA', 'AAAA', 'deadbeef')).toThrow()
})
