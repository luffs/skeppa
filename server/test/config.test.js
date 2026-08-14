import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const KEY = 'a'.repeat(64)

// Runs fn with MASTER_KEY / MASTER_KEY_FILE forced to the given values
// (null = unset), restoring the real environment afterwards.
function withEnv(vars, fn) {
  const keys = ['MASTER_KEY', 'MASTER_KEY_FILE']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  try {
    for (const k of keys) {
      if (vars[k] == null) delete process.env[k]
      else process.env[k] = vars[k]
    }
    return fn()
  } finally {
    for (const k of keys) {
      if (saved[k] == null) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const keyFile = content => {
  const file = join(mkdtempSync(join(tmpdir(), 'skeppa-key-')), 'master.key')
  writeFileSync(file, content)
  return file
}

test('reads the master key from MASTER_KEY_FILE, trimming the trailing newline', () => {
  const file = keyFile(KEY + '\n')
  withEnv({ MASTER_KEY_FILE: file }, () => {
    expect(loadConfig().masterKey).toBe(KEY)
  })
})

test('MASTER_KEY_FILE takes precedence over the MASTER_KEY env var', () => {
  const file = keyFile(KEY)
  withEnv({ MASTER_KEY_FILE: file, MASTER_KEY: 'b'.repeat(64) }, () => {
    expect(loadConfig().masterKey).toBe(KEY)
  })
})

test('falls back to the MASTER_KEY env var when no file is configured', () => {
  withEnv({ MASTER_KEY: KEY }, () => {
    expect(loadConfig().masterKey).toBe(KEY)
  })
})

test('a missing MASTER_KEY_FILE is tolerated when the key is not required (seed script)', () => {
  withEnv({ MASTER_KEY_FILE: join(tmpdir(), 'skeppa-does-not-exist.key') }, () => {
    expect(loadConfig({ requireMasterKey: false }).masterKey).toBe('')
  })
})

test('sandbox defaults to host and accepts podman', () => {
  const saved = process.env.SKEPPA_SANDBOX
  try {
    delete process.env.SKEPPA_SANDBOX
    withEnv({ MASTER_KEY: KEY }, () => {
      expect(loadConfig().sandbox).toBe('host')
    })
    process.env.SKEPPA_SANDBOX = 'podman'
    withEnv({ MASTER_KEY: KEY }, () => {
      const config = loadConfig()
      expect(config.sandbox).toBe('podman')
      expect(config.buildImage).toBe('docker.io/oven/bun:1')
    })
  } finally {
    if (saved == null) delete process.env.SKEPPA_SANDBOX
    else process.env.SKEPPA_SANDBOX = saved
  }
})
