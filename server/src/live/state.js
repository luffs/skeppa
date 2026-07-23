import { LazyWatch } from 'lazy-watch'

// Single server-side LiveState object. All mutations go through this proxy so
// lazy-watch batches them into diffs that the Hub broadcasts to WS clients.
// Log lines are deliberately NOT part of LiveState (see Hub log pub/sub).
export function createLiveState() {
  return new LazyWatch({ projects: {}, system: {} })
}

// The project row as rendered by the frontend (dashboard cards, project
// header, settings form). head_* is deliberately excluded — the live
// `headCommit` is the single source of truth for that.
export const PROJECT_INFO_COLUMNS =
  'id, slug, name, repo_full_name, branch, deploy_script, pm2_name, start_command, cwd, auto_deploy, created_at'

export function getProjectInfo(db, id) {
  return db.query(`SELECT ${PROJECT_INFO_COLUMNS} FROM projects WHERE id = ?`).get(Number(id)) ?? null
}

export function projectDefaults(lastDeployment = null, info = null) {
  return {
    info,
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
  const projects = db.query(
    `SELECT ${PROJECT_INFO_COLUMNS}, head_sha, head_message, head_pushed_at FROM projects`
  ).all()
  for (const { head_sha, head_message, head_pushed_at, ...info } of projects) {
    const last = db.query(
      `SELECT id, status, finished_at, commit_sha FROM deployments
       WHERE project_id = ? AND status IN ('success', 'failed', 'cancelled')
       ORDER BY id DESC LIMIT 1`
    ).get(info.id)
    const lastSuccess = db.query(
      `SELECT commit_sha FROM deployments
       WHERE project_id = ? AND status = 'success' AND commit_sha IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    ).get(info.id)
    const live = projectDefaults(
      last
        ? { id: last.id, status: last.status, finishedAt: last.finished_at, commitSha: last.commit_sha }
        : null,
      info
    )
    live.deployedSha = lastSuccess?.commit_sha ?? null
    live.headCommit = head_sha
      ? { sha: head_sha, message: head_message, pushedAt: head_pushed_at }
      : null
    liveState.projects[info.id] = live
  }
}
