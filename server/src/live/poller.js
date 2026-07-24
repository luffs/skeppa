import os from 'node:os'
import { statfsSync } from 'node:fs'
import { jlist } from '../deploy/pm2.js'

// `du` over the whole apps dir is the expensive part — refresh it far less
// often than the cheap pm2/memory/uptime stats.
const DISK_INTERVAL_MS = 30_000

const MB = 1024 * 1024

// Quantize jittery stats before they enter LiveState: lazy-watch only emits
// real changes, so values that merely wobble below display precision would
// otherwise produce a diff on every tick.
const roundCpu = c => (typeof c === 'number' ? Math.round(c) : null)
const roundMem = b => (typeof b === 'number' ? Math.round(b / MB) * MB : null)

const pm2Stats = proc => ({
  status: proc.pm2_env?.status ?? 'unknown',
  uptime: proc.pm2_env?.pm_uptime ?? null,
  memory: roundMem(proc.monit?.memory),
  cpu: roundCpu(proc.monit?.cpu),
  restarts: proc.pm2_env?.restart_time ?? null,
  pid: proc.pid ?? null,
})

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
  // Boot/start instants instead of uptime seconds: uptimes grow every tick by
  // definition (a guaranteed diff), while these are constants the client can
  // derive a live uptime from.
  const hostBootAt = Date.now() - Math.round(os.uptime() * 1000)
  const panelStartedAt = Date.now() - Math.round(process.uptime() * 1000)

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      // Refresh disk before building `system` so fresh numbers reach clients
      // in the same tick instead of one interval late.
      if (Date.now() - diskCheckedAt > DISK_INTERVAL_MS) {
        diskCheckedAt = Date.now()
        disk = await diskUsage(config.appsDir)
      }

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
          ? pm2Stats(proc)
          : { status: 'not started', uptime: null, memory: null, cpu: null, restarts: null, pid: null }
      }

      liveState.system = {
        appsDir: config.appsDir,
        hostBootAt,
        panelStartedAt,
        loadavg: os.loadavg().map(n => Math.round(n * 100) / 100),
        memory: { total: os.totalmem(), free: roundMem(os.freemem()) },
        disk,
        pm2Error,
        pm2: list ? Object.fromEntries(list.map(p => [p.name, pm2Stats(p)])) : null,
      }
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
