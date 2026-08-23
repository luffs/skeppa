import os from 'node:os'
import { statfsSync } from 'node:fs'
import { jlist } from '../deploy/pm2.js'
import { createContainerClient } from '../containers/client.js'
import { appContainerName } from '../containers/runtime.js'
import { PROXY_PROCESS } from '../proxy/index.js'
import { collectContainers } from './containers.js'
import { roundCpu, roundMem } from './quantize.js'
import { syncImages } from './images.js'

// `du` over the whole apps dir is the expensive part — refresh it far less
// often than the cheap pm2/memory/uptime stats.
const DISK_INTERVAL_MS = 30_000

// The engine's image listing is the Shipyard's slow half. Nothing changes it
// behind the panel's back except a self-heal rebuild mid-deploy, so the same
// slow lane as disk is plenty; every panel-side mutation syncs immediately.
const IMAGES_INTERVAL_MS = 30_000

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
const EMPTY_STATS = { status: 'not started', uptime: null, memory: null, cpu: null, restarts: null, pid: null }

// A container entry carries image/ports/state for the Engine room; a project's
// live.pm2 speaks only the shared vocabulary.
const projectStats = ({ status, uptime, memory, cpu, restarts, pid }) =>
  ({ status, uptime, memory, cpu, restarts, pid })

export function createPoller({ db, config, liveState, intervalMs = 5000, containerClient = null }) {
  let timer = null
  let ticking = false
  let engine = containerClient
  const getEngine = () => {
    if (!engine && config.containerSocket) engine = createContainerClient({ socketPath: config.containerSocket })
    return engine
  }
  let disk = { appsDirBytes: null, free: null, total: null }
  let diskCheckedAt = 0
  let imagesCheckedAt = 0
  // Boot/start instants instead of uptime seconds: uptimes grow every tick by
  // definition (a guaranteed diff), while these are constants the client can
  // derive a live uptime from.
  const hostBootAt = Date.now() - Math.round(os.uptime() * 1000)
  const panelStartedAt = Date.now() - Math.round(process.uptime() * 1000)
  // When the panel itself runs under pm2 it sets pm_id/name in our env. The UI
  // uses this to warn before stopping the process it is talking to.
  const selfPm2Name = process.env.pm_id != null ? (process.env.name ?? null) : null

  async function refreshImages() {
    imagesCheckedAt = Date.now()
    await syncImages(db, liveState, getEngine())
  }

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

      if (Date.now() - imagesCheckedAt > IMAGES_INTERVAL_MS) await refreshImages()

      // One pass over the engine for the whole tick: the Engine room's
      // container list and every container project's stats come out of it.
      let containers = null
      let containerError = ''
      const eng = getEngine()
      if (eng) ({ containers, error: containerError } = await collectContainers(eng))

      let list = null
      let pm2Error = null
      try {
        list = await jlist()
      } catch (err) {
        pm2Error = err?.message ?? 'pm2 unavailable'
      }
      const byName = new Map((list ?? []).map(p => [p.name, p]))

      for (const { id, pm2_name, slug, runtime } of db.query('SELECT id, pm2_name, slug, runtime FROM projects').all()) {
        const live = liveState.projects[id]
        if (!live) continue
        if (runtime === 'container') {
          // live.pm2 keeps its name for wire/UI compatibility — the shape is
          // identical, the Engine room's container pass fills it in. No
          // listing at all (unreachable engine) is 'unknown'; a listing
          // without this container means it was never created.
          if (!containers) {
            live.pm2 = { ...EMPTY_STATS, status: 'unknown' }
            continue
          }
          const stats = containers[appContainerName(slug)]
          live.pm2 = stats ? projectStats(stats) : { ...EMPTY_STATS }
          continue
        }
        const proc = byName.get(pm2_name)
        live.pm2 = proc ? pm2Stats(proc) : { ...EMPTY_STATS }
      }

      liveState.system = {
        appsDir: config.appsDir,
        hostBootAt,
        panelStartedAt,
        selfPm2Name,
        // Like images.managedPrefix: sent along so the client can recognize
        // the panel's own proxy process without hardcoding its name.
        proxyPm2Name: PROXY_PROCESS,
        loadavg: os.loadavg().map(n => Math.round(n * 100) / 100),
        memory: { total: os.totalmem(), free: roundMem(os.freemem()) },
        disk,
        pm2Error,
        pm2: list ? Object.fromEntries(list.map(p => [p.name, pm2Stats(p)])) : null,
        // '' when no engine is configured at all — the UI hides the whole
        // container section rather than reporting a missing socket as a fault.
        containerSocket: config.containerSocket ?? '',
        containerError,
        containers,
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
    refreshImages,
  }
}
