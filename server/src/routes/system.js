import { Hono } from 'hono'
import { PM2_NAME_RE, PM2_ACTIONS } from '../lib/validate.js'
import { projectDirs, decryptedEnv, runtimeEnv } from '../deploy/envfiles.js'
import { tailFile } from '../lib/tail.js'
import * as realPm2 from '../deploy/pm2.js'

const DEFAULT_LINES = 200
const MAX_LINES = 2000

// Host-wide pm2 controls for the Engine room. These act on processes the pm2
// daemon already reports — including ones Skeppa did not deploy — so the
// running list is itself the whitelist, on top of the PM2_NAME_RE shape check.
export function systemRoutes({ db, config, poller, pm2 = realPm2 }) {
  const app = new Hono()

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

  return app
}
