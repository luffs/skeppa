import { encrypt, decrypt } from '../lib/crypto.js'

export function getSetting(db, key) {
  return db.query('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
}

export function setSetting(db, key, value) {
  db.query(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

// Secrets (GitHub App private key, webhook secret) are stored encrypted with
// the MASTER_KEY, same as project ENV values.
export function setSecretSetting(db, masterKey, key, plaintext) {
  const { value, iv } = encrypt(plaintext, masterKey)
  setSetting(db, key, JSON.stringify({ value, iv }))
}

export function getSecretSetting(db, masterKey, key) {
  const raw = getSetting(db, key)
  if (!raw) return null
  const { value, iv } = JSON.parse(raw)
  return decrypt(value, iv, masterKey)
}
