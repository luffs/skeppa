import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

// AES-256-GCM. Each value gets a unique 12-byte IV; the 16-byte auth tag is
// appended to the ciphertext so tampering fails decryption.

export function encrypt(plaintext, masterKeyHex) {
  const key = Buffer.from(masterKeyHex, 'hex')
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex chars)')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return {
    value: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
    iv: iv.toString('base64'),
  }
}

export function decrypt(valueB64, ivB64, masterKeyHex) {
  const key = Buffer.from(masterKeyHex, 'hex')
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex chars)')
  const raw = Buffer.from(valueB64, 'base64')
  if (raw.length < 16) throw new Error('ciphertext too short')
  const ciphertext = raw.subarray(0, raw.length - 16)
  const tag = raw.subarray(raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
