// Interactive first-time installer. Run with:  bun scripts/install.js
//
// Asks for paths and the admin user, creates the master-key file (never
// overwriting an existing key) and directories, writes .env, builds the
// frontend, seeds the admin and starts the panel under pm2 — running
// `pm2 save` only while the panel is the sole process, which is the one
// moment it is safe (the dump stores process env in plaintext).
//
// Only imports dependency-free modules so it works straight after clone.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { rootDir } from '../server/src/config.js'
import { openDb } from '../server/src/db/index.js'
import { migrate } from '../server/src/db/migrate.js'
import { spawnable, pm2EnvBase } from '../server/src/lib/shell.js'
import { USERNAME_RE, MIN_PASSWORD_LENGTH } from '../server/src/lib/validate.js'
import { jlist, startOrReload } from '../server/src/deploy/pm2.js'

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/

if (process.platform === 'win32') {
  console.error('The installer targets the Linux server. For Windows development, put MASTER_KEY in .env instead.')
  process.exit(1)
}
if (!process.stdin.isTTY) {
  console.error('The installer is interactive — run it from a terminal.')
  process.exit(1)
}

// --- tiny prompt helpers ----------------------------------------------------

const expandHome = p => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

function ask(label, def) {
  const raw = prompt(`${label} [${def}]:`)
  if (raw === null) return def // EOF
  return raw.trim() || def
}

function askYesNo(label, def) {
  const raw = prompt(`${label} ${def ? '[Y/n]' : '[y/N]'}:`)
  if (raw === null || !raw.trim()) return def
  return /^y(es)?$/i.test(raw.trim())
}

// Hidden input via raw mode; echoes nothing. Falls back to a visible prompt
// when raw mode is unavailable.
function askHidden(label) {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    console.log('(cannot hide input in this terminal)')
    return Promise.resolve(prompt(`${label}:`) ?? '')
  }
  process.stdout.write(`${label}: `)
  return new Promise(resolveInput => {
    let buf = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          return resolveInput(buf)
        }
        if (ch === '\u0003') { // ctrl-c
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1) // backspace
        else buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function run(argv, { capture = false } = {}) {
  const proc = Bun.spawn(spawnable(argv[0], argv.slice(1)), {
    cwd: rootDir,
    env: pm2EnvBase(),
    stdout: capture ? 'pipe' : 'inherit',
    stderr: capture ? 'pipe' : 'inherit',
  })
  const out = capture ? await new Response(proc.stdout).text() : ''
  const err = capture ? await new Response(proc.stderr).text() : ''
  return { code: await proc.exited, out, err }
}

// --- questions --------------------------------------------------------------

console.log('⛵ Skeppa installer\n')

// Reuse values from an existing .env as defaults where possible.
const envPath = join(rootDir, '.env')
const existingEnv = {}
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m) existingEnv[m[1]] = m[2]
  }
}

const keyFile = resolve(expandHome(ask('Master key file', existingEnv.MASTER_KEY_FILE || '~/.skeppa/master.key')))
const dataDir = resolve(expandHome(ask('Data directory (SQLite database)', existingEnv.DATA_DIR || join(rootDir, 'data'))))
const appsDir = resolve(expandHome(ask('Apps directory (deployed apps)', existingEnv.APPS_DIR || '/srv/apps')))
const port = ask('Panel port', existingEnv.PORT || '3000')

// --- master key file --------------------------------------------------------

if (existsSync(keyFile)) {
  const key = readFileSync(keyFile, 'utf8').trim()
  if (!HEX_KEY_RE.test(key)) {
    console.error(`\n✖ ${keyFile} exists but does not contain 64 hex characters — refusing to touch it.`)
    process.exit(1)
  }
  if (statSync(keyFile).mode & 0o077) {
    chmodSync(keyFile, 0o600)
    console.log(`✔ existing master key kept (permissions tightened to 600): ${keyFile}`)
  } else {
    console.log(`✔ existing master key kept: ${keyFile}`)
  }
} else {
  // Never silently generate a key that cannot decrypt existing data: prefer a
  // key found in .env, and demand confirmation when a database already exists.
  let key = HEX_KEY_RE.test(existingEnv.MASTER_KEY || '') ? existingEnv.MASTER_KEY : null
  if (key) {
    console.log('→ moving the MASTER_KEY found in .env into the key file')
  } else if (existsSync(join(dataDir, 'skeppa.db'))) {
    console.log(`\n⚠ ${join(dataDir, 'skeppa.db')} already exists but no master key was found.`)
    console.log('  A newly generated key CANNOT decrypt the ENV values already in that database.')
    if (!askYesNo('Generate a new key anyway?', false)) {
      console.log('Aborted. Put the original key in the key file (or MASTER_KEY in .env) and re-run.')
      process.exit(1)
    }
    key = randomBytes(32).toString('hex')
  } else {
    key = randomBytes(32).toString('hex')
  }
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 })
  writeFileSync(keyFile, key + '\n', { mode: 0o600 })
  console.log(`✔ master key written to ${keyFile} (chmod 600)`)
  console.log('  ⚠ Back it up in your password manager — without it the database is unreadable, and there is no recovery.')
}

// --- directories ------------------------------------------------------------

mkdirSync(dataDir, { recursive: true })
console.log(`✔ data directory: ${dataDir}`)
let appsDirReady = true
try {
  mkdirSync(appsDir, { recursive: true })
  console.log(`✔ apps directory: ${appsDir}`)
} catch (err) {
  appsDirReady = false
  console.log(`✖ could not create ${appsDir} (${err.code}) — run this and re-check:`)
  console.log(`    sudo mkdir -p ${appsDir} && sudo chown $(whoami) ${appsDir}`)
}

// --- .env -------------------------------------------------------------------

const envContent =
  `# Generated by scripts/install.js\n` +
  `MASTER_KEY_FILE=${keyFile}\n` +
  `PORT=${port}\n` +
  `NODE_ENV=production\n` +
  `DATA_DIR=${dataDir}\n` +
  `APPS_DIR=${appsDir}\n`

if (!existsSync(envPath)) {
  writeFileSync(envPath, envContent, { mode: 0o600 })
  console.log('✔ wrote .env')
} else if (askYesNo('.env already exists — overwrite it? (a .env.bak backup is kept)', false)) {
  copyFileSync(envPath, envPath + '.bak')
  writeFileSync(envPath, envContent, { mode: 0o600 })
  console.log('✔ wrote .env (previous version in .env.bak)')
} else {
  console.log('→ keeping your .env. Make sure it contains:')
  console.log(envContent.split('\n').slice(1).filter(Boolean).map(l => `    ${l}`).join('\n'))
  if (existingEnv.MASTER_KEY) console.log('  and remove the MASTER_KEY line — the key file replaces it.')
}

// --- dependencies + frontend build -------------------------------------------

if (askYesNo('Install dependencies and build the frontend now?', true)) {
  if ((await run([process.execPath, 'install'])).code !== 0) process.exit(1)
  if ((await run([process.execPath, 'run', 'build'])).code !== 0) process.exit(1)
  console.log('✔ dependencies installed, frontend built')
}

// --- admin user -------------------------------------------------------------

const db = openDb(join(dataDir, 'skeppa.db'))
migrate(db, join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'db', 'migrations'))
if (db.query('SELECT 1 FROM users LIMIT 1').get()) {
  console.log('→ users already exist — skipping admin creation (reset with: bun scripts/seed.js <user> <password>)')
} else {
  let username
  do {
    username = ask('Admin username', 'admin')
  } while (!USERNAME_RE.test(username) && (console.log('  invalid username'), true))
  let password
  do {
    password = await askHidden(`Password for ${username} (min ${MIN_PASSWORD_LENGTH} chars)`)
  } while (password.length < MIN_PASSWORD_LENGTH && (console.log('  too short'), true))
  const hash = await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 })
  db.query('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash)
  console.log(`✔ created user "${username}"`)
}

// --- pm2 --------------------------------------------------------------------

if (!Bun.which('pm2')) {
  console.log('→ pm2 not found — install it (bun install -g pm2) and start the panel with:')
  console.log('    pm2 start ecosystem.config.cjs && pm2 save && pm2 startup')
} else if (askYesNo('Start the panel under pm2 now?', true)) {
  await startOrReload(join(rootDir, 'ecosystem.config.cjs'))
  console.log('✔ panel started (pm2 name: skeppa)')

  const others = (await jlist()).map(p => p.name).filter(n => n !== 'skeppa' && n !== 'skeppa-proxy')
  if (others.length === 0) {
    await run(['pm2', 'save'])
    console.log('✔ pm2 dump saved — it contains only the panel, no app secrets')
  } else {
    console.log(`→ skipping pm2 save: other pm2 processes are running (${others.join(', ')}).`)
    console.log('  Saving now would write their environment to ~/.pm2/dump.pm2 in plaintext.')
    console.log('  The panel restarts its own apps at boot — the dump only ever needs the panel itself.')
  }

  const startup = await run(['pm2', 'startup'], { capture: true })
  const startupOutput = (startup.out + startup.err).trim()
  if (startupOutput) {
    console.log('\nTo start pm2 (and with it the panel) at boot, pm2 says:')
    console.log(startupOutput.split('\n').map(l => `    ${l}`).join('\n'))
  }
}

// --- summary ----------------------------------------------------------------

console.log(`\nDone. The panel listens on http://localhost:${port} — put your HTTPS reverse proxy in front of it.`)
console.log('Next: log in, add the GitHub App under Settings, and create your first project (see README).')
if (!appsDirReady) console.log(`Reminder: the apps directory could not be created — fix ${appsDir} before deploying.`)
