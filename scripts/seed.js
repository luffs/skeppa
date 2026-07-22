// Creates (or resets the password of) the admin user.
// Usage: bun scripts/seed.js <username> <password>
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { loadConfig } from '../server/src/config.js'
import { openDb } from '../server/src/db/index.js'
import { migrate } from '../server/src/db/migrate.js'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('usage: bun scripts/seed.js <username> <password>')
  process.exit(1)
}
if (password.length < 8) {
  console.error('password must be at least 8 characters')
  process.exit(1)
}

const config = loadConfig({ requireMasterKey: false })
mkdirSync(config.dataDir, { recursive: true })
const db = openDb(join(config.dataDir, 'skeppa.db'))
migrate(db, join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'db', 'migrations'))

const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })
const existing = db.query('SELECT id FROM users WHERE username = ?').get(username)
if (existing) {
  db.query('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id)
  console.log(`updated password for existing user "${username}"`)
} else {
  db.query('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash)
  console.log(`created user "${username}"`)
}
