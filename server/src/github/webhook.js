import { createHmac, timingSafeEqual } from 'node:crypto'

// Verifies GitHub's x-hub-signature-256 header with a timing-safe comparison.
// `payload` must be the raw request body (string or Buffer), not re-serialized JSON.
export function verifySignature(secret, payload, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(payload).digest()
  let given
  try {
    given = Buffer.from(signatureHeader.slice('sha256='.length), 'hex')
  } catch {
    return false
  }
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}
