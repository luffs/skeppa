import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lsRemoteHead } from '../src/deploy/git.js'

// A real local repo stands in for the remote: git ls-remote treats a path
// like a URL, so the helper is exercised end to end without the network.
async function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'skeppa-remote-'))
  const run = async args => {
    const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if ((await proc.exited) !== 0) throw new Error(`git ${args[0]} failed: ${await new Response(proc.stderr).text()}`)
  }
  await run(['init', '-b', 'main'])
  await run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'first'])
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: dir, stdout: 'pipe' })
  const sha = (await new Response(proc.stdout).text()).trim()
  return { dir, sha }
}

test('lsRemoteHead reads the branch head without cloning', async () => {
  const { dir, sha } = await fixtureRepo()
  const head = await lsRemoteHead(dir, 'main')
  expect(head.sha).toBe(sha)
  // ls-remote yields only the sha — the rest is '' by the LiveState convention
  expect(head.message).toBe('')
  expect(head.pushedAt).toBe('')
})

test('a branch the remote does not have is an error, not an empty head', async () => {
  const { dir } = await fixtureRepo()
  await expect(lsRemoteHead(dir, 'no-such-branch')).rejects.toThrow(/not found on the remote/)
})

test('an unreachable remote fails with the git error, inside the timeout', async () => {
  await expect(lsRemoteHead(join(tmpdir(), 'skeppa-definitely-absent'), 'main'))
    .rejects.toThrow(/ls-remote failed/)
})
