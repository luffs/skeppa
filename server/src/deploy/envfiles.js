import { join } from 'node:path'
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { decrypt } from '../lib/crypto.js'

// Directory layout for a deployed app: source/ is git-owned and disposable,
// shared/ holds panel-generated and durable state, and the ecosystem file
// lives at the root — outside the working tree so a push can never redefine it.
export function projectDirs(config, project) {
  const root = join(config.appsDir, project.slug)
  const source = join(root, 'source')
  return {
    root,
    source,
    shared: join(root, 'shared'),
    work: project.cwd ? join(source, project.cwd) : source,
    ecosystem: join(root, 'ecosystem.config.cjs'),
  }
}

export function decryptedEnv(db, config, projectId) {
  const rows = db.query(
    'SELECT key, value_encrypted, iv FROM env_vars WHERE project_id = ? ORDER BY key'
  ).all(projectId)
  const env = {}
  for (const row of rows) env[row.key] = decrypt(row.value_encrypted, row.iv, config.masterKey)
  return env
}

// Writes shared/.env (canonical) and copies it into the working dir where the
// app expects it. Called on every deploy and whenever ENV vars are saved.
export function writeEnvFiles(db, config, project) {
  const dirs = projectDirs(config, project)
  const envVars = decryptedEnv(db, config, project.id)
  mkdirSync(dirs.shared, { recursive: true })
  const content = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(join(dirs.shared, '.env'), content, { mode: 0o600 })
  if (existsSync(dirs.work)) copyFileSync(join(dirs.shared, '.env'), join(dirs.work, '.env'))
  return envVars
}

// Generates the pm2 ecosystem file for a project. Returns its path, or null
// when the project has no start command (build-only projects).
export function writeEcosystem(db, config, project, envVars = null) {
  if (!project.start_command?.trim()) return null
  const dirs = projectDirs(config, project)
  const env = envVars ?? decryptedEnv(db, config, project.id)
  const [cmd, ...args] = project.start_command.trim().split(/\s+/)
  const app = {
    name: project.pm2_name,
    cwd: dirs.work,
    script: cmd,
    args: args.join(' '),
    interpreter: 'none',
    autorestart: true,
    max_restarts: 10,
    env,
  }
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(dirs.ecosystem, `module.exports = ${JSON.stringify({ apps: [app] }, null, 2)}\n`, { mode: 0o600 })
  return dirs.ecosystem
}
