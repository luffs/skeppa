import { Hono } from 'hono'
import os from 'node:os'
import { statfsSync } from 'node:fs'
import { jlist } from '../deploy/pm2.js'

async function diskUsage(appsDir) {
  const result = { appsDirBytes: null, free: null, total: null }
  try {
    const s = statfsSync(appsDir)
    result.total = s.blocks * s.bsize
    result.free = s.bavail * s.bsize
  } catch { /* unsupported on this platform */ }
  try {
    const proc = Bun.spawn(['du', '-sk', appsDir], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    if ((await proc.exited) === 0) result.appsDirBytes = parseInt(out, 10) * 1024
  } catch { /* du unavailable */ }
  return result
}

export function systemRoutes({ config }) {
  const app = new Hono()

  app.get('/status', async c => {
    const [pm2, disk] = await Promise.all([
      jlist().catch(err => ({ error: err.message })),
      diskUsage(config.appsDir),
    ])
    return c.json({
      pm2,
      disk,
      appsDir: config.appsDir,
      hostUptime: os.uptime(),
      panelUptime: process.uptime(),
      loadavg: os.loadavg(),
      memory: { total: os.totalmem(), free: os.freemem() },
    })
  })

  return app
}
