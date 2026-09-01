import { join } from 'node:path'
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
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

// The environment the app runs with: the decrypted vars plus the routed port
// (which is what the proxy dials, so it wins over a PORT from Cargo). Injected
// through the pm2 CLI's process env (deploy/pm2.js) — never written to disk.
// NODE_ENV defaults to production (a deploy panel runs production apps); a
// NODE_ENV in Cargo wins.
export function runtimeEnv(project, envVars) {
  const env = { NODE_ENV: 'production', ...envVars }
  if (project.port) env.PORT = String(project.port)
  return env
}

// Keeps the on-disk .env files in line with the project's write_env_file
// toggle: on, shared/.env (canonical) is written and copied into the working
// dir for tools that read .env from disk themselves; off, any previously
// written copies are removed so no plaintext lingers. Always returns the
// decrypted vars. Called on every deploy, on ENV save, and on toggle changes.
export function syncEnvFiles(db, config, project) {
  const dirs = projectDirs(config, project)
  const envVars = decryptedEnv(db, config, project.id)
  if (!project.write_env_file) {
    rmSync(join(dirs.shared, '.env'), { force: true })
    rmSync(join(dirs.work, '.env'), { force: true })
    return envVars
  }
  mkdirSync(dirs.shared, { recursive: true })
  const content = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync(join(dirs.shared, '.env'), content, { mode: 0o600 })
  if (existsSync(dirs.work)) copyFileSync(join(dirs.shared, '.env'), join(dirs.work, '.env'))
  return envVars
}

// Generates the pm2 ecosystem file for a project. Deliberately carries no env
// block — decrypted ENV is injected via the pm2 CLI's environment at
// start/reload time, so secrets never rest in this file. Returns its path, or
// null (removing any stale file) for build-only projects and for the panel
// itself: the self project is defined solely by the repo's own
// ecosystem.config.cjs — a second generated spec for the same pm2 name makes
// reloads merge the two into a broken chimera (script from one, cwd and
// interpreter from the other).
export function writeEcosystem(config, project) {
  const dirs = projectDirs(config, project)
  if (!project.start_command?.trim() || project.pm2_name === config.selfPm2Name) {
    rmSync(dirs.ecosystem, { force: true })
    return null
  }
  const [cmd, ...args] = project.start_command.trim().split(/\s+/)
  // interpreter 'none' means the pm2 DAEMON execs the first word, resolved
  // against the daemon's own environment — the boot unit's PATH, which often
  // lacks ~/.bun/bin (and no shell runs, so ~ never expands). The panel's own
  // PATH does have its tools, so resolve here and bake the absolute path in.
  // A word that is not on the panel's PATH (./run.sh, a container-only tool)
  // passes through untouched.
  const app = {
    name: project.pm2_name,
    cwd: dirs.work,
    script: Bun.which(cmd) ?? cmd,
    args: args.join(' '),
    interpreter: 'none',
    autorestart: true,
    max_restarts: 10,
  }
  mkdirSync(dirs.root, { recursive: true })
  writeFileSync(dirs.ecosystem, `module.exports = ${JSON.stringify({ apps: [app] }, null, 2)}\n`, { mode: 0o600 })
  return dirs.ecosystem
}
