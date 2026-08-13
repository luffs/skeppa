import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

// Deploy scripts always run through a POSIX shell so they behave the same on
// every platform. On Linux that's plain `sh`; on Windows we fall back to the
// sh.exe that ships with Git for Windows (git is required anyway).
let cachedShell = null

export function resolveShell() {
  if (cachedShell) return cachedShell
  if (process.platform !== 'win32') return (cachedShell = ['sh', '-c'])

  const sh = Bun.which('sh')
  if (sh) return (cachedShell = [sh, '-c'])

  const git = Bun.which('git')
  if (git) {
    // git.exe lives in <root>\cmd or <root>\mingw64\bin — walk up to <root>
    for (const root of [dirname(dirname(git)), dirname(dirname(dirname(git)))]) {
      for (const candidate of [join(root, 'bin', 'sh.exe'), join(root, 'usr', 'bin', 'sh.exe')]) {
        if (existsSync(candidate)) return (cachedShell = [candidate, '-c'])
      }
    }
  }
  throw new Error(
    'no POSIX shell found: deploy scripts need `sh`. Install Git for Windows (bundles sh.exe) or run the panel on Linux'
  )
}

// Smallest environment a child process can run with: PATH, HOME, and the
// handful of system variables Windows breaks without. The panel's own env
// (MASTER_KEY!) must never leak into anything it spawns.
function systemEnvBase() {
  const env = { PATH: process.env.PATH ?? '' }
  if (process.platform === 'win32') {
    for (const key of [
      'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
      'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
    ]) {
      if (process.env[key] != null) env[key] = process.env[key]
    }
    env.HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''
  } else {
    env.HOME = process.env.HOME ?? ''
  }
  return env
}

// Base environment for deploy scripts.
export function scriptEnvBase() {
  const env = { ...systemEnvBase(), CI: 'true', GIT_TERMINAL_PROMPT: '0' }
  if (process.platform !== 'win32') env.SHELL = '/bin/sh'
  return env
}

// Base environment for pm2 CLI calls. pm2 injects the CLI's environment into
// the process it starts (that is what --update-env applies), so everything
// here also ends up in the app's runtime env — keep it to what pm2 needs and
// leave out script-only flags like CI.
export function pm2EnvBase() {
  const env = systemEnvBase()
  if (process.env.PM2_HOME != null) env.PM2_HOME = process.env.PM2_HOME
  return env
}

// Windows can't CreateProcess a .cmd/.bat shim (like npm-installed pm2.cmd)
// directly — those must go through cmd.exe.
export function spawnable(executable, args) {
  const resolved = Bun.which(executable) ?? executable
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    return ['cmd', '/c', resolved, ...args]
  }
  return [resolved, ...args]
}
