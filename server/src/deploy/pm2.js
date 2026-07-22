// Thin wrapper around the pm2 CLI via Bun.spawn (no shell, args as array).

async function pm2(args) {
  const proc = Bun.spawn(['pm2', ...args], { stdout: 'pipe', stderr: 'pipe' })
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

export async function startOrReload(ecosystemFile) {
  return pm2(['startOrReload', ecosystemFile, '--update-env'])
}

// Detached variant for self-deploys: the reload may kill this very process,
// so it must not be awaited and must survive our exit.
export function startOrReloadDetached(ecosystemFile) {
  Bun.spawn(['pm2', 'startOrReload', ecosystemFile, '--update-env'], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  }).unref()
}

export async function action(act, name) {
  if (!['start', 'stop', 'restart'].includes(act)) throw new Error(`invalid pm2 action: ${act}`)
  return pm2([act, name])
}

export async function deleteProcess(name) {
  try {
    await pm2(['delete', name])
  } catch {
    // not registered with pm2 — fine
  }
}
