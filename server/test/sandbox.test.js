import { test, expect } from 'bun:test'
import { runScriptInContainer, buildContainerName } from '../src/deploy/sandbox.js'

const CONFIG = { containerSocket: '/run/user/1000/podman/podman.sock', buildImage: 'docker.io/oven/bun:1' }
const PROJECT = { slug: 'app', cwd: null, build_image: null, deploy_script: 'bun install' }
const DIRS = { source: '/srv/apps/app/source' }

// Fake engine capturing calls; behavior tweaked per test.
function fakeEngine({ exitCode = 0, failCreate = null, hangUntilKilled = false } = {}) {
  const calls = []
  let creates = 0
  let killed
  const killedPromise = new Promise(res => (killed = res))
  return {
    calls,
    socketPath: CONFIG.containerSocket,
    async removeContainer(id) { calls.push(['remove', id]) },
    async createContainer(name, spec) {
      calls.push(['create', name, spec])
      creates++
      if (failCreate && creates === 1) throw failCreate
      return 'cid-1'
    },
    async startContainer(id) { calls.push(['start', id]) },
    async waitContainer(id) {
      calls.push(['wait', id])
      if (hangUntilKilled) {
        await killedPromise
        return 137
      }
      return exitCode
    },
    async killContainer(id) {
      calls.push(['kill', id])
      killed()
    },
    async streamLogs(id, onLine) {
      calls.push(['logs', id])
      onLine('from container')
    },
    async pullImage(ref) { calls.push(['pull', ref]) },
  }
}

function run(engine, { project = PROJECT, timeoutMs = 5000, onLine = () => {} } = {}) {
  return runScriptInContainer({
    config: CONFIG,
    project,
    dirs: DIRS,
    script: project.deploy_script,
    envVars: { TOKEN: 'sekret' },
    onLine,
    timeoutMs,
    client: engine,
  })
}

test('runs the script in a container with only the source mounted and env in the spec', async () => {
  const engine = fakeEngine()
  const lines = []
  const { exitCode, timedOut } = await run(engine, { onLine: l => lines.push(l) })

  expect(exitCode).toBe(0)
  expect(timedOut).toBe(false)
  expect(lines).toContain('from container')

  const [, name, spec] = engine.calls.find(c => c[0] === 'create')
  expect(name).toBe(buildContainerName('app'))
  expect(spec.Image).toBe('docker.io/oven/bun:1')
  expect(spec.Cmd).toEqual(['/bin/sh', '-c', 'bun install'])
  expect(spec.Env).toContain('TOKEN=sekret')
  expect(spec.Env).toContain('CI=true')
  expect(spec.HostConfig.Binds).toEqual(['/srv/apps/app/source:/work'])
  expect(spec.WorkingDir).toBe('/work')
  // ephemeral: removed before create (leftovers) and after the run
  expect(engine.calls.filter(c => c[0] === 'remove').length).toBe(2)
})

test('honors the project build image and cwd', async () => {
  const engine = fakeEngine()
  await run(engine, { project: { ...PROJECT, build_image: 'node:22', cwd: 'web' } })
  const [, , spec] = engine.calls.find(c => c[0] === 'create')
  expect(spec.Image).toBe('node:22')
  expect(spec.WorkingDir).toBe('/work/web')
})

test('pulls the image and retries when the engine reports 404', async () => {
  const notFound = Object.assign(new Error('no such image'), { status: 404 })
  const engine = fakeEngine({ failCreate: notFound })
  const { exitCode } = await run(engine)
  expect(exitCode).toBe(0)
  const order = engine.calls.map(c => c[0])
  expect(order).toEqual(['remove', 'create', 'pull', 'create', 'start', 'wait', 'logs', 'remove'])
})

test('a connection failure becomes a hint about the podman socket, not a silent host run', async () => {
  const engine = fakeEngine({ failCreate: new Error('connect ENOENT /run/user/1000/podman/podman.sock') })
  await expect(run(engine)).rejects.toThrow(/podman\.socket/)
})

test('timeout kills the container, reports timedOut and still removes it', async () => {
  const engine = fakeEngine({ hangUntilKilled: true })
  const { timedOut } = await run(engine, { timeoutMs: 20 })
  expect(timedOut).toBe(true)
  const order = engine.calls.map(c => c[0])
  expect(order).toContain('kill')
  expect(order[order.length - 1]).toBe('remove')
})

test('nonzero exit codes pass through', async () => {
  const engine = fakeEngine({ exitCode: 2 })
  const { exitCode, timedOut } = await run(engine)
  expect(exitCode).toBe(2)
  expect(timedOut).toBe(false)
})
