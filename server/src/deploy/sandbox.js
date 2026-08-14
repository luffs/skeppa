import { posix } from 'node:path'
import { createContainerClient } from '../containers/client.js'

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
    `Is the rootless podman socket up for the panel user?\n` +
    `  sudo loginctl enable-linger $(whoami)\n` +
    `  systemctl --user enable --now podman.socket`
  )
  return hint
}

// Returns { exitCode, timedOut }. Throws on engine/setup failures.
export async function runScriptInContainer({ config, project, dirs, script, envVars, onLine, timeoutMs, client = null }) {
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
    id = await engine.createContainer(name, spec)
  } catch (err) {
    if (err.status == null) throw engineHint(err, engine.socketPath)
    if (err.status !== 404) throw err
    onLine(`pulling image ${image} (first use — this can take a while)`)
    await engine.pullImage(image)
    id = await engine.createContainer(name, spec)
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
