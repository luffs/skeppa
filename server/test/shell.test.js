import { test, expect } from 'bun:test'
import { resolveShell, scriptEnvBase, pm2EnvBase, spawnable } from '../src/lib/shell.js'

test('resolveShell returns a shell that runs POSIX one-liners', async () => {
  const shell = resolveShell()
  const proc = Bun.spawn([...shell, 'echo one && echo two'], {
    stdout: 'pipe',
    env: scriptEnvBase(),
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(out).toContain('one')
  expect(out).toContain('two')
})

test('scriptEnvBase never leaks the panel environment', () => {
  process.env.MASTER_KEY = 'x'.repeat(64)
  try {
    const env = scriptEnvBase()
    expect(env.MASTER_KEY).toBeUndefined()
    expect(env.PATH).toBeDefined()
    expect(env.CI).toBe('true')
  } finally {
    delete process.env.MASTER_KEY
  }
})

// pm2 injects the CLI's environment into the app it starts, so this base is
// what deployed apps inherit — it must carry neither panel secrets nor
// script-only flags like CI.
test('pm2EnvBase never leaks the panel environment into apps', () => {
  process.env.MASTER_KEY = 'x'.repeat(64)
  try {
    const env = pm2EnvBase()
    expect(env.MASTER_KEY).toBeUndefined()
    expect(env.CI).toBeUndefined()
    expect(env.PATH).toBeDefined()
    expect(env.HOME).toBeDefined()
  } finally {
    delete process.env.MASTER_KEY
  }
})

test('spawnable resolves executables into a runnable argv', async () => {
  const argv = spawnable('git', ['--version'])
  const proc = Bun.spawn(argv, { stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(out).toContain('git version')
})
