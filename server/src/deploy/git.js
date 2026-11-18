import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scriptEnvBase } from '../lib/shell.js'

// Clone on first deploy, then fetch + hard reset. The installation token is
// passed on the command line per invocation and never persisted into
// .git/config (fetch-by-URL; the clone's origin is scrubbed right after).
// Any git output that could contain the token is redacted before logging.
//
// `sha` pins the checkout to an earlier commit (a redeploy): the branch is
// synced as always, then the working tree is reset to that commit — fetched
// by id first if a force-push took it off the branch. The caller has checked
// it is a full sha this project deployed before (SHA_RE).
export const SHA_RE = /^[0-9a-f]{40}$/
export async function syncRepo({ dir, repoFullName, branch, token, gitUrl = null, sha = null, onLine = () => {} }) {
  if (sha != null && !SHA_RE.test(sha)) throw new Error('not a commit id')
  const cleanUrl = gitUrl || `https://github.com/${repoFullName}.git`
  const authedUrl = gitUrl || `https://x-access-token:${token}@github.com/${repoFullName}.git`
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

  if (sha) {
    const present = await git(['cat-file', '-e', `${sha}^{commit}`], dir).then(() => true, () => false)
    if (!present) {
      onLine(`fetching ${sha.slice(0, 7)}, no longer on ${branch}`)
      await git(['fetch', authedUrl, sha], dir)
    }
    await git(['reset', '--hard', sha], dir)
  }

  const head = (await git(['rev-parse', 'HEAD'], dir)).trim()
  const message = (await git(['log', '-1', '--pretty=%s'], dir)).trim()
  return { sha: head, message }
}

// The sha a branch points at on a remote, without cloning — the manual
// update check for plain-git projects, which have no webhook. The
// sanitized env sets GIT_TERMINAL_PROMPT=0, so a URL that unexpectedly
// wants credentials fails fast; the timer covers a host that just hangs.
export async function lsRemoteHead(url, branch, { timeoutMs = 15_000 } = {}) {
  const proc = Bun.spawn(['git', 'ls-remote', url, `refs/heads/${branch}`], {
    env: scriptEnvBase(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) throw new Error(`git ls-remote failed (${code}): ${(err || out).trim().slice(0, 300)}`)
    const sha = out.trim().split(/\s+/)[0] ?? ''
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`branch "${branch}" not found on the remote`)
    // ls-remote yields only the sha — '' for the rest, per the LiveState
    // string convention; the UI hides what it does not have.
    return { sha, message: '', pushedAt: '' }
  } finally {
    clearTimeout(timer)
  }
}
