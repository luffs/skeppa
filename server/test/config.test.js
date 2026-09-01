import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const KEY = 'a'.repeat(64)

// Runs fn with MASTER_KEY / MASTER_KEY_FILE / SKEPPA_CONFIG forced to the
// given values (null = unset), restoring the real environment afterwards.
// SKEPPA_CONFIG defaults to a nonexistent path so a real ~/.skeppa/config on
// the machine can never leak into the tests.
function withEnv(vars, fn) {
  const keys = ['MASTER_KEY', 'MASTER_KEY_FILE', 'SKEPPA_CONFIG']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  const applied = { SKEPPA_CONFIG: join(tmpdir(), 'skeppa-no-config-here', 'config'), ...vars }
  try {
    for (const k of keys) {
      if (applied[k] == null) delete process.env[k]
      else process.env[k] = applied[k]
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

test('an explicitly configured but missing config file warns instead of silently blanking', () => {
  const warnings = []
  const original = console.warn
  console.warn = m => warnings.push(String(m))
  try {
    const ghost = join(tmpdir(), `skeppa-cfg-ghost-${Date.now()}`, 'config')
    withEnv({ SKEPPA_CONFIG: ghost, MASTER_KEY: KEY }, () => loadConfig())
    expect(warnings.some(w => w.includes(ghost) && w.includes('does not exist'))).toBe(true)
  } finally {
    console.warn = original
  }
})

test('the panel binds loopback unless HOST widens it', () => {
  withEnv({ MASTER_KEY: KEY }, () => {
    expect(loadConfig().host).toBe('127.0.0.1')
  })
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-cfg-host-'))
  writeFileSync(join(dir, 'config'), 'HOST=0.0.0.0\n')
  withEnv({ SKEPPA_CONFIG: join(dir, 'config'), MASTER_KEY: KEY }, () => {
    expect(loadConfig().host).toBe('0.0.0.0')
  })
})

test('reads panel config from the SKEPPA_CONFIG file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-cfg-'))
  const keyPath = join(dir, 'key.hex')
  writeFileSync(keyPath, KEY + '\n')
  writeFileSync(join(dir, 'config'),
    `# panel config\nPORT=4321\nMASTER_KEY_FILE=${keyPath}\nAPPS_DIR="${join(dir, 'apps')}"\n`)
  const savedPort = process.env.PORT
  try {
    delete process.env.PORT
    withEnv({ SKEPPA_CONFIG: join(dir, 'config') }, () => {
      const config = loadConfig()
      expect(config.port).toBe(4321)
      expect(config.masterKey).toBe(KEY) // via the file's MASTER_KEY_FILE
      expect(config.appsDir).toBe(join(dir, 'apps')) // quotes stripped
    })
  } finally {
    if (savedPort == null) delete process.env.PORT
    else process.env.PORT = savedPort
  }
})

test('the process environment overrides the config file per key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-cfg-'))
  writeFileSync(join(dir, 'config'), 'PORT=4321\n')
  const savedPort = process.env.PORT
  try {
    process.env.PORT = '5555'
    withEnv({ SKEPPA_CONFIG: join(dir, 'config'), MASTER_KEY: KEY }, () => {
      expect(loadConfig().port).toBe(5555)
    })
  } finally {
    if (savedPort == null) delete process.env.PORT
    else process.env.PORT = savedPort
  }
})

test('the apps dir defaults to ~/apps — creatable without sudo', () => {
  const saved = process.env.APPS_DIR
  try {
    delete process.env.APPS_DIR
    withEnv({ MASTER_KEY: KEY }, () => {
      expect(loadConfig().appsDir).toBe(join(homedir(), 'apps'))
    })
  } finally {
    if (saved == null) delete process.env.APPS_DIR
    else process.env.APPS_DIR = saved
  }
})

test('~ expands to the home directory in path values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-cfg-'))
  writeFileSync(join(dir, 'config'), 'DATA_DIR=~/skeppa-test-data\n')
  withEnv({ SKEPPA_CONFIG: join(dir, 'config'), MASTER_KEY: KEY }, () => {
    expect(loadConfig().dataDir).toBe(join(homedir(), 'skeppa-test-data'))
  })
})

test('a master.key next to the config file is the default key source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-cfg-'))
  writeFileSync(join(dir, 'master.key'), KEY + '\n')
  // no config file, no MASTER_KEY(_FILE) anywhere — the sibling still wins
  withEnv({ SKEPPA_CONFIG: join(dir, 'config') }, () => {
    expect(loadConfig().masterKey).toBe(KEY)
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
