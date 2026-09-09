import { LazyWatch } from 'lazy-watch'
import { getSetting } from '../db/settings.js'
import { imagesDefaults } from './images.js'

// Single server-side LiveState object. All mutations go through this proxy so
// lazy-watch batches them into diffs that the Hub broadcasts to WS clients.
// Log lines are deliberately NOT part of LiveState (see Hub log pub/sub).
export function createLiveState() {
  return new LazyWatch({
    projects: {},
    system: {},
    users: {},
    proxy: {},
    images: imagesDefaults()
  })
}

// The routing facts the frontend needs to build "open the app" links. The
// full harbor gate status (caddy process, routes, errors) stays on
// /api/proxy — it costs a pm2 call and only the settings view wants it.
// Empty string rather than null for "no routing": in lazy-watch diffs null
// means "key removed", so a null would never reach clients as a change.
export function getProxyInfo(db) {
  return { baseDomain: getSetting(db, 'proxy_base_domain') ?? '' }
}

// The user row as rendered by the frontend (crew list). Never includes the
// password hash.
export const USER_INFO_COLUMNS = 'id, username, role, handle, domain, created_at'

export function getUserInfo(db, id) {
  return db.query(`SELECT ${USER_INFO_COLUMNS} FROM users WHERE id = ?`).get(Number(id)) ?? null
}

// The project row as rendered by the frontend (dashboard cards, project
// header, settings form). head_* is deliberately excluded — the live
// `headCommit` is the single source of truth for that.
export const PROJECT_INFO_COLUMNS =
  'id, slug, name, owner_id, repo_full_name, git_url, branch, deploy_script, build_image, run_image, runtime, pm2_name, start_command, cwd, auto_deploy, write_env_file, build_env, subdomain, port, memory_mb, network_profile, host_access, networks, created_at'

// Joined with the owner so the client can build tenant-nested app URLs
// (subdomain.handle.base) without a lookup; '' for the admin/legacy case,
// per the LiveState string convention.
const PROJECT_INFO_SELECT = `SELECT ${PROJECT_INFO_COLUMNS.split(', ').map(c => 'p.' + c).join(', ')},
  COALESCE(u.role, '') AS owner_role, COALESCE(u.handle, '') AS owner_handle, COALESCE(u.domain, '') AS owner_domain
  FROM projects p LEFT JOIN users u ON u.id = p.owner_id`

export function getProjectInfo(db, id) {
  return db.query(`${PROJECT_INFO_SELECT} WHERE p.id = ?`).get(Number(id)) ?? null
}

// The tail of the deployment history the dashboard's ship's log renders. It
// lives in LiveState so the dashboard needs no request of its own — one
// /deployments call per project on every visit was the alternative — and so
// the log updates as deploys queue, start and finish. The full history (with
// logs and commit messages) stays on /api/projects/:id/deployments.
export const RECENT_DEPLOYMENTS_LIMIT = 5

export function getRecentDeployments(db, projectId) {
  return db.query(
    `SELECT id, status, "trigger", commit_sha, started_at, finished_at, created_at
     FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?`
  ).all(Number(projectId), RECENT_DEPLOYMENTS_LIMIT).map(d => ({
    id: d.id,
    status: d.status,
    trigger: d.trigger,
    commitSha: d.commit_sha,
    startedAt: d.started_at,
    finishedAt: d.finished_at,
    createdAt: d.created_at,
  }))
}

export function projectDefaults(lastDeployment = null, info = null) {
  return {
    info,
    pm2: { status: 'unknown', uptime: null, memory: null, cpu: null },
    currentDeployment: null,
    lastDeployment,
    recentDeployments: [],
    // sha of the last successful deployment; compared against headCommit.sha
    // to detect pushed-but-undeployed commits.
    deployedSha: null,
    // latest push to the project's branch as reported by the GitHub webhook.
    headCommit: null, // { sha, message, pushedAt }
  }
}

// Populate LiveState from the DB at startup. The image section's engine half
// (the local store) stays empty until the poller's first pass — it needs the
// container engine, and boot must not wait on it.
export function initLiveState(liveState, db, config = {}) {
  liveState.proxy = getProxyInfo(db)
  liveState.images = imagesDefaults(db, config)
  for (const user of db.query(`SELECT ${USER_INFO_COLUMNS} FROM users`).all()) {
    liveState.users[user.id] = user
  }
  const projects = db.query(
    `${PROJECT_INFO_SELECT.replace(' FROM projects', ', p.head_sha, p.head_message, p.head_pushed_at FROM projects')}`
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
    live.recentDeployments = getRecentDeployments(db, info.id)
    live.deployedSha = lastSuccess?.commit_sha ?? null
    live.headCommit = head_sha
      ? { sha: head_sha, message: head_message, pushedAt: head_pushed_at }
      : null
    liveState.projects[info.id] = live
  }
}
