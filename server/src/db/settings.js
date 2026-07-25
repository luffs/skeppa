import { encrypt, decrypt } from '../lib/crypto.js'

export function getSetting(db, key) {
  return db.query('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
}

export function setSetting(db, key, value) {
  db.query(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function deleteSetting(db, key) {
  db.query('DELETE FROM settings WHERE key = ?').run(key)
}

// The standard Firebase web-app config snippet. Anything else pasted along
// with it is dropped on save.
export const FIREBASE_CONFIG_KEYS = [
  'apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId',
]

export function getFirebaseConfig(db) {
  const raw = getSetting(db, 'firebase_config')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
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
