import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appContainerName, appContainerSpec, resolveRunImage,
  recreateAppContainer, appLiveStats, cpuPercent,
} from '../src/containers/runtime.js'

const CONFIG = { containerSocket: '/sock', buildImage: 'docker.io/oven/bun:1' }

const project = (over = {}) => ({
  slug: 'app', cwd: null, start_command: 'bun run start', port: 4100,
  run_image: null, build_image: null, ...over,
})

const makeDirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'skeppa-rt-'))
  return { root, source: join(root, 'source'), shared: join(root, 'shared') }
}

function fakeEngine({ createMissingImage = false } = {}) {
  const calls = []
  let creates = 0
  return {
    calls,
    async removeContainer(id) { calls.push(['remove', id]) },
    async createContainer(name, spec) {
      calls.push(['create', name, spec])
      if (createMissingImage && ++creates === 1) throw Object.assign(new Error('no such image'), { status: 404 })
      return 'cid'
    },
    async startContainer(id) { calls.push(['start', id]) },
    async pullImage(ref) { calls.push(['pull', ref]) },
  }
}

test('spec: read-only source, writable shared, localhost-only port, restart policy, env in body', () => {
  const dirs = makeDirs()
  const spec = appContainerSpec(CONFIG, project({ cwd: 'web' }), dirs, { TOKEN: 'sekret', PORT: '4100' })
  expect(spec.HostConfig.Binds).toEqual([`${dirs.source}:/app:ro`, `${dirs.shared}:/data`])
  expect(spec.HostConfig.PortBindings).toEqual({ '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '4100' }] })
  expect(spec.HostConfig.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 10 })
  expect(spec.Cmd).toEqual(['/bin/sh', '-c', 'bun run start'])
  expect(spec.WorkingDir).toBe('/app/web')
  expect(spec.Env).toContain('TOKEN=sekret')
  expect(spec.Labels['skeppa.project']).toBe('app')
})

test('a project without a routed port publishes nothing', () => {
  const spec = appContainerSpec(CONFIG, project({ port: null }), makeDirs(), {})
  expect(spec.HostConfig.PortBindings).toBeUndefined()
  expect(spec.ExposedPorts).toBeUndefined()
})

test('run image falls back run_image → build_image → panel default', () => {
  expect(resolveRunImage(CONFIG, project())).toBe('docker.io/oven/bun:1')
  expect(resolveRunImage(CONFIG, project({ build_image: 'node:22' }))).toBe('node:22')
  expect(resolveRunImage(CONFIG, project({ build_image: 'node:22', run_image: 'nginx:alpine' }))).toBe('nginx:alpine')
})

test('recreate removes the old container, creates the shared dir, pulls on 404 and starts', async () => {
  const dirs = makeDirs()
  const engine = fakeEngine({ createMissingImage: true })
  await recreateAppContainer({ config: CONFIG, project: project(), dirs, env: {}, client: engine })
  expect(engine.calls.map(c => c[0])).toEqual(['remove', 'create', 'pull', 'create', 'start'])
  expect(engine.calls[0][1]).toBe(appContainerName('app'))
  expect(existsSync(dirs.shared)).toBe(true)
})

test('appLiveStats maps engine state onto the pm2 stats shape', async () => {
  const engine = {
    async inspectContainer() {
      return { RestartCount: 2, State: { Running: true, Pid: 4711, StartedAt: '2026-08-14T10:00:00Z' } }
    },
    async statsContainer() {
      return {
        memory_stats: { usage: 52_428_800 },
        cpu_stats: { cpu_usage: { total_usage: 400 }, system_cpu_usage: 10_000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 6_000 },
      }
    },
  }
  const stats = await appLiveStats(engine, 'skeppa-app-app')
  expect(stats.status).toBe('online')
  expect(stats.pid).toBe(4711)
  expect(stats.restarts).toBe(2)
  expect(stats.memory).toBe(52_428_800)
  expect(stats.cpu).toBe((200 / 4000) * 2 * 100)
  expect(stats.uptime).toBe(Date.parse('2026-08-14T10:00:00Z'))
})

test('appLiveStats: missing container → null, exited container → stopped', async () => {
  expect(await appLiveStats({ async inspectContainer() { return null } }, 'x')).toBeNull()
  const stopped = await appLiveStats(
    { async inspectContainer() { return { State: { Running: false } } } }, 'x')
  expect(stopped.status).toBe('stopped')
  expect(stopped.pid).toBeNull()
})

test('cpuPercent is defensive about missing fields', () => {
  expect(cpuPercent(null)).toBe(0)
  expect(cpuPercent({})).toBe(0)
  expect(cpuPercent({ cpu_stats: { cpu_usage: { total_usage: 100 } }, precpu_stats: { cpu_usage: { total_usage: 200 } } })).toBe(0)
})
