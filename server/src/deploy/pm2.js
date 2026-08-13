// Thin wrapper around the pm2 CLI via Bun.spawn (no shell, args as array).
// `spawnable` resolves .cmd shims through cmd.exe on Windows.
//
// Every call runs with a sanitized environment: pm2 injects the CLI's env into
// the processes it starts, so spawning it with the panel's own environment
// would hand MASTER_KEY & co to every deployed app. Start/reload calls take
// the app's decrypted env as `appEnv` — that is the only channel app ENV
// travels through; it is never written to the ecosystem file.
import { existsSync } from 'node:fs'
import { spawnable, pm2EnvBase } from '../lib/shell.js'
import { PM2_ACTIONS } from '../lib/validate.js'

async function pm2(args, appEnv = null) {
  const proc = Bun.spawn(spawnable('pm2', args), {
    env: { ...pm2EnvBase(), ...(appEnv ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) throw new Error(`pm2 ${args.join(' ')} failed (${code}): ${err.trim() || out.trim()}`)
  return out
}

export async function jlist() {
  const out = await pm2(['jlist'])
  // pm2 can print daemon-startup noise before the JSON array
  const start = out.indexOf('[')
  if (start === -1) return []
  return JSON.parse(out.slice(start))
}

export async function startOrReload(ecosystemFile, appEnv = null) {
  return pm2(['startOrReload', ecosystemFile, '--update-env'], appEnv)
}

// Detached variant for self-deploys: the reload may kill this very process,
// so it must not be awaited and must survive our exit.
export function startOrReloadDetached(ecosystemFile, appEnv = null) {
  Bun.spawn(spawnable('pm2', ['startOrReload', ecosystemFile, '--update-env']), {
    env: { ...pm2EnvBase(), ...(appEnv ?? {}) },
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  }).unref()
}

export async function action(act, name) {
  if (!PM2_ACTIONS.includes(act)) throw new Error(`invalid pm2 action: ${act}`)
  return pm2([act, name])
}

// start/restart go through the project's ecosystem file when there is one, so
// the current ENV set (passed as appEnv) is applied; a plain `pm2 restart`
// would keep the environment the process was originally started with.
export async function applyAction(act, name, ecosystemFile = null, appEnv = null) {
  if (!PM2_ACTIONS.includes(act)) throw new Error(`invalid pm2 action: ${act}`)
  if (act !== 'stop' && ecosystemFile && existsSync(ecosystemFile)) return startOrReload(ecosystemFile, appEnv)
  return action(act, name)
}

export async function describe(name) {
  return (await jlist()).find(p => p.name === name) ?? null
}

export async function deleteProcess(name) {
  try {
    await pm2(['delete', name])
  } catch {
    // not registered with pm2 — fine
  }
}
