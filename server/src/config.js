import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/

// Repo root = two levels up from server/src/
export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function loadConfig({ requireMasterKey = true } = {}) {
  const env = process.env
  const masterKey = env.MASTER_KEY || ''

  if (requireMasterKey && !HEX_KEY_RE.test(masterKey)) {
    console.error(
      'FATAL: MASTER_KEY is missing or invalid. It must be 64 hex characters (32 bytes).\n' +
      '       Generate one with:  openssl rand -hex 32\n' +
      '       and put it in the panel’s .env file. Refusing to start.'
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
    selfPm2Name: env.SKEPPA_PM2_NAME || 'skeppa',
  }
}
