import { LazyWatch } from 'lazy-watch'

// Single server-side LiveState object. All mutations go through this proxy so
// lazy-watch batches them into diffs that the Hub broadcasts to WS clients.
// Log lines are deliberately NOT part of LiveState (see Hub log pub/sub).
export function createLiveState() {
  return new LazyWatch({ projects: {} })
}

export function projectDefaults(lastDeployment = null) {
  return {
    pm2: { status: 'unknown', uptime: null, memory: null, cpu: null },
    currentDeployment: null,
    lastDeployment,
    // sha of the last successful deployment; compared against headCommit.sha
    // to detect pushed-but-undeployed commits.
    deployedSha: null,
    // latest push to the project's branch as reported by the GitHub webhook.
    headCommit: null, // { sha, message, pushedAt }
  }
}

// Populate LiveState from the DB at startup.
export function initLiveState(liveState, db) {
  const projects = db.query('SELECT id, head_sha, head_message, head_pushed_at FROM projects').all()
  for (const p of projects) {
    const last = db.query(
      `SELECT id, status, finished_at, commit_sha FROM deployments
       WHERE project_id = ? AND status IN ('success', 'failed', 'cancelled')
       ORDER BY id DESC LIMIT 1`
    ).get(p.id)
    const lastSuccess = db.query(
      `SELECT commit_sha FROM deployments
       WHERE project_id = ? AND status = 'success' AND commit_sha IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    ).get(p.id)
    const live = projectDefaults(
      last
        ? { id: last.id, status: last.status, finishedAt: last.finished_at, commitSha: last.commit_sha }
        : null
    )
    live.deployedSha = lastSuccess?.commit_sha ?? null
    live.headCommit = p.head_sha
      ? { sha: p.head_sha, message: p.head_message, pushedAt: p.head_pushed_at }
      : null
    liveState.projects[p.id] = live
  }
}
