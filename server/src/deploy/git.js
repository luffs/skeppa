import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scriptEnvBase } from '../lib/shell.js'

// Clone on first deploy, then fetch + hard reset. The installation token is
// passed on the command line per invocation and never persisted into
// .git/config (fetch-by-URL; the clone's origin is scrubbed right after).
// Any git output that could contain the token is redacted before logging.
export async function syncRepo({ dir, repoFullName, branch, token, onLine = () => {} }) {
  const cleanUrl = `https://github.com/${repoFullName}.git`
  const authedUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`
  const redact = s => (token ? String(s).split(token).join('***') : String(s))

  const git = async (args, cwd) => {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      // Sanitized env, not the panel's own (scriptEnvBase sets
      // GIT_TERMINAL_PROMPT=0 and keeps HOME so ~/.gitconfig still applies).
      env: scriptEnvBase(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) {
      throw new Error(redact(`git ${args[0]} failed (${code}): ${(err || out).trim()}`))
    }
    return out
  }

  if (!existsSync(join(dir, '.git'))) {
    onLine(`cloning ${cleanUrl} (branch ${branch})`)
    await git(['clone', '--branch', branch, '--single-branch', authedUrl, dir])
    await git(['remote', 'set-url', 'origin', cleanUrl], dir)
  } else {
    onLine(`fetching ${cleanUrl} ${branch}`)
    await git(['fetch', authedUrl, branch], dir)
    await git(['reset', '--hard', 'FETCH_HEAD'], dir)
  }

  const sha = (await git(['rev-parse', 'HEAD'], dir)).trim()
  const message = (await git(['log', '-1', '--pretty=%s'], dir)).trim()
  return { sha, message }
}
