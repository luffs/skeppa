import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { encrypt } from '../src/lib/crypto.js'
import { projectDirs, syncEnvFiles, writeEcosystem, decryptedEnv, runtimeEnv } from '../src/deploy/envfiles.js'

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const MASTER_KEY = 'c'.repeat(64)

function setup({ cwd = null, start_command = 'bun run start', write_env_file = 0, port = null } = {}) {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  const { lastInsertRowid } = db.query(
    `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, start_command, cwd, write_env_file, port)
     VALUES ('app', 'App', 'o/r', 'main', 'app', ?, ?, ?, ?)`
  ).run(start_command, cwd, write_env_file, port)
  const project = db.query('SELECT * FROM projects WHERE id = ?').get(Number(lastInsertRowid))
  const { value, iv } = encrypt('sekret', MASTER_KEY)
  db.query('INSERT INTO env_vars (project_id, key, value_encrypted, iv) VALUES (?, ?, ?, ?)')
    .run(project.id, 'TOKEN', value, iv)
  const config = { appsDir: mkdtempSync(join(tmpdir(), 'skeppa-apps-')), masterKey: MASTER_KEY }
  return { db, config, project }
}

test('syncEnvFiles writes shared/.env and copies into an existing work dir when opted in', () => {
  const { db, config, project } = setup({ cwd: 'zerver', write_env_file: 1 })
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.work, { recursive: true })

  const envVars = syncEnvFiles(db, config, project)
  expect(envVars).toEqual({ TOKEN: 'sekret' })
  expect(readFileSync(join(dirs.shared, '.env'), 'utf8')).toBe('TOKEN=sekret\n')
  expect(readFileSync(join(dirs.work, '.env'), 'utf8')).toBe('TOKEN=sekret\n')
})

test('syncEnvFiles skips the copy when the app was never deployed', () => {
  const { db, config, project } = setup({ write_env_file: 1 })
  const dirs = projectDirs(config, project)
  syncEnvFiles(db, config, project)
  expect(existsSync(join(dirs.shared, '.env'))).toBe(true)
  expect(existsSync(join(dirs.work, '.env'))).toBe(false)
})

test('syncEnvFiles writes nothing by default and still returns the vars', () => {
  const { db, config, project } = setup()
  const dirs = projectDirs(config, project)
  const envVars = syncEnvFiles(db, config, project)
  expect(envVars).toEqual({ TOKEN: 'sekret' })
  expect(existsSync(join(dirs.shared, '.env'))).toBe(false)
})

test('syncEnvFiles deletes stale .env files when the toggle is off', () => {
  const { db, config, project } = setup({ cwd: 'zerver' })
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.shared, { recursive: true })
  mkdirSync(dirs.work, { recursive: true })
  writeFileSync(join(dirs.shared, '.env'), 'TOKEN=old\n')
  writeFileSync(join(dirs.work, '.env'), 'TOKEN=old\n')

  syncEnvFiles(db, config, project)
  expect(existsSync(join(dirs.shared, '.env'))).toBe(false)
  expect(existsSync(join(dirs.work, '.env'))).toBe(false)
})

test('writeEcosystem contains no env values', () => {
  const { config, project } = setup({ cwd: 'zerver' })
  const path = writeEcosystem(config, project)
  expect(path).toBe(projectDirs(config, project).ecosystem)
  const raw = readFileSync(path, 'utf8')
  expect(raw).not.toContain('sekret')
  const generated = require(path)
  expect(generated.apps[0]).toMatchObject({
    name: 'app',
    // resolved to an absolute path so the pm2 daemon can spawn it even when
    // its boot PATH lacks ~/.bun/bin
    script: Bun.which('bun'),
    args: 'run start',
  })
  expect(generated.apps[0].env).toBeUndefined()
  expect(generated.apps[0].cwd.endsWith('zerver')).toBe(true)
})

test('writeEcosystem returns null and removes a stale file for build-only projects', () => {
  const { config, project } = setup({ start_command: '' })
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(dirs.ecosystem, 'module.exports = { apps: [{ env: { TOKEN: "sekret" } }] }\n')

  expect(writeEcosystem(config, project)).toBeNull()
  expect(existsSync(dirs.ecosystem)).toBe(false)
})

test('writeEcosystem refuses the panel itself and scrubs a stale generated spec', () => {
  const { config, project } = setup()
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(dirs.ecosystem, 'module.exports = { apps: [{ name: "app" }] }\n')

  expect(writeEcosystem({ ...config, selfPm2Name: 'app' }, project)).toBeNull()
  expect(existsSync(dirs.ecosystem)).toBe(false)
})

test('runtimeEnv adds the routed port and a production NODE_ENV default', () => {
  const { project } = setup({ port: 4100 })
  expect(runtimeEnv(project, { TOKEN: 'sekret' }))
    .toEqual({ TOKEN: 'sekret', PORT: '4100', NODE_ENV: 'production' })
  expect(runtimeEnv({ ...project, port: null }, { NODE_ENV: 'test' }))
    .toEqual({ NODE_ENV: 'test' })
})

test('decryptedEnv round-trips through the DB', () => {
  const { db, config, project } = setup()
  expect(decryptedEnv(db, config, project.id)).toEqual({ TOKEN: 'sekret' })
})

test('a start command the panel cannot resolve passes through untouched', () => {
  const { config, project } = setup({ start_command: './run.sh --port 1' })
  const generated = require(writeEcosystem(config, project))
  expect(generated.apps[0].script).toBe('./run.sh')
  expect(generated.apps[0].args).toBe('--port 1')
})
