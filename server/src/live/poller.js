import os from 'node:os'
import { statfsSync } from 'node:fs'
import { jlist } from '../deploy/pm2.js'
import {LazyWatch} from "lazy-watch";

// `du` over the whole apps dir is the expensive part — refresh it far less
// often than the cheap pm2/memory/uptime stats.
const DISK_INTERVAL_MS = 30_000

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

// Refreshes projects[*].pm2 and the `system` section of LiveState. Only runs
// while at least one WS client is connected (the Hub starts/stops it).
export function createPoller({ db, config, liveState, intervalMs = 5000 }) {
  let timer = null
  let ticking = false
  let disk = { appsDirBytes: null, free: null, total: null }
  let diskCheckedAt = 0

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      let list = null
      let pm2Error = null
      try {
        list = await jlist()
      } catch (err) {
        pm2Error = err?.message ?? 'pm2 unavailable'
      }
      const byName = new Map((list ?? []).map(p => [p.name, p]))

      for (const { id, pm2_name } of db.query('SELECT id, pm2_name FROM projects').all()) {
        const live = liveState.projects[id]
        if (!live) continue
        const proc = byName.get(pm2_name)
        live.pm2 = proc
          ? {
              status: proc.pm2_env?.status ?? 'unknown',
              uptime: proc.pm2_env?.pm_uptime ?? null,
              memory: proc.monit?.memory ?? null,
              cpu: proc.monit?.cpu ?? null,
              restarts: proc.pm2_env?.restart_time ?? null,
              pid: proc.pid ?? null,
            }
          : { status: 'not started', uptime: null, memory: null, cpu: null, restarts: null, pid: null }
      }

      if (Date.now() - diskCheckedAt > DISK_INTERVAL_MS) {
        diskCheckedAt = Date.now()
        disk = await diskUsage(config.appsDir)
      }

      LazyWatch.overwrite(liveState.system, {
        updatedAt: new Date().toISOString(),
        appsDir: config.appsDir,
        hostUptime: os.uptime(),
        panelUptime: process.uptime(),
        loadavg: os.loadavg(),
        memory: { total: os.totalmem(), free: os.freemem() },
        disk,
        pm2Error,
        pm2: list
          ? list.map(p => ({
              name: p.name,
              status: p.pm2_env?.status ?? 'unknown',
              pid: p.pid ?? null,
              uptime: p.pm2_env?.pm_uptime ?? null,
              cpu: p.monit?.cpu ?? null,
              memory: p.monit?.memory ?? null,
              restarts: p.pm2_env?.restart_time ?? null,
            }))
          : null,
      })
    } finally {
      ticking = false
    }
  }

  return {
    start() {
      if (timer) return
      tick()
      timer = setInterval(tick, intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}
