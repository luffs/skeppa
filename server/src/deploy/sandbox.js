import { posix } from 'node:path'
import { userInfo } from 'node:os'
import { createContainerClient } from '../containers/client.js'
import { createContainerEnsuringImage } from '../containers/images.js'

// Runs a deploy script inside a throwaway rootless container instead of on
// the host: only the project's source directory is mounted (at /work), so a
// malicious script cannot reach the master key file, the database, other
// apps or the panel user's home. Rootless engines map container-root to the
// panel user, so files the build writes land on the host with the right
// owner. There is deliberately NO fallback to host execution — if the engine
// is unreachable the deploy fails loudly rather than running unsandboxed.

export function buildContainerName(slug) {
  return `skeppa-build-${slug}`
}

function engineHint(err, socketPath) {
  const hint = new Error(
    `container engine unreachable at ${socketPath}: ${err.message}\n` +
    `Is the rootless podman socket up for the panel user? As an admin, run:\n` +
    `  sudo loginctl enable-linger ${userInfo().username}\n` +
    `  sudo systemctl --user -M ${userInfo().username}@ enable --now podman.socket`
  )
  return hint
}

// Returns { exitCode, timedOut }. Throws on engine/setup failures. `db`
// enables rebuild-from-Shipyard when a managed build image is missing.
export async function runScriptInContainer({ config, project, dirs, script, envVars, onLine, timeoutMs, client = null, db = null }) {
  if (!config.containerSocket) {
    throw new Error('no container socket path available — set CONTAINER_SOCKET in the panel .env')
  }
  const engine = client ?? createContainerClient({ socketPath: config.containerSocket })
  const image = project.build_image?.trim() || config.buildImage
  const name = buildContainerName(project.slug)

  // The container gets ONLY the project env plus script conveniences — the
  // image supplies its own PATH/HOME. Values travel in the create body (RAM).
  const env = { CI: 'true', GIT_TERMINAL_PROMPT: '0', ...envVars }
  const spec = {
    Image: image,
    Cmd: ['/bin/sh', '-c', script],
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    WorkingDir: posix.join('/work', (project.cwd ?? '').replaceAll('\\', '/')),
    HostConfig: { Binds: [`${dirs.source}:/work`] },
  }

  await engine.removeContainer(name) // leftover from a crashed earlier deploy
  let id
  try {
    id = await createContainerEnsuringImage({ engine, name, spec, db, onLine })
  } catch (err) {
    if (err.status == null && !err.friendly) throw engineHint(err, engine.socketPath)
    throw err
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    engine.killContainer(id)
  }, timeoutMs)
  try {
    await engine.startContainer(id)
    const [exitCode] = await Promise.all([
      engine.waitContainer(id),
      // Logs are best-effort; the exit code is authoritative.
      engine.streamLogs(id, onLine).catch(() => {}),
    ])
    return { exitCode, timedOut }
  } finally {
    clearTimeout(timer)
    await engine.removeContainer(id)
  }
}
