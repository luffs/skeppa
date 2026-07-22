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
  }
}

// Populate LiveState from the DB at startup.
export function initLiveState(liveState, db) {
  const projects = db.query('SELECT id FROM projects').all()
  for (const { id } of projects) {
    const last = db.query(
      `SELECT id, status, finished_at, commit_sha FROM deployments
       WHERE project_id = ? AND status IN ('success', 'failed', 'cancelled')
       ORDER BY id DESC LIMIT 1`
    ).get(id)
    liveState.projects[id] = projectDefaults(
      last
        ? { id: last.id, status: last.status, finishedAt: last.finished_at, commitSha: last.commit_sha }
        : null
    )
  }
}
