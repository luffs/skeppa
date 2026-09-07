import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { encrypt, decrypt } from '../lib/crypto.js'
import { slugify, validateProject, SLUG_RE, ENV_KEY_RE, PM2_ACTIONS } from '../lib/validate.js'
import { projectDefaults, getProjectInfo } from '../live/state.js'
import { syncManagedImages } from '../live/images.js'
import { deleteProcess, describe } from '../deploy/pm2.js'
import { lsRemoteHead } from '../deploy/git.js'
import { projectDirs, syncEnvFiles, writeEcosystem } from '../deploy/envfiles.js'
import { createContainerClient } from '../containers/client.js'
import { appContainerName, appLogResponse, previousLogResponse } from '../containers/runtime.js'
import { applyProjectAction } from '../deploy/control.js'
import { tailFile } from '../lib/tail.js'
import { proxySettings } from '../proxy/index.js'

const PROJECT_COLUMNS =
  'id, slug, name, repo_full_name, git_url, branch, deploy_script, build_image, run_image, runtime, pm2_name, start_command, cwd, ' +
  'auto_deploy, write_env_file, build_env, subdomain, port, memory_mb, network_profile, host_access, networks, head_sha, head_message, head_pushed_at, created_at'

const DEFAULT_LOG_LINES = 200
const MAX_LOG_LINES = 2000
const NAME_MAX = 63

// Suffixes -2, -3, … until the name is free. The base is trimmed so the
// suffix always fits: a name already at the length limit would otherwise
// truncate back to itself and spin forever.
function uniqueName(base, taken) {
  let candidate = base
  for (let n = 2; taken(candidate); n++) {
    const suffix = `-${n}`
    candidate = base.slice(0, NAME_MAX - suffix.length) + suffix
  }
  return candidate
}

export function projectRoutes({ db, config, liveState, runner, poller, github, proxy = null, containerClient = null }) {
  const app = new Hono()

  // Lazy so pm2-only installs never touch the socket; throws a useful message
  // when a container action is attempted without an engine configured.
  let engineInstance = containerClient
  const engine = () => {
    if (!engineInstance) {
      if (!config.containerSocket) {
        throw new Error('no container engine socket configured — see the build sandbox section in the README')
      }
      engineInstance = createContainerClient({ socketPath: config.containerSocket })
    }
    return engineInstance
  }

  // Projects travel with their owner's role and handle: the deploy runner,
  // convoy naming and container recreation all key off them.
  const PROJECT_SELECT = `SELECT ${PROJECT_COLUMNS.split(', ').map(col => 'p.' + col).join(', ')}, p.owner_id,
    u.role AS owner_role, u.handle AS owner_handle
    FROM projects p LEFT JOIN users u ON u.id = p.owner_id`
  const getProject = id => db.query(`${PROJECT_SELECT} WHERE p.id = ?`).get(Number(id))

  // 404 rather than 403 for someone else's project: a tenant probing ids
  // must not learn which exist. No user in context (bare factory in tests)
  // behaves as admin — the mounted app always attaches one.
  const getProjectFor = c => {
    const project = getProject(c.req.param('id'))
    const user = c.get('user')
    if (project && user && user.role !== 'admin' && project.owner_id !== user.id) return null
    return project
  }

  const normalizeSubdomain = value =>
    typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
  const normalizeNumber = value => (value == null || value === '' ? null : Number(value))

  // A project left without a port gets <harbor gate listen port> + id: unique
  // by construction, stable across edits (clearing the field brings the same
  // number back), and the whole port neighborhood reads as one block — the
  // gate on its port, project 7 right above it. The base is a seed, not an
  // invariant: assigned ports are stored, so changing the listen port later
  // only moves where NEW projects land. Bumps past ports claimed by hand.
  const autoPort = (db_, id) => {
    const taken = new Set(
      db_.query('SELECT port FROM projects WHERE port IS NOT NULL AND id != ?').all(id).map(r => r.port)
    )
    let port = proxySettings(db_).httpPort + id
    while (taken.has(port)) port++
    return port
  }
  const normalizeImage = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

  // Field errors for subdomain/port collisions with other projects.
  // A tenant's public names live under their handle, so bob's "app" and
  // eve's "app" are different hosts — collisions only exist inside one
  // namespace ('' = the admin's flat namespace).
  const namespaceOf = ownerId => {
    const u = ownerId == null ? null : db.query('SELECT role, handle FROM users WHERE id = ?').get(ownerId)
    return u && u.role === 'tenant' && u.handle ? u.handle : ''
  }

  const routingConflicts = ({ subdomain, port, owner_id }, excludeId = -1) => {
    const errors = {}
    if (subdomain != null) {
      const ns = namespaceOf(owner_id)
      const clash = db.query('SELECT owner_id FROM projects WHERE subdomain = ? AND id != ?')
        .all(subdomain, excludeId)
        .some(row => namespaceOf(row.owner_id) === ns)
      if (clash) errors.subdomain = 'subdomain already routed'
    }
    if (port != null &&
        db.query('SELECT 1 FROM projects WHERE port = ? AND id != ?').get(port, excludeId)) {
      errors.port = 'port already used by another project'
    }
    return errors
  }

  const applyProxy = () =>
    proxy?.apply().catch(err => console.error('[proxy] apply failed:', err.message))

  app.get('/', c => {
    const user = c.get('user')
    if (user && user.role !== 'admin') {
      return c.json(db.query(`${PROJECT_SELECT} WHERE p.owner_id = ? ORDER BY p.name`).all(user.id))
    }
    return c.json(db.query(`${PROJECT_SELECT} ORDER BY p.name`).all())
  })

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const project = {
      name: body.name?.trim(),
      repo_full_name: body.repo_full_name ?? '',
      git_url: typeof body.git_url === 'string' ? body.git_url.trim() : '',
      branch: body.branch || 'main',
      deploy_script: body.deploy_script ?? '',
      build_image: normalizeImage(body.build_image),
      run_image: normalizeImage(body.run_image),
      runtime: body.runtime ?? 'pm2',
      start_command: body.start_command ?? '',
      pm2_name: body.pm2_name?.trim() || slugify(body.name ?? ''),
      cwd: body.cwd?.trim() || null,
      auto_deploy: body.auto_deploy === false ? 0 : 1,
      write_env_file: body.write_env_file ? 1 : 0,
      subdomain: normalizeSubdomain(body.subdomain),
      port: normalizeNumber(body.port),
      memory_mb: normalizeNumber(body.memory_mb),
      network_profile: body.network_profile ?? 'open',
      host_access: body.host_access ? 1 : 0,
      networks: typeof body.networks === 'string' ? body.networks.trim() : '',
    }
    // No webhook will ever fire for a plain-git project — keep the flag
    // honest instead of letting it promise something that cannot happen.
    if (project.git_url) project.auto_deploy = 0
    const user = c.get('user')
    const tenant = Boolean(user && user.role !== 'admin')
    project.owner_id = user?.id ?? null
    const errors = { ...validateProject(project), ...routingConflicts(project) }
    if (tenant) {
      // The container boundary is what makes tenancy safe at all, and host
      // access reaches the panel itself — both are role rules, not options.
      if (body.runtime === 'pm2') errors.runtime = 'tenant projects run in containers only'
      else project.runtime = 'container'
      if (project.host_access) errors.host_access = 'host access is admin-only'
    }
    // Build-time ENV: on by default for the admin's own repos, off for
    // tenants, whose dependencies are the untrusted ones.
    project.build_env = 'build_env' in body ? (body.build_env ? 1 : 0) : (tenant ? 0 : 1)
    if (project.runtime === 'container' && project.pm2_name === config.selfPm2Name) {
      errors.runtime = 'the panel itself must run under pm2'
    }
    if (Object.keys(errors).length) return c.json({ error: 'validation failed', fields: errors }, 400)

    // A tenant moors GitHub repos only from installations their linked
    // account owns — otherwise the panel would clone the admin's repos on
    // their behalf. Plain git URLs are public and need no check.
    if (tenant && !project.git_url) {
      const inst = github ? await github.getRepoInstallation(project.repo_full_name).catch(() => null) : null
      if (!inst || inst.account.toLowerCase() !== (user.github_login || '').toLowerCase()) {
        return c.json({ error: 'validation failed', fields: { repo_full_name: 'not a repository of your linked GitHub account' } }, 400)
      }
    }

    const slugBase = body.slug?.trim() || slugify(project.name)
    if (!SLUG_RE.test(slugBase)) return c.json({ error: 'validation failed', fields: { slug: 'invalid slug' } }, 400)
    const slug = uniqueName(slugBase, s => db.query('SELECT 1 FROM projects WHERE slug = ?').get(s))
    // The pm2 name follows the same rule: at creation it is a derived
    // suggestion — the field is hidden entirely for container projects — so a
    // collision is resolved by suffixing rather than by rejecting a field the
    // user may not even see. PATCH still 400s, because there it is an
    // explicit edit to an existing project.
    project.pm2_name = uniqueName(project.pm2_name, n => db.query('SELECT 1 FROM projects WHERE pm2_name = ?').get(n))

    const { lastInsertRowid } = db.query(
      `INSERT INTO projects (slug, name, owner_id, repo_full_name, git_url, branch, deploy_script, build_image, run_image, runtime, pm2_name, start_command, cwd, auto_deploy, write_env_file, build_env, subdomain, port, memory_mb, network_profile, host_access, networks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, project.name, project.owner_id, project.repo_full_name, project.git_url, project.branch, project.deploy_script,
          project.build_image, project.run_image, project.runtime, project.pm2_name, project.start_command,
          project.cwd, project.auto_deploy, project.write_env_file, project.build_env, project.subdomain, project.port,
          project.memory_mb, project.network_profile, project.host_access, project.networks)
    const id = Number(lastInsertRowid)
    if (project.port == null) {
      project.port = autoPort(db, id)
      db.query('UPDATE projects SET port = ? WHERE id = ?').run(project.port, id)
    }
    liveState.projects[id] = projectDefaults(null, getProjectInfo(db, id))
    syncManagedImages(db, liveState) // a build/run image may now have a user
    if (project.subdomain) await applyProxy()
    return c.json(getProject(id), 201)
  })

  app.get('/:id', c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    return c.json(project)
  })

  app.patch('/:id', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))

    const merged = {
      name: body.name?.trim() ?? project.name,
      repo_full_name: body.repo_full_name ?? project.repo_full_name,
      git_url: 'git_url' in body ? (typeof body.git_url === 'string' ? body.git_url.trim() : '') : (project.git_url ?? ''),
      branch: body.branch ?? project.branch,
      deploy_script: body.deploy_script ?? project.deploy_script,
      build_image: 'build_image' in body ? normalizeImage(body.build_image) : project.build_image,
      run_image: 'run_image' in body ? normalizeImage(body.run_image) : project.run_image,
      runtime: 'runtime' in body ? body.runtime : project.runtime,
      start_command: body.start_command ?? project.start_command,
      pm2_name: body.pm2_name?.trim() ?? project.pm2_name,
      cwd: 'cwd' in body ? (body.cwd?.trim() || null) : project.cwd,
      auto_deploy: 'auto_deploy' in body ? (body.auto_deploy ? 1 : 0) : project.auto_deploy,
      write_env_file: 'write_env_file' in body ? (body.write_env_file ? 1 : 0) : project.write_env_file,
      build_env: 'build_env' in body ? (body.build_env ? 1 : 0) : project.build_env,
      subdomain: 'subdomain' in body ? normalizeSubdomain(body.subdomain) : project.subdomain,
      port: 'port' in body ? normalizeNumber(body.port) : project.port,
      memory_mb: 'memory_mb' in body ? normalizeNumber(body.memory_mb) : project.memory_mb,
      network_profile: 'network_profile' in body ? body.network_profile : (project.network_profile ?? 'open'),
      host_access: 'host_access' in body ? (body.host_access ? 1 : 0) : project.host_access,
      networks: 'networks' in body ? (typeof body.networks === 'string' ? body.networks.trim() : '') : project.networks,
      owner_id: project.owner_id, // ownership never changes on edit
    }
    // Clearing the port (or saving a legacy project that never had one)
    // re-assigns the default rather than leaving the project portless.
    if (merged.port == null) merged.port = autoPort(db, project.id)
    if (merged.git_url) merged.auto_deploy = 0 // no webhook for plain-git projects
    const editor = c.get('user')
    if (editor && editor.role !== 'admin') {
      if (merged.runtime === 'pm2') errors.runtime = 'tenant projects run in containers only'
      if (merged.host_access) errors.host_access = 'host access is admin-only'
    }
    const errors = { ...validateProject(merged), ...routingConflicts(merged, project.id) }
    if (merged.runtime === 'container' && merged.pm2_name === config.selfPm2Name) {
      errors.runtime = 'the panel itself must run under pm2'
    }
    if (Object.keys(errors).length) return c.json({ error: 'validation failed', fields: errors }, 400)
    if (merged.pm2_name !== project.pm2_name &&
        db.query('SELECT 1 FROM projects WHERE pm2_name = ? AND id != ?').get(merged.pm2_name, project.id)) {
      return c.json({ error: 'validation failed', fields: { pm2_name: 'pm2 name already in use' } }, 400)
    }

    db.query(
      `UPDATE projects SET name = ?, repo_full_name = ?, branch = ?, deploy_script = ?, build_image = ?, run_image = ?, runtime = ?,
         start_command = ?, pm2_name = ?, cwd = ?, auto_deploy = ?, write_env_file = ?, build_env = ?, subdomain = ?, port = ?, memory_mb = ?,
         network_profile = ?, host_access = ?, networks = ?, git_url = ? WHERE id = ?`
    ).run(merged.name, merged.repo_full_name, merged.branch, merged.deploy_script, merged.build_image,
          merged.run_image, merged.runtime, merged.start_command, merged.pm2_name, merged.cwd, merged.auto_deploy,
          merged.write_env_file, merged.build_env, merged.subdomain, merged.port, merged.memory_mb,
          merged.network_profile, merged.host_access, merged.networks, merged.git_url, project.id)
    if (liveState.projects[project.id]) {
      liveState.projects[project.id].info = getProjectInfo(db, project.id)
    }
    syncManagedImages(db, liveState) // the image fields may have moved
    // Flipping the .env toggle takes effect on disk right away — especially
    // the off direction, which deletes the plaintext files.
    if (merged.write_env_file !== project.write_env_file) {
      syncEnvFiles(db, config, getProject(project.id))
    }
    if (merged.subdomain !== project.subdomain || merged.port !== project.port) await applyProxy()
    return c.json(getProject(project.id))
  })

  app.delete('/:id', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    await deleteProcess(project.pm2_name)
    try {
      await engine().removeContainer(appContainerName(project.slug))
    } catch {
      // no engine configured/reachable — then there is no container either
    }
    db.query('DELETE FROM projects WHERE id = ?').run(project.id)
    delete liveState.projects[project.id]
    syncManagedImages(db, liveState) // its images may be unused now
    if (project.subdomain) await applyProxy()
    // Files under APPS_DIR/<slug> are intentionally left on disk; remove manually.
    return c.json({ ok: true, note: `files in ${config.appsDir}/${project.slug} were not deleted` })
  })

  // --- ENV vars -------------------------------------------------------------

  app.get('/:id/env', c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const reveal = c.req.query('reveal') === '1'
    const rows = db.query('SELECT key, value_encrypted, iv FROM env_vars WHERE project_id = ? ORDER BY key').all(project.id)
    return c.json(rows.map(r => ({
      key: r.key,
      value: reveal ? decrypt(r.value_encrypted, r.iv, config.masterKey) : null,
      masked: !reveal,
    })))
  })

  app.put('/:id/env', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => null)
    if (!Array.isArray(body)) return c.json({ error: 'expected an array of {key, value}' }, 400)

    const seen = new Set()
    for (const entry of body) {
      if (!entry || typeof entry.key !== 'string' || !ENV_KEY_RE.test(entry.key) || typeof entry.value !== 'string') {
        return c.json({ error: `invalid env entry: ${JSON.stringify(entry?.key ?? entry)}` }, 400)
      }
      if (seen.has(entry.key)) return c.json({ error: `duplicate key: ${entry.key}` }, 400)
      seen.add(entry.key)
    }

    const replaceAll = db.transaction(() => {
      db.query('DELETE FROM env_vars WHERE project_id = ?').run(project.id)
      for (const { key, value } of body) {
        const { value: encrypted, iv } = encrypt(value, config.masterKey)
        db.query('INSERT INTO env_vars (project_id, key, value_encrypted, iv) VALUES (?, ?, ?, ?)')
          .run(project.id, key, encrypted, iv)
      }
    })
    replaceAll()

    // If the app is already deployed, sync the .env files (written or removed
    // per the project toggle) and refresh the ecosystem file now, so a pm2
    // restart picks the changes up without waiting for the next deploy — the
    // restart route decrypts and injects the fresh values.
    let applied = false
    if (existsSync(projectDirs(config, project).source)) {
      syncEnvFiles(db, config, project)
      writeEcosystem(config, project)
      applied = true
    }
    return c.json({ ok: true, count: body.length, applied })
  })

  // --- Deployments ----------------------------------------------------------

  app.post('/:id/deploy', c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const deploymentId = runner.enqueue(project.id, { trigger: 'manual' })
    return c.json({ id: deploymentId }, 202)
  })

  // Ask GitHub for the current branch head. The webhook keeps this fresh on
  // its own; this covers pushes made while the panel was down or before the
  // webhook was configured.
  app.post('/:id/refresh-head', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    try {
      const head = project.git_url
        ? await lsRemoteHead(project.git_url, project.branch)
        : await github.getBranchHead(project.repo_full_name, project.branch)
      if (head.sha) {
        db.query('UPDATE projects SET head_sha = ?, head_message = ?, head_pushed_at = ? WHERE id = ?')
          .run(head.sha, head.message, head.pushedAt, project.id)
        const live = liveState.projects[project.id]
        if (live) live.headCommit = { sha: head.sha, message: head.message, pushedAt: head.pushedAt }
      }
      return c.json(head)
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  // A short-lived installation token wrapped in a ready-to-paste clone
  // command, for manually pulling the repo on another machine. The token is
  // returned to the (session-authenticated) user on purpose — it is never
  // logged or persisted here.
  app.post('/:id/clone-command', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    // A plain-git project needs no token — the URL is the command.
    if (project.git_url) {
      return c.json({ command: `git clone --branch ${project.branch} ${project.git_url}`, expiresAt: null })
    }
    try {
      const { token, expiresAt } = await github.getInstallationTokenInfo(project.repo_full_name)
      const command =
        `git clone --branch ${project.branch} ` +
        `https://x-access-token:${token}@github.com/${project.repo_full_name}.git`
      return c.json({ command, expiresAt })
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  app.get('/:id/deployments', c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const rows = db.query(
      `SELECT id, project_id, status, "trigger", commit_sha, commit_message, exit_code,
              started_at, finished_at, created_at
       FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 50`
    ).all(project.id)
    return c.json(rows)
  })

  // --- pm2 controls ---------------------------------------------------------

  app.post('/:id/pm2/:action', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const act = c.req.param('action')
    if (!PM2_ACTIONS.includes(act)) return c.json({ error: `action must be one of ${PM2_ACTIONS.join(', ')}` }, 400)
    try {
      await applyProjectAction({ db, config, project, act, engine, poller })
      poller?.tick()
      return c.json({ ok: true })
    } catch (err) {
      // The one status worth passing through is the helper's own 400
      // ("deploy the project first"); an engine failure is our 500.
      return c.json({ error: err.message }, err.status === 400 ? 400 : 500)
    }
  })

  // Recent logs for the project's process, same response shape for both
  // runtimes (and as the Engine room pm2 log route), so one UI component fits.
  app.get('/:id/logs', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const requested = parseInt(c.req.query('lines') ?? '', 10)
    const lines = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LOG_LINES, 1), MAX_LOG_LINES)
    try {
      if (project.runtime === 'container') {
        return c.json(await appLogResponse(engine(), appContainerName(project.slug), lines))
      }
      const proc = await describe(project.pm2_name)
      if (!proc) return c.json({ error: 'not running under pm2 yet' }, 404)
      const read = async path =>
        path
          ? { path, ...(await tailFile(path, { lines })) }
          : { path: null, text: '', truncated: false, missing: true }
      const [out, err] = await Promise.all([
        read(proc.pm2_env?.pm_out_log_path ?? null),
        read(proc.pm2_env?.pm_err_log_path ?? null),
      ])
      return c.json({ name: project.pm2_name, lines, out, err })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })

  // The tail of the container a deploy replaced, written by
  // capturePreviousLogs just before the recreate removes that container and
  // its logs along with it — the only post-mortem for "it crashed and then I
  // deployed". Static once written, so it is its own request rather than a
  // third key on the log route the UI polls every few seconds.
  app.get('/:id/logs/previous', async c => {
    const project = getProjectFor(c)
    if (!project) return c.json({ error: 'not found' }, 404)
    const requested = parseInt(c.req.query('lines') ?? '', 10)
    const lines = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LOG_LINES, 1), MAX_LOG_LINES)
    return c.json({ name: project.slug, ...(await previousLogResponse(projectDirs(config, project), lines)) })
  })

  return app
}
