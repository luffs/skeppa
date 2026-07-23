import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { encrypt } from '../src/lib/crypto.js'
import { projectDirs, writeEnvFiles, writeEcosystem, decryptedEnv } from '../src/deploy/envfiles.js'

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const MASTER_KEY = 'c'.repeat(64)

function setup({ cwd = null, start_command = 'bun run start' } = {}) {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, start_command, cwd)
     VALUES ('app', 'App', 'o/r', 'main', 'app', ?, ?)`
  ).run(start_command, cwd)
  const project = db.query('SELECT * FROM projects WHERE id = ?').get(Number(lastInsertRowid))
  const { value, iv } = encrypt('sekret', MASTER_KEY)
  db.query('INSERT INTO env_vars (project_id, key, value_encrypted, iv) VALUES (?, ?, ?, ?)')
    .run(project.id, 'TOKEN', value, iv)
  const config = { appsDir: mkdtempSync(join(tmpdir(), 'skeppa-apps-')), masterKey: MASTER_KEY }
  return { db, config, project }
}

test('writeEnvFiles writes shared/.env and copies into an existing work dir', () => {
  const { db, config, project } = setup({ cwd: 'zerver' })
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.work, { recursive: true })

  const envVars = writeEnvFiles(db, config, project)
  expect(envVars).toEqual({ TOKEN: 'sekret' })
  expect(readFileSync(join(dirs.shared, '.env'), 'utf8')).toBe('TOKEN=sekret\n')
  expect(readFileSync(join(dirs.work, '.env'), 'utf8')).toBe('TOKEN=sekret\n')
})

test('writeEnvFiles skips the copy when the app was never deployed', () => {
  const { db, config, project } = setup()
  const dirs = projectDirs(config, project)
  writeEnvFiles(db, config, project)
  expect(existsSync(join(dirs.shared, '.env'))).toBe(true)
  expect(existsSync(join(dirs.work, '.env'))).toBe(false)
})

test('writeEcosystem bakes current env into the pm2 config', () => {
  const { db, config, project } = setup({ cwd: 'zerver' })
  const path = writeEcosystem(db, config, project)
  expect(path).toBe(projectDirs(config, project).ecosystem)
  const generated = require(path)
  expect(generated.apps[0]).toMatchObject({
    name: 'app',
    script: 'bun',
    args: 'run start',
    env: { TOKEN: 'sekret' },
  })
  expect(generated.apps[0].cwd.endsWith('zerver')).toBe(true)
})

test('writeEcosystem returns null for build-only projects', () => {
  const { db, config, project } = setup({ start_command: '' })
  expect(writeEcosystem(db, config, project)).toBeNull()
})

test('decryptedEnv round-trips through the DB', () => {
  const { db, config, project } = setup()
  expect(decryptedEnv(db, config, project.id)).toEqual({ TOKEN: 'sekret' })
})
