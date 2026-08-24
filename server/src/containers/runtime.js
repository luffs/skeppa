import { posix, join } from 'node:path'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { createContainerClient } from './client.js'
import { createContainerEnsuringImage } from './images.js'

// App containers ("container" runtime): stateless and rebuilt on every deploy.
// The git working copy is mounted read-only at /app, the durable shared/ dir
// writable at /data, the routed port is published on localhost only, and the
// env travels in the create request body — the container inherits nothing
// from the host. Crash restarts are the engine's job (on-failure, capped like
// pm2's max_restarts); starting at boot stays panel-driven (deploy/resurrect
// honoring auto_start), so "stopped stays stopped" works the same as for pm2.

export function appContainerName(slug) {
  return `skeppa-app-${slug}`
}

export function resolveRunImage(config, project) {
  return project.run_image?.trim() || project.build_image?.trim() || config.buildImage
}

const MB = 1024 * 1024

export function appContainerSpec(config, project, dirs, env) {
  const port = project.port
  return {
    Image: resolveRunImage(config, project),
    Cmd: ['/bin/sh', '-c', project.start_command],
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    WorkingDir: posix.join('/app', (project.cwd ?? '').replaceAll('\\', '/')),
    Labels: { 'skeppa.project': project.slug },
    ...(port ? { ExposedPorts: { [`${port}/tcp`]: {} } } : {}),
    HostConfig: {
      Binds: [`${dirs.source}:/app:ro`, `${dirs.shared}:/data`],
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 10 },
      // Hard cap, swap included: past the limit the app is OOM-killed and the
      // restart policy brings it back — a leak crashes one project instead of
      // starving the host. No limit set means no cap, as before.
      ...(project.memory_mb
        ? { Memory: project.memory_mb * MB, MemorySwap: project.memory_mb * MB }
        : {}),
      ...(port
        ? { PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] } }
        : {}),
    },
  }
}

// Remove-and-create: containers are disposable, the DB + shared/ carry all
// state. A missing image is pulled — or, for Shipyard-managed refs when `db`
// is given, rebuilt from its stored Containerfile. Returns the container id.
export async function recreateAppContainer({ config, project, dirs, env, onLine = () => {}, client = null, db = null }) {
  const engine = client ?? createContainerClient({ socketPath: config.containerSocket })
  const name = appContainerName(project.slug)
  const spec = appContainerSpec(config, project, dirs, env)
  mkdirSync(dirs.shared, { recursive: true })

  await capturePreviousLogs(engine, name, dirs, onLine)
  await engine.removeContainer(name)
  const id = await createContainerEnsuringImage({ engine, name, spec, db, onLine })
  await engine.startContainer(id)
  return id
}

// CPU percentage from one Docker stats sample (delta vs precpu), defensive
// against fields podman may omit.
export function cpuPercent(stats) {
  const cpu = stats?.cpu_stats
  const pre = stats?.precpu_stats
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0)
  const sysDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0)
  if (cpuDelta <= 0 || sysDelta <= 0) return 0
  return (cpuDelta / sysDelta) * (cpu?.online_cpus || 1) * 100
}

// The container's stats in the same shape the poller reports for pm2
// processes, so LiveState and the UI need no second vocabulary. Returns null
// when the container does not exist ("not started").
export async function appLiveStats(engine, name) {
  const inspect = await engine.inspectContainer(name)
  if (!inspect) return null
  const state = inspect.State ?? {}
  const status = state.Running ? 'online' : state.Restarting ? 'launching' : 'stopped'
  let memory = null
  let cpu = null
  if (state.Running) {
    const stats = await engine.statsContainer(name).catch(() => null)
    if (stats) {
      memory = stats.memory_stats?.usage ?? null
      cpu = cpuPercent(stats)
    }
  }
  return {
    status,
    uptime: state.Running && state.StartedAt ? Date.parse(state.StartedAt) : null,
    memory,
    cpu,
    restarts: inspect.RestartCount ?? null,
    pid: state.Running ? state.Pid ?? null : null,
  }
}

// Recent container logs in the exact response shape the pm2 log routes
// return, so one UI component fits both runtimes. A container that does not
// exist yet reports `missing` streams instead of failing the request.
export async function appLogResponse(engine, name, lines) {
  const wrap = (text, missing = false) => ({
    path: null,
    text,
    truncated: text ? text.split('\n').length >= lines : false,
    missing,
  })
  try {
    const { out, err } = await engine.tailLogs(name, lines)
    return { name, lines, out: wrap(out), err: wrap(err) }
  } catch (err) {
    if (err.status !== 404) throw err
    return { name, lines, out: wrap('', true), err: wrap('', true) }
  }
}

// The tail of the outgoing container's output, written next to source/ and
// shared/ before the recreate deletes it with the container — the only
// post-mortem there is for "it crashed and then I deployed". One file,
// overwritten each time: the previous container, nothing older. Best-effort
// by design; a missing container or unreadable logs must never block the
// deploy itself.
export async function capturePreviousLogs(engine, name, dirs, onLine = () => {}) {
  let tail
  try {
    tail = await engine.tailLogs(name, 2000)
  } catch {
    return null // no previous container — nothing to save
  }
  if (!tail.out && !tail.err) return null
  const file = join(dirs.root, 'container.prev.log')
  try {
    writeFileSync(file, [
      `==== ${name} · captured ${new Date().toISOString()}, before recreate ====`,
      '---- stdout ----',
      tail.out,
      '---- stderr ----',
      tail.err,
      '',
    ].join('\n'), { mode: 0o600 })
  } catch {
    return null
  }
  // The mode above only applies when writeFileSync creates the file, so a
  // log written before this existed keeps its old bits without the chmod.
  // App output routinely carries secrets, and APPS_DIR is world-readable
  // under a default umask.
  try { chmodSync(file, 0o600) } catch { /* not a thing on Windows */ }
  onLine('previous container logs saved to container.prev.log')
  return file
}
