// What a GitHub push does here, whoever delivered it: GitHub itself (the
// webhook route, signature checked) or the master this panel reports to
// (agent/uplink.js `push`, which forwards the push events of its own App).
//
// `payload` is GitHub's push shape, or the slice of it the master forwards
// (pushSlice): repository.full_name, ref, after, deleted, head_commit.
// Every push updates the recorded head commit, so the UI can show
// pushed-but-undeployed commits; a deploy only runs with auto_deploy on.
export function applyPush({ db, liveState, runner, github = null }, payload) {
  if (payload?.deleted) return { matched: 0, queued: 0, ignored: 'branch deleted' }
  const repo = payload?.repository?.full_name
  const ref = payload?.ref
  if (repo && payload.head_commit?.timestamp) {
    github?.notePush?.(repo, new Date(payload.head_commit.timestamp).toISOString())
  }
  const matches = db.query('SELECT id, branch, auto_deploy FROM projects WHERE repo_full_name = ?').all(repo ?? '')
    .filter(p => ref === `refs/heads/${p.branch}`)

  const commitSha = payload.after ?? null
  const commitMessage = payload.head_commit?.message?.split('\n')[0] ?? null
  const pushedAt = payload.head_commit?.timestamp ?? new Date().toISOString()

  if (commitSha) {
    for (const p of matches) {
      db.query('UPDATE projects SET head_sha = ?, head_message = ?, head_pushed_at = ? WHERE id = ?')
        .run(commitSha, commitMessage, pushedAt, p.id)
      const live = liveState?.projects[p.id]
      if (live) live.headCommit = { sha: commitSha, message: commitMessage, pushedAt }
    }
  }

  const toDeploy = matches.filter(p => p.auto_deploy)
  queueMicrotask(() => {
    for (const p of toDeploy) {
      try {
        runner.enqueue(p.id, { trigger: 'webhook', commitSha, commitMessage })
      } catch (err) {
        console.error('push enqueue failed:', err)
      }
    }
  })
  return { matched: matches.length, queued: toDeploy.length }
}

// The part of a push an agent needs — no sender, no pusher's email, no
// commit list. The first line of the head commit's message is all it keeps.
export function pushSlice(payload) {
  const message = typeof payload?.head_commit?.message === 'string' ? payload.head_commit.message.split('\n')[0].slice(0, 500) : null
  return {
    repository: { full_name: String(payload?.repository?.full_name ?? '') },
    ref: String(payload?.ref ?? ''),
    after: typeof payload?.after === 'string' ? payload.after : null,
    deleted: Boolean(payload?.deleted),
    head_commit: payload?.head_commit
      ? { message, timestamp: typeof payload.head_commit.timestamp === 'string' ? payload.head_commit.timestamp : null }
      : null,
  }
}
