import { test, expect } from 'bun:test'
import { collectContainers, containerName, portLabels, stateToStatus } from '../src/live/containers.js'

// A fake engine serving one listing plus per-container inspect/stats, the way
// the poller uses it.
function fakeEngine(list, details = {}) {
  return {
    async listContainers() { return list },
    async inspectContainer(name) { return details[name]?.inspect ?? null },
    async statsContainer(name) {
      const stats = details[name]?.stats
      if (!stats) throw new Error('no stats')
      return stats
    },
  }
}

const entry = (name, extra = {}) => ({
  Names: [`/${name}`],
  Image: 'localhost/skeppa/bun:latest',
  State: 'running',
  Created: 1_700_000_000,
  Ports: [],
  Labels: {},
  ...extra,
})

const inspect = (extra = {}) => ({
  State: { Running: true, StartedAt: '2026-08-20T10:00:00.000Z', Pid: 4242 },
  RestartCount: 2,
  ...extra,
})

test('strips the leading slash the engine puts on container names', () => {
  expect(containerName({ Names: ['/skeppa-app-blog'] })).toBe('skeppa-app-blog')
  expect(containerName({ Names: ['blog'] })).toBe('blog')
  expect(containerName({})).toBe('')
})

test('maps engine state onto the status vocabulary the badge knows', () => {
  expect(stateToStatus('running')).toBe('online')
  expect(stateToStatus('restarting')).toBe('launching')
  expect(stateToStatus('exited')).toBe('stopped')
  expect(stateToStatus('paused')).toBe('stopped')
  expect(stateToStatus('')).toBe('unknown')
})

test('port labels: localhost folds away, mappings collapse, unpublished drop', () => {
  expect(portLabels({ Ports: [
    // the v4/v6 halves of one localhost publish become one plain label
    { IP: '127.0.0.1', PrivatePort: 4100, PublicPort: 4100, Type: 'tcp' },
    { IP: '::', PrivatePort: 4100, PublicPort: 4100, Type: 'tcp' },
    // EXPOSE without publish is unreachable from the host — not listed
    { PrivatePort: 9000, Type: 'tcp' },
    // a real mapping keeps the arrow, an unusual bind address its prefix
    { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 8080, Type: 'tcp' },
  ] })).toEqual(['0.0.0.0:8080→3000/tcp', '4100/tcp'])
})

test('joins the listing with per-container stats', async () => {
  const engine = fakeEngine(
    [entry('skeppa-app-blog', {
      Labels: { 'skeppa.project': 'blog' },
      Ports: [{ IP: '127.0.0.1', PrivatePort: 4100, PublicPort: 4100, Type: 'tcp' }],
    })],
    {
      'skeppa-app-blog': {
        inspect: inspect(),
        stats: {
          memory_stats: { usage: 100 * 1024 * 1024 },
          cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 1 },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        },
      },
    }
  )
  const { containers, error } = await collectContainers(engine)
  expect(error).toBe('')
  expect(containers['skeppa-app-blog']).toEqual({
    status: 'online',
    uptime: Date.parse('2026-08-20T10:00:00.000Z'),
    memory: 100 * 1024 * 1024,
    cpu: 10,
    restarts: 2,
    pid: 4242,
    image: 'localhost/skeppa/bun:latest',
    state: 'running',
    createdAt: 1_700_000_000_000,
    ports: ['4100/tcp'],
    slug: 'blog',
  })
})

test('a container the panel did not create carries no slug', async () => {
  const engine = fakeEngine([entry('postgres', { State: 'exited', Image: 'docker.io/postgres:16' })])
  const { containers } = await collectContainers(engine)
  expect(containers.postgres.slug).toBe('')
  expect(containers.postgres.status).toBe('stopped')
  expect(containers.postgres.pid).toBe(null)
})

test('the listing still describes a container whose inspect fails', async () => {
  const engine = fakeEngine([entry('vanishing')])
  engine.inspectContainer = async () => { throw new Error('gone mid-tick') }
  const { containers } = await collectContainers(engine)
  expect(containers.vanishing.status).toBe('online')
  expect(containers.vanishing.memory).toBe(null)
})

test('an unreachable engine reports no listing at all, not an empty one', async () => {
  const engine = { async listContainers() { throw new Error('socket refused') } }
  expect(await collectContainers(engine)).toEqual({ containers: null, error: 'socket refused' })
  expect(await collectContainers(null)).toEqual({
    containers: null,
    error: 'no container engine socket configured',
  })
})
