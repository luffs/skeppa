import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { encrypt } from '../src/lib/crypto.js'
import { projectDirs, writeEcosystem } from '../src/deploy/envfiles.js'
import { resurrectApps } from '../src/deploy/resurrect.js'

const migrationsDir = fileURLToPath(new URL('../src/db/migrations', import.meta.url))
const MASTER_KEY = 'c'.repeat(64)

// Fake pm2: a fixed process list plus a record of startOrReload calls.
function fakePm2(names, { failFor = [] } = {}) {
  const started = []
  return {
    started,
    jlist: async () => names.map(name => ({ name })),
    startOrReload: async (ecosystemFile, appEnv) => {
      if (failFor.some(f => ecosystemFile.includes(f))) throw new Error('boom')
      started.push({ ecosystemFile, appEnv })
    },
  }
}

function setup() {
  const db = new Database(':memory:')
  migrate(db, migrationsDir)
  const config = {
    appsDir: mkdtempSync(join(tmpdir(), 'skeppa-resurrect-')),
    masterKey: MASTER_KEY,
    selfPm2Name: 'skeppa',
  }
  const addProject = (slug, { start_command = 'bun run start', port = null, env = {}, auto_start = 1 } = {}) => {
    const { lastInsertRowid } = db.query(
      `INSERT INTO projects (slug, name, repo_full_name, branch, pm2_name, start_command, port, auto_start)
       VALUES (?, ?, 'o/r', 'main', ?, ?, ?, ?)`
    ).run(slug, slug, slug, start_command, port, auto_start)
    const project = db.query('SELECT * FROM projects WHERE id = ?').get(Number(lastInsertRowid))
    for (const [key, value] of Object.entries(env)) {
      const enc = encrypt(value, MASTER_KEY)
      db.query('INSERT INTO env_vars (project_id, key, value_encrypted, iv) VALUES (?, ?, ?, ?)')
        .run(project.id, key, enc.value, enc.iv)
    }
    return project
  }
  return { db, config, addProject }
}

test('starts deployed apps pm2 does not know, with decrypted env and port', async () => {
  const { db, config, addProject } = setup()
  const project = addProject('app', { port: 4100, env: { TOKEN: 'sekret' } })
  writeEcosystem(config, project)

  const pm2 = fakePm2([])
  const started = await resurrectApps({ db, config, pm2, log: () => {} })
  expect(started).toEqual(['app'])
  expect(pm2.started[0].ecosystemFile).toBe(projectDirs(config, project).ecosystem)
  expect(pm2.started[0].appEnv).toEqual({ TOKEN: 'sekret', PORT: '4100', NODE_ENV: 'production' })
})

test('leaves processes pm2 already lists alone — stopped counts as known', async () => {
  const { db, config, addProject } = setup()
  writeEcosystem(config, addProject('app'))

  const pm2 = fakePm2(['app'])
  expect(await resurrectApps({ db, config, pm2, log: () => {} })).toEqual([])
  expect(pm2.started).toEqual([])
})

test('a project stopped through the panel (auto_start off) stays stopped across a reboot', async () => {
  const { db, config, addProject } = setup()
  writeEcosystem(config, addProject('parked', { auto_start: 0 }))
  writeEcosystem(config, addProject('active'))

  const pm2 = fakePm2([])
  expect(await resurrectApps({ db, config, pm2, log: () => {} })).toEqual(['active'])
})

test('skips the panel itself, build-only projects and never-deployed projects', async () => {
  const { db, config, addProject } = setup()
  const self = addProject('skeppa')
  writeEcosystem(config, self)
  addProject('build-only', { start_command: '' })
  addProject('never-deployed') // no ecosystem file on disk

  const pm2 = fakePm2([])
  expect(await resurrectApps({ db, config, pm2, log: () => {} })).toEqual([])
})

test('scrubs plaintext env blocks that pre-upgrade ecosystem files carried', async () => {
  const { db, config, addProject } = setup()
  const project = addProject('app', { env: { TOKEN: 'sekret' } })
  const dirs = projectDirs(config, project)
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(dirs.ecosystem,
    `module.exports = { apps: [{ name: 'app', env: { TOKEN: 'sekret' } }] }\n`)

  await resurrectApps({ db, config, pm2: fakePm2(['app']), log: () => {} })
  expect(readFileSync(dirs.ecosystem, 'utf8')).not.toContain('sekret')
})

test('one failing app does not stop the others', async () => {
  const { db, config, addProject } = setup()
  writeEcosystem(config, addProject('bad'))
  writeEcosystem(config, addProject('good'))

  const pm2 = fakePm2([], { failFor: [join('bad', 'ecosystem.config.cjs')] })
  expect(await resurrectApps({ db, config, pm2, log: () => {} })).toEqual(['good'])
})

test('an unreachable pm2 daemon is a logged no-op, not a crash', async () => {
  const { db, config, addProject } = setup()
  writeEcosystem(config, addProject('app'))
  const lines = []
  const pm2 = { jlist: async () => { throw new Error('no daemon') } }
  expect(await resurrectApps({ db, config, pm2, log: l => lines.push(l) })).toEqual([])
  expect(lines[0]).toContain('pm2 unreachable')
})
