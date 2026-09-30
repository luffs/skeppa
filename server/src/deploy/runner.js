import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { resolveShell, scriptEnvBase } from '../lib/shell.js'
import { projectDefaults, getProjectInfo, getRecentDeployments } from '../live/state.js'
import { projectDirs, syncEnvFiles, writeEcosystem, runtimeEnv, decryptedEnv, prepareBuildEnv } from './envfiles.js'
import { syncRepo } from './git.js'
import { publishStatic, unpublishStatic } from './publish.js'
import { runScriptInContainer } from './sandbox.js'
import * as realPm2 from './pm2.js'
import { createContainerClient } from '../containers/client.js'
import { appContainerName, recreateAppContainer } from '../containers/runtime.js'
import { isReservedPm2Name } from '../lib/runtime.js'

export class DeployError extends Error {
  constructor(message, exitCode = null) {
    super(message)
    this.exitCode = exitCode
  }
}

// Collects log lines for one deployment: pushes each line into the
// deployment's live store immediately (live/stores.js), batches DB writes
// (one UPDATE per second, not per line).
class LogCollector {
  constructor(db, logs, deploymentId) {
    this.db = db
    this.logs = logs
    this.deploymentId = deploymentId
    this.text = ''
    this.pending = ''
    this.timer = null
    this.line = this.line.bind(this)
    this.logs.openLog(deploymentId)
  }

  line(line) {
    const l = String(line)
    this.text += l + '\n'
    this.pending += l + '\n'
    this.logs.appendLog(this.deploymentId, l)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 1000)
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending) return
    this.db.query('UPDATE deployments SET log = log || ? WHERE id = ?').run(this.pending, this.deploymentId)
    this.pending = ''
  }
}

export async function readLines(stream, onLine) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''))
      buf = buf.slice(i + 1)
    }
  }
  buf += decoder.decode()
  if (buf) onLine(buf)
}

// On server start, deployments interrupted by a crash/restart can never finish.
export function recoverInterrupted(db) {
  const { changes } = db.query(
    `UPDATE deployments SET status = 'failed', finished_at = ?,
       log = log || 'deploy interrupted by panel restart' || char(10)
     WHERE status IN ('queued', 'running')`
  ).run(new Date().toISOString())
  return changes
}

// Sequential queue per project, parallel across projects. While one deploy
// runs, at most one more waits; a newer enqueue replaces the waiting one
// (which is marked cancelled).
export class DeployRunner {
  constructor({ db, config, liveState, logs, github, execute, containerClient = null, notify = null, poller = null, applyProxy = null, pm2 = realPm2 }) {
    this.db = db
    this.config = config
    this.liveState = liveState
    this.logs = logs // live/stores.js: openLog / appendLog / closeLog
    this.github = github
    this.notify = notify ?? (() => {}) // fire-and-forget; never awaited
    this.containerClient = containerClient // test injection; null = real engine
    this.poller = poller // told when a deploy changed the apps dir
    this.applyProxy = applyProxy // reloads the harbor gate when a deploy changes what it should serve
    this.pm2 = pm2 // test injection; the real CLI wrapper otherwise
    this.queues = new Map() // projectId -> { runningId, queuedId }
    this.activeLogs = new Map() // deploymentId -> LogCollector
    this._execute = execute || ((project, deploymentId, log) => this._deploy(project, deploymentId, log))
  }

  getActiveLog(deploymentId) {
    return this.activeLogs.get(deploymentId)?.text ?? null
  }

  enqueue(projectId, { trigger, commitSha = null, commitMessage = null }) {
    const project = this.db.query('SELECT * FROM projects WHERE id = ?').get(projectId)
    if (!project) throw new Error(`project ${projectId} not found`)

    const { lastInsertRowid } = this.db.query(
      `INSERT INTO deployments (project_id, status, "trigger", commit_sha, commit_message)
       VALUES (?, 'queued', ?, ?, ?)`
    ).run(project.id, trigger, commitSha, commitMessage)
    const deploymentId = Number(lastInsertRowid)

    let q = this.queues.get(project.id)
    if (!q) this.queues.set(project.id, (q = { runningId: null, queuedId: null }))

    if (q.runningId != null) {
      if (q.queuedId != null) this._cancel(q.queuedId)
      q.queuedId = deploymentId
    } else {
      q.runningId = deploymentId
      queueMicrotask(() => this._run(project.id, deploymentId))
    }
    this._refreshRecent(project.id)
    return deploymentId
  }

  _cancel(deploymentId) {
    this.db.query(
      `UPDATE deployments SET status = 'cancelled', finished_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), deploymentId)
  }

  _live(projectId) {
    let live = this.liveState.projects[projectId]
    if (!live) {
      this.liveState.projects[projectId] = projectDefaults(null, getProjectInfo(this.db, projectId))
      live = this.liveState.projects[projectId]
    }
    return live
  }

  // Re-reads the tail of the history after every status change. Cheap (an
  // indexed 5-row query) and impossible to drift, unlike patching the array
  // in place; lazy-watch turns it into a diff only when something differs.
  _refreshRecent(projectId) {
    this._live(projectId).recentDeployments = getRecentDeployments(this.db, projectId)
  }

  async _run(projectId, deploymentId) {
    const log = new LogCollector(this.db, this.logs, deploymentId)
    this.activeLogs.set(deploymentId, log)
    const startedAt = new Date().toISOString()
    this.db.query(`UPDATE deployments SET status = 'running', started_at = ? WHERE id = ?`)
      .run(startedAt, deploymentId)
    this._live(projectId).currentDeployment = { id: deploymentId, status: 'running', startedAt }
    this._refreshRecent(projectId)

    let status = 'success'
    let exitCode = 0
    try {
      const project = this.db.query(
        `SELECT p.*, u.role AS owner_role, u.handle AS owner_handle
         FROM projects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?`
      ).get(projectId)
      if (!project) throw new DeployError('project was deleted')
      // The deploy script is arbitrary shell. For the admin that is the
      // product; for a tenant it must never touch the host — no host
      // process (a container, or a static site with no process at all)
      // and the podman build sandbox are hard requirements, enforced here
      // so no route or UI gap can reopen them.
      if (project.owner_role === 'tenant') {
        if (!['container', 'static'].includes(project.runtime)) throw new DeployError('tenant projects run in a container or as a static site')
        if (this.config.sandbox !== 'podman') {
          throw new DeployError('tenant deploys require the podman build sandbox — the admin must set SKEPPA_SANDBOX=podman')
        }
      }
      await this._execute(project, deploymentId, log)
      log.line('✔ deploy finished')
    } catch (err) {
      status = 'failed'
      exitCode = err instanceof DeployError && err.exitCode != null ? err.exitCode : 1
      log.line(`✖ ${err.message}`)
    }

    const finishedAt = new Date().toISOString()
    log.flush()
    this.activeLogs.delete(deploymentId)
    this.logs.closeLog(deploymentId)
    this.db.query(
      `UPDATE deployments SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?`
    ).run(status, exitCode, finishedAt, deploymentId)

    const row = this.db.query('SELECT commit_sha FROM deployments WHERE id = ?').get(deploymentId)
    if (status === 'failed') {
      const p = this.db.query('SELECT name FROM projects WHERE id = ?').get(projectId)
      const sha = row?.commit_sha ? ` @ ${row.commit_sha.slice(0, 7)}` : ''
      this.notify(`✖ Deploy of ${p?.name ?? 'a deleted project'}${sha} failed (exit ${exitCode})`)
    }
    const live = this._live(projectId)
    live.currentDeployment = null
    live.lastDeployment = { id: deploymentId, status, finishedAt, commitSha: row?.commit_sha ?? null }
    if (status === 'success' && row?.commit_sha) live.deployedSha = row.commit_sha
    this._refreshRecent(projectId)
    // Success or not, the checkout and whatever the script built are on
    // disk now — the apps-dir gauge is stale either way.
    this.poller?.diskChanged()
    // A successful deploy reloaded (pm2) or recreated (container) the
    // process — its counter moving now is the deploy, not a crash. A
    // failed one usually never reached that step, so its history keeps.
    if (status === 'success') this.poller?.expectRestart(projectId)

    const q = this.queues.get(projectId)
    if (q) {
      q.runningId = null
      if (q.queuedId != null) {
        const next = q.queuedId
        q.queuedId = null
        q.runningId = next
        queueMicrotask(() => this._run(projectId, next))
      }
    }
  }

  // The real pipeline: token -> git -> .env -> deploy script -> pm2.
  async _deploy(project, deploymentId, log) {
    const dirs = projectDirs(this.config, project)

    let token = null
    if (!project.git_url) {
      log.line('▸ fetching GitHub installation token')
      token = await this.github.getInstallationToken(project.repo_full_name)
    }

    log.line(`▸ syncing ${project.git_url || project.repo_full_name} @ ${project.branch}`)
    const { sha, message } = await syncRepo({
      dir: dirs.source,
      repoFullName: project.repo_full_name,
      gitUrl: project.git_url || null,
      branch: project.branch,
      token,
      onLine: log.line,
    })
    log.line(`▸ checked out ${sha.slice(0, 7)} — ${message}`)
    this.db.query('UPDATE deployments SET commit_sha = ?, commit_message = COALESCE(commit_message, ?) WHERE id = ?')
      .run(sha, message, deploymentId)
    // The sha is what the log entry shows for a running deploy.
    this._refreshRecent(project.id)

    // With build access off, ENV reaches only the runtime: nothing in the
    // script's environment, no .env in the working tree until it is done.
    const buildAccess = Boolean(project.build_env)
    const envVars = buildAccess
      ? syncEnvFiles(this.db, this.config, project)
      : decryptedEnv(this.db, this.config, project.id)
    if (buildAccess) {
      log.line(project.write_env_file
        ? `▸ wrote .env (${Object.keys(envVars).length} vars)`
        : `▸ loaded ${Object.keys(envVars).length} ENV vars (injected in memory, no .env written)`)
    } else {
      log.line(`▸ ${Object.keys(envVars).length} ENV vars withheld from the deploy script (build access is off)`)
    }

    if (project.deploy_script?.trim()) {
      log.line(this.config.sandbox === 'podman'
        ? '▸ running deploy script (podman sandbox)'
        : '▸ running deploy script')
      await this._runScript(project, dirs, prepareBuildEnv(this.config, project, envVars), log)
    } else {
      log.line('▸ no deploy script configured, skipping')
    }
    // .env (if that toggle is on) is written now, for the runtime only.
    if (!buildAccess) syncEnvFiles(this.db, this.config, project)

    if (project.runtime === 'static') {
      this._publish(project, dirs, log)
    } else if (project.start_command?.trim()) {
      const appEnv = runtimeEnv(project, envVars)
      if (project.runtime === 'container') {
        // A pm2 process from before a pm2 → container switch still holds the
        // port this container is about to publish.
        rmSync(dirs.ecosystem, { force: true })
        if (project.deployed_runtime === 'pm2') await this._removeLeftoverPm2(project)
        log.line(`▸ recreating container ${appContainerName(project.slug)}`)
        await recreateAppContainer({
          config: this.config, project, dirs, env: appEnv,
          onLine: log.line, client: this.containerClient, db: this.db,
        })
      } else {
        await this._removeStaleContainer(project.slug)
        // Null for the self project — which also scrubs any stale generated
        // spec, so panel restarts fall back to a plain `pm2 restart`.
        const ecosystemPath = writeEcosystem(this.config, project)
        if (project.pm2_name === this.config.selfPm2Name) {
          log.line('▸ self-deploy detected: pm2 reload will run detached after this deploy finalizes')
          // The deployed checkout's own ecosystem file: cwd resolves to the
          // new source dir, and the spec shape matches the one the installer
          // started the panel with — one definition, never a reload-merge.
          setTimeout(() => this.pm2.startOrReloadDetached(join(dirs.source, 'ecosystem.config.cjs'), appEnv), 1500)
        } else {
          log.line(`▸ pm2 startOrReload ${project.pm2_name}`)
          await this.pm2.startOrReload(ecosystemPath, appEnv)
        }
      }
      // A deploy that (re)started the app means it should start at boot too.
      this.db.query('UPDATE projects SET auto_start = 1 WHERE id = ?').run(project.id)
    } else {
      log.line('▸ no start command configured, skipping start')
    }
    await this._settle(project, dirs, log)
  }

  // The new thing is ready — published, or started. Record that it is what
  // the project now runs as, move the harbor gate's route to it, and only
  // then clear away what served the project before. In that order a switch
  // between an app and a static site has no gap, and anything failing on
  // the way leaves the previous site exactly where it was.
  async _settle(project, dirs, log) {
    const was = project.deployed_runtime || ''
    const now = project.runtime
    if (was !== now) {
      const record = runtime => {
        this.db.query('UPDATE projects SET deployed_runtime = ? WHERE id = ?').run(runtime, project.id)
        const live = this.liveState.projects[project.id]
        if (live?.info) live.info.deployed_runtime = runtime
      }
      record(now)
      // Files or a port: the route only changes kind when static is involved.
      const switched = Boolean(was) && (was === 'static') !== (now === 'static')
      if (this.applyProxy) {
        try {
          await this.applyProxy()
          if (switched) log.line(`▸ harbor gate now serves ${now === 'static' ? 'the published files' : 'the app'}`)
        } catch (err) {
          if (switched) {
            record(was)
            throw new DeployError(`the harbor gate did not take the new route (${err.message}) — the previous site is still being served`)
          }
          log.line(`⚠ harbor gate reload failed: ${err.message} — see Rigging → Harbor gate`)
        }
      }
    }
    if (now === 'static') {
      // What ran before would keep running (and keep its port) with nothing
      // pointing at it.
      rmSync(dirs.ecosystem, { force: true })
      if (was === 'pm2') await this._removeLeftoverPm2(project)
      if (was !== 'static') await this._removeStaleContainer(project.slug)
    } else {
      unpublishStatic(dirs.public) // left over from a static era
    }
  }

  // Removes the pm2 process a project ran as before it left the pm2 runtime.
  // Callers only get here when the last successful deploy was a pm2 one; the
  // name check is the second lock — the panel's own process and the harbor
  // gate are never deleted on the strength of a project's pm2 name.
  async _removeLeftoverPm2(project) {
    if (isReservedPm2Name(this.config, project.pm2_name)) return
    await this.pm2.deleteProcess(project.pm2_name)
  }

  // Static runtime: nothing starts. What the build produced is copied into a
  // panel-owned snapshot, which is what the harbor gate serves — see
  // publish.js for why it is never the working tree itself.
  _publish(project, dirs, log) {
    log.line(`▸ publishing ${project.publish_dir || '.'}`)
    let result
    try {
      result = publishStatic({ workDir: dirs.work, publishDir: project.publish_dir, target: dirs.public })
    } catch (err) {
      throw new DeployError(err.message)
    }
    const kb = Math.max(1, Math.round(result.bytes / 1024))
    log.line(`▸ published ${result.files} file${result.files === 1 ? '' : 's'} (${kb} kB)`)
    if (result.symlinks) log.line(`▸ left out ${result.symlinks} symlink${result.symlinks === 1 ? '' : 's'} — links are never published`)
    if (result.hidden) log.line(`▸ left out ${result.hidden} dot-file${result.hidden === 1 ? '' : 's'}/director${result.hidden === 1 ? 'y' : 'ies'}`)
    if (!result.hasIndex) log.line('⚠ no index.html at the top of the published directory — the site root will be a 404')
    if (!project.subdomain) log.line('⚠ no subdomain set — the site is published but not reachable until it has one (Rigging)')
  }

  // A container left behind after a container → pm2 runtime switch would keep
  // the published port. Best-effort: no engine configured means nothing to do.
  async _removeStaleContainer(slug) {
    if (!this.config.containerSocket) return
    try {
      const engine = this.containerClient ?? createContainerClient({ socketPath: this.config.containerSocket })
      await engine.removeContainer(appContainerName(slug))
    } catch {
      // engine unreachable — there is no container to remove then
    }
  }

  async _runScript(project, dirs, envVars, log) {
    if (this.config.sandbox === 'podman') {
      const { exitCode, timedOut } = await runScriptInContainer({
        config: this.config,
        project,
        dirs,
        script: project.deploy_script,
        envVars,
        onLine: log.line,
        timeoutMs: this.config.deployTimeoutMs,
        client: this.containerClient,
        db: this.db,
      })
      if (timedOut) throw new DeployError(`deploy script timed out after ${this.config.deployTimeoutMs} ms`, exitCode)
      if (exitCode !== 0) throw new DeployError(`deploy script exited with code ${exitCode}`, exitCode)
      return
    }

    // Host mode: minimal environment — the project's vars plus what a shell
    // needs. The panel's own environment (MASTER_KEY!) must not leak in.
    const env = { ...scriptEnvBase(), ...envVars }
    const proc = Bun.spawn([...resolveShell(), project.deploy_script], { cwd: dirs.work, env, stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill(9)
    }, this.config.deployTimeoutMs)
    try {
      await Promise.all([readLines(proc.stdout, log.line), readLines(proc.stderr, log.line)])
      const exitCode = await proc.exited
      if (timedOut) throw new DeployError(`deploy script timed out after ${this.config.deployTimeoutMs} ms`, exitCode)
      if (exitCode !== 0) throw new DeployError(`deploy script exited with code ${exitCode}`, exitCode)
    } finally {
      clearTimeout(timer)
    }
  }
}
