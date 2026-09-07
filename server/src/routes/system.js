import { Hono } from 'hono'
import { PM2_NAME_RE, PM2_ACTIONS, CONTAINER_NAME_RE } from '../lib/validate.js'
import { projectDirs, decryptedEnv, runtimeEnv } from '../deploy/envfiles.js'
import { tailFile } from '../lib/tail.js'
import * as realPm2 from '../deploy/pm2.js'
import { createContainerClient } from '../containers/client.js'
import { appContainerName, appLogResponse, previousLogResponse } from '../containers/runtime.js'
import { containerName } from '../live/containers.js'
import { applyProjectAction } from '../deploy/control.js'

const DEFAULT_LINES = 200
const MAX_LINES = 2000

// Host-wide process controls for the Engine room, in two halves: pm2 below
// and the container engine further down. Both act only on things the daemon
// or engine already reports — including ones Skeppa did not deploy — so the
// running list is itself the whitelist, on top of the name shape check.
export function systemRoutes({ db, config, poller, pm2 = realPm2, containerClient = null }) {
  const app = new Hono()

  // Lazy so pm2-only installs never touch the socket.
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

  const known = async name => (await pm2.jlist()).find(p => p.name === name) ?? null

  // The owning project (if any) plus its ecosystem file and current ENV.
  // Externally-managed processes get nulls and a plain pm2 start/restart
  // (the daemon keeps whatever env they were started with).
  function projectHandle(name) {
    const project = db.query('SELECT * FROM projects WHERE pm2_name = ?').get(name) ?? null
    if (!project) return { project, ecosystem: null, env: null }
    return {
      project,
      ecosystem: projectDirs(config, project).ecosystem,
      env: runtimeEnv(project, decryptedEnv(db, config, project.id)),
    }
  }

  app.post('/pm2/:name/:action', async c => {
    const name = c.req.param('name')
    const act = c.req.param('action')
    if (!PM2_NAME_RE.test(name)) return c.json({ error: 'invalid pm2 process name' }, 400)
    if (!PM2_ACTIONS.includes(act)) {
      return c.json({ error: `action must be one of ${PM2_ACTIONS.join(', ')}` }, 400)
    }
    try {
      if (!(await known(name))) return c.json({ error: 'unknown pm2 process' }, 404)
      const { project, ecosystem, env } = projectHandle(name)
      await pm2.applyAction(act, name, ecosystem, env)
      // Stop also turns off start-at-boot; start/restart turn it back on.
      if (project) {
        db.query('UPDATE projects SET auto_start = ? WHERE id = ?')
          .run(act === 'stop' ? 0 : 1, project.id)
        // This route drives pm2 directly instead of via applyProjectAction,
        // so it owns the same bookkeeping: a panel action is not a crash.
        poller?.expectRestart(project.id)
      }
      poller?.tick()
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })

  // Recent stdout/stderr, tailed straight from the log files pm2 itself
  // reports for the process. Both streams come back in one response so the
  // client can switch between them without another round-trip.
  app.get('/pm2/:name/logs', async c => {
    const name = c.req.param('name')
    if (!PM2_NAME_RE.test(name)) return c.json({ error: 'invalid pm2 process name' }, 400)
    const requested = parseInt(c.req.query('lines') ?? '', 10)
    const lines = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LINES, 1), MAX_LINES)
    try {
      const proc = await known(name)
      if (!proc) return c.json({ error: 'unknown pm2 process' }, 404)
      const read = async path =>
        path
          ? { path, ...(await tailFile(path, { lines })) }
          : { path: null, text: '', truncated: false, missing: true }
      const [out, err] = await Promise.all([
        read(proc.pm2_env?.pm_out_log_path ?? null),
        read(proc.pm2_env?.pm_err_log_path ?? null),
      ])
      return c.json({ name, lines, out, err })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })

  // --- containers -----------------------------------------------------------

  // The container half of the Engine room, mirroring the pm2 routes above: the
  // engine's own container list is the whitelist (on top of the name shape
  // check), and a container the panel owns is driven through exactly the code
  // path the project page uses — start/restart recreate it so the env is
  // freshly decrypted, and auto_start follows. Anything else on the engine
  // gets a plain start/stop/restart and no bookkeeping.
  const listed = async name => (await engine().listContainers()).some(e => containerName(e) === name)

  const owner = name =>
    db.query(`SELECT p.*, u.role AS owner_role, u.handle AS owner_handle
      FROM projects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.runtime = 'container'`).all()
      .find(p => appContainerName(p.slug) === name) ?? null

  app.post('/containers/:name/:action', async c => {
    const name = c.req.param('name')
    const act = c.req.param('action')
    if (!CONTAINER_NAME_RE.test(name)) return c.json({ error: 'invalid container name' }, 400)
    if (!PM2_ACTIONS.includes(act)) {
      return c.json({ error: `action must be one of ${PM2_ACTIONS.join(', ')}` }, 400)
    }
    try {
      if (!(await listed(name))) return c.json({ error: 'unknown container' }, 404)
      const project = owner(name)
      if (project) await applyProjectAction({ db, config, project, act, engine, poller })
      else if (act === 'stop') await engine().stopContainer(name)
      else if (act === 'start') await engine().startContainer(name)
      else await engine().restartContainer(name)
      poller?.tick()
      return c.json({ ok: true })
    } catch (err) {
      // The one status worth passing through is the helper's own 400
      // ("deploy the project first"); an engine failure is our 500.
      return c.json({ error: err.message }, err.status === 400 ? 400 : 500)
    }
  })

  // The post-mortem for the container a deploy replaced, mirroring the
  // project page's route so the Engine room shows the same third tab. Only a
  // container the panel owns has one; anything else on the engine reports it
  // missing rather than 404ing, so the tab renders the same either way.
  app.get('/containers/:name/logs/previous', async c => {
    const name = c.req.param('name')
    if (!CONTAINER_NAME_RE.test(name)) return c.json({ error: 'invalid container name' }, 400)
    const requested = parseInt(c.req.query('lines') ?? '', 10)
    const lines = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LINES, 1), MAX_LINES)
    const project = owner(name)
    const dirs = project ? projectDirs(config, project) : null
    return c.json({ name, ...(await previousLogResponse(dirs, lines)) })
  })

  // Same response shape as the pm2 log route, so one UI component fits both.
  app.get('/containers/:name/logs', async c => {
    const name = c.req.param('name')
    if (!CONTAINER_NAME_RE.test(name)) return c.json({ error: 'invalid container name' }, 400)
    const requested = parseInt(c.req.query('lines') ?? '', 10)
    const lines = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LINES, 1), MAX_LINES)
    try {
      if (!(await listed(name))) return c.json({ error: 'unknown container' }, 404)
      return c.json(await appLogResponse(engine(), name, lines))
    } catch (err) {
      // The one status worth passing through is the helper's own 400
      // ("deploy the project first"); an engine failure is our 500.
      return c.json({ error: err.message }, err.status === 400 ? 400 : 500)
    }
  })

  return app
}
