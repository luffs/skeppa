import { posix } from 'node:path'
import { mkdirSync } from 'node:fs'
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
