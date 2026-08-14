import { join, resolve, dirname } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/

// Repo root = two levels up from server/src/
export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The master key preferably comes from MASTER_KEY_FILE — a chmod-600 file
// holding 64 hex chars, living outside the repo, DATA_DIR and APPS_DIR so no
// deploy, git tree or database backup ever includes it. The plain MASTER_KEY
// env var still works (mainly for development) but puts the key in the
// process environment, where pm2 tooling and /proc can see it.
function readMasterKey(env, required) {
  if (!env.MASTER_KEY_FILE) return env.MASTER_KEY || ''

  let key = ''
  try {
    key = readFileSync(env.MASTER_KEY_FILE, 'utf8').trim()
  } catch (err) {
    if (required) {
      console.error(`FATAL: cannot read MASTER_KEY_FILE (${env.MASTER_KEY_FILE}): ${err.message}`)
      process.exit(1)
    }
    return ''
  }
  if (process.platform !== 'win32') {
    try {
      if (statSync(env.MASTER_KEY_FILE).mode & 0o077) {
        console.warn(
          `warning: ${env.MASTER_KEY_FILE} is readable by group/others — run: chmod 600 ${env.MASTER_KEY_FILE}`
        )
      }
    } catch {
      // stat raced against deletion — the read above already succeeded
    }
  }
  return key
}

// Where deploy scripts run: on the host (legacy) or inside a throwaway
// rootless-podman container. A typo here must never silently mean "no
// sandbox", so anything unknown is fatal.
const SANDBOXES = ['host', 'podman']

export function loadConfig({ requireMasterKey = true } = {}) {
  const env = process.env
  const masterKey = readMasterKey(env, requireMasterKey)

  const sandbox = env.SKEPPA_SANDBOX || 'host'
  if (!SANDBOXES.includes(sandbox)) {
    console.error(`FATAL: SKEPPA_SANDBOX must be one of: ${SANDBOXES.join(', ')} (got "${sandbox}"). Refusing to start.`)
    process.exit(1)
  }
  const runtimeDir = env.XDG_RUNTIME_DIR ||
    (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null)

  if (requireMasterKey && !HEX_KEY_RE.test(masterKey)) {
    console.error(
      'FATAL: no valid master key. It must be 64 hex characters (32 bytes).\n' +
      '       Generate one with:  mkdir -p ~/.skeppa && openssl rand -hex 32 > ~/.skeppa/master.key && chmod 600 ~/.skeppa/master.key\n' +
      '       and point MASTER_KEY_FILE at it in the panel’s .env (or set MASTER_KEY directly, dev only).\n' +
      '       Refusing to start.'
    )
    process.exit(1)
  }

  return {
    port: Number(env.PORT || 3000),
    isProd: env.NODE_ENV === 'production',
    masterKey,
    dataDir: resolve(env.DATA_DIR || join(rootDir, 'data')),
    appsDir: resolve(env.APPS_DIR || '/srv/apps'),
    webDist: join(rootDir, 'web', 'dist'),
    deployTimeoutMs: Number(env.DEPLOY_TIMEOUT_MS || 10 * 60 * 1000),
    sandbox,
    // Podman's rootless user socket; rootless Docker's socket is wire-compatible.
    containerSocket: env.CONTAINER_SOCKET || (runtimeDir ? join(runtimeDir, 'podman', 'podman.sock') : null),
    buildImage: env.BUILD_IMAGE || 'docker.io/oven/bun:1',
    selfPm2Name: env.SKEPPA_PM2_NAME || 'skeppa',
    isSecureCookie: env.SKEPPA_SECURE_COOKIE !== 'false',
    skeppaApi: env.SKEPPA_API,
  }
}
