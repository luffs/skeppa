import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { encrypt, decrypt } from '../lib/crypto.js'
import { slugify, validateProject, SLUG_RE, ENV_KEY_RE, PM2_ACTIONS } from '../lib/validate.js'
import { projectDefaults, getProjectInfo } from '../live/state.js'
import { action as pm2Action, deleteProcess, startOrReload } from '../deploy/pm2.js'
import { projectDirs, writeEnvFiles, writeEcosystem } from '../deploy/envfiles.js'

const PROJECT_COLUMNS =
  'id, slug, name, repo_full_name, branch, deploy_script, pm2_name, start_command, cwd, ' +
  'auto_deploy, head_sha, head_message, head_pushed_at, created_at'

export function projectRoutes({ db, config, liveState, runner, poller, github }) {
  const app = new Hono()

  const getProject = id => db.query(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(Number(id))

  app.get('/', c => {
    return c.json(db.query(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY name`).all())
  })

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const project = {
      name: body.name?.trim(),
      repo_full_name: body.repo_full_name,
      branch: body.branch || 'main',
      deploy_script: body.deploy_script ?? '',
      start_command: body.start_command ?? '',
      pm2_name: body.pm2_name?.trim() || slugify(body.name ?? ''),
      cwd: body.cwd?.trim() || null,
      auto_deploy: body.auto_deploy === false ? 0 : 1,
    }
    const errors = validateProject(project)
    if (Object.keys(errors).length) return c.json({ error: 'validation failed', fields: errors }, 400)

    let slug = body.slug?.trim() || slugify(project.name)
    if (!SLUG_RE.test(slug)) return c.json({ error: 'validation failed', fields: { slug: 'invalid slug' } }, 400)
    // Ensure uniqueness by suffixing -2, -3, ...
    const base = slug
    for (let n = 2; db.query('SELECT 1 FROM projects WHERE slug = ?').get(slug); n++) {
      slug = `${base}-${n}`.slice(0, 63)
    }
    if (db.query('SELECT 1 FROM projects WHERE pm2_name = ?').get(project.pm2_name)) {
      return c.json({ error: 'validation failed', fields: { pm2_name: 'pm2 name already in use' } }, 400)
    }

    const { lastInsertRowid } = db.query(
      `INSERT INTO projects (slug, name, repo_full_name, branch, deploy_script, pm2_name, start_command, cwd, auto_deploy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, project.name, project.repo_full_name, project.branch, project.deploy_script,
          project.pm2_name, project.start_command, project.cwd, project.auto_deploy)
    const id = Number(lastInsertRowid)
    liveState.projects[id] = projectDefaults(null, getProjectInfo(db, id))
    return c.json(getProject(id), 201)
  })

  app.get('/:id', c => {
    const project = getProject(c.req.param('id'))
    if (!project) return c.json({ error: 'not found' }, 404)
    return c.json(project)
  })

  app.patch('/:id', async c => {
    const project = getProject(c.req.param('id'))
    if (!project) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))

    const merged = {
      name: body.name?.trim() ?? project.name,
      repo_full_name: body.repo_full_name ?? project.repo_full_name,
      branch: body.branch ?? project.branch,
      deploy_script: body.deploy_script ?? project.deploy_script,
      start_command: body.start_command ?? project.start_command,
      pm2_name: body.pm2_name?.trim() ?? project.pm2_name,
      cwd: 'cwd' in body ? (body.cwd?.trim() || null) : project.cwd,
      auto_deploy: 'auto_deploy' in body ? (body.auto_deploy ? 1 : 0) : project.auto_deploy,
    }
    const errors = validateProject(merged)
    if (Object.keys(errors).length) return c.json({ error: 'validation failed', fields: errors }, 400)
    if (merged.pm2_name !== project.pm2_name &&
        db.query('SELECT 1 FROM projects WHERE pm2_name = ? AND id != ?').get(merged.pm2_name, project.id)) {
      return c.json({ error: 'validation failed', fields: { pm2_name: 'pm2 name already in use' } }, 400)
    }

    db.query(
      `UPDATE projects SET name = ?, repo_full_name = ?, branch = ?, deploy_script = ?,
         start_command = ?, pm2_name = ?, cwd = ?, auto_deploy = ? WHERE id = ?`
    ).run(merged.name, merged.repo_full_name, merged.branch, merged.deploy_script,
          merged.start_command, merged.pm2_name, merged.cwd, merged.auto_deploy, project.id)
    if (liveState.projects[project.id]) {
      liveState.projects[project.id].info = getProjectInfo(db, project.id)
    }
    return c.json(getProject(project.id))
  })

  app.delete('/:id', async c => {
    const project = getProject(c.req.param('id'))
    if (!project) return c.json({ error: 'not found' }, 404)
    await deleteProcess(project.pm2_name)
    db.query('DELETE FROM projects WHERE id = ?').run(project.id)
    delete liveState.projects[project.id]
    // Files under APPS_DIR/<slug> are intentionally left on disk; remove manually.
    return c.json({ ok: true, note: `files in ${config.appsDir}/${project.slug} were not deleted` })
  })

  // --- ENV vars -------------------------------------------------------------

  app.get('/:id/env', c => {
    const project = getProject(c.req.param('id'))
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
    const project = getProject(c.req.param('id'))
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

    // If the app is already deployed, rewrite .env and the ecosystem file now
    // so a pm2 restart (or the app itself re-reading .env) picks the changes
    // up without waiting for the next deploy.
    let applied = false
    if (existsSync(projectDirs(config, project).source)) {
      const envVars = writeEnvFiles(db, config, project)
      writeEcosystem(db, config, project, envVars)
      applied = true
    }
    return c.json({ ok: true, count: body.length, applied })
  })

  // --- Deployments ----------------------------------------------------------

  app.post('/:id/deploy', c => {
    const project = getProject(c.req.param('id'))
    if (!project) return c.json({ error: 'not found' }, 404)
    const deploymentId = runner.enqueue(project.id, { trigger: 'manual' })
    return c.json({ id: deploymentId }, 202)
  })

  // Ask GitHub for the current branch head. The webhook keeps this fresh on
  // its own; this covers pushes made while the panel was down or before the
  // webhook was configured.
  app.post('/:id/refresh-head', async c => {
    const project = getProject(c.req.param('id'))
    if (!project) return c.json({ error: 'not found' }, 404)
    try {
      const head = await github.getBranchHead(project.repo_full_name, project.branch)
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

  app.get('/:id/deployments', c => {
    const project = getProject(c.req.param('id'))
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
    const project = getProject(c.req.param('id'))
    if (!project) return c.json({ error: 'not found' }, 404)
    const act = c.req.param('action')
    if (!PM2_ACTIONS.includes(act)) return c.json({ error: `action must be one of ${PM2_ACTIONS.join(', ')}` }, 400)
    try {
      // start/restart go through the ecosystem file when it exists so the
      // current ENV set is applied; a plain `pm2 restart` would keep the
      // environment from when the process was first started.
      const { ecosystem } = projectDirs(config, project)
      if (act !== 'stop' && existsSync(ecosystem)) {
        await startOrReload(ecosystem)
      } else {
        await pm2Action(act, project.pm2_name)
      }
      poller?.tick()
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })

  return app
}
