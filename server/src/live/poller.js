import os from 'node:os'
import { statfsSync } from 'node:fs'
import { jlist } from '../deploy/pm2.js'
import { createContainerClient } from '../containers/client.js'
import { appContainerName } from '../containers/runtime.js'
import { PROXY_PROCESS } from '../proxy/index.js'
import { collectContainers } from './containers.js'
import { createCrashWatch } from './crashwatch.js'
import { roundCpu, roundMem } from './quantize.js'
import { syncImages } from './images.js'

// `du` walks every file under the apps dir — seconds of IO once a few
// node_modules live there. The tree only changes when the panel deploys
// into it (deletion keeps the files), so the walk runs at boot, after a
// deploy (diskChanged), and otherwise only while a client is watching,
// slowly — background drift is just logs and shared/ data. Free/total is
// a single statfs syscall and stays on every tick.
const DU_INTERVAL_MS = 300_000

// The engine's image listing is the Shipyard's slow half. Every panel-side
// mutation syncs immediately in its route, so this lane only catches
// out-of-band changes (a self-heal rebuild mid-deploy, podman used by
// hand) — gated like du: once at boot, then only while a client watches.
// The connect tick refreshes anyway, so idling costs nothing but staleness
// nobody can see.
const IMAGES_INTERVAL_MS = 30_000

const pm2Stats = proc => ({
  status: proc.pm2_env?.status ?? 'unknown',
  uptime: proc.pm2_env?.pm_uptime ?? null,
  memory: roundMem(proc.monit?.memory),
  cpu: roundCpu(proc.monit?.cpu),
  restarts: proc.pm2_env?.restart_time ?? null,
  pid: proc.pid ?? null,
})

function diskFree(appsDir) {
  try {
    const s = statfsSync(appsDir)
    // free wobbles constantly; rounded like memory.free so a byte-level
    // flutter does not become a LiveState diff on every tick.
    return { total: s.blocks * s.bsize, free: roundMem(s.bavail * s.bsize) }
  } catch {
    return { total: null, free: null } // unsupported on this platform
  }
}

async function duAppsDir(appsDir) {
  try {
    const proc = Bun.spawn(['du', '-sk', appsDir], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    if ((await proc.exited) === 0) return parseInt(out, 10) * 1024
  } catch { /* du unavailable */ }
  return null
}

// Refreshes projects[*].pm2 and the `system` section of LiveState. Always
// running once started — the crash watch has to work with nobody looking —
// but idles at a slow cadence until the Hub reports a connected client and
// calls setFast.
const EMPTY_STATS = { status: 'not started', uptime: null, memory: null, cpu: null, restarts: null, pid: null }

// A container entry carries image/ports/state for the Engine room; a project's
// live.pm2 speaks only the shared vocabulary.
const projectStats = ({ status, uptime, memory, cpu, restarts, pid }) =>
  ({ status, uptime, memory, cpu, restarts, pid })

export function createPoller({ db, config, liveState, intervalMs = 5000, idleIntervalMs = 60_000, containerClient = null, onCrashAlert = null }) {
  let timer = null
  let timerMs = null
  let ticking = false
  const crashWatch = onCrashAlert ? createCrashWatch({ onAlert: onCrashAlert }) : null
  let engine = containerClient
  const getEngine = () => {
    if (!engine && config.containerSocket) engine = createContainerClient({ socketPath: config.containerSocket })
    return engine
  }
  let appsDirBytes = null
  let duAt = 0 // 0 = never ran or invalidated by diskChanged — next tick walks
  let fast = false
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
      // Walk the apps dir before building `system` so fresh numbers reach
      // clients in the same tick instead of one interval late.
      if (duAt === 0 || (fast && Date.now() - duAt > DU_INTERVAL_MS)) {
        duAt = Date.now()
        appsDirBytes = await duAppsDir(config.appsDir)
      }

      if (imagesCheckedAt === 0 || (fast && Date.now() - imagesCheckedAt > IMAGES_INTERVAL_MS)) await refreshImages()

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

      // Feed the crash watch after both runtimes have fresh counters. pm2's
      // restart_time counts manual restarts too, so its alerts read as
      // "restarted", not "crashed" — which is also all the panel knows.
      if (crashWatch) {
        for (const [id, live] of Object.entries(liveState.projects)) {
          crashWatch.sample(id, live.info?.name ?? `project ${id}`, live.pm2?.restarts ?? null)
        }
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
        disk: { appsDirBytes, ...diskFree(config.appsDir) },
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

  const run = ms => {
    if (timer) clearInterval(timer)
    timer = setInterval(tick, ms)
    timerMs = ms
  }

  return {
    start() {
      if (timer) return
      tick()
      run(idleIntervalMs)
    },
    // Connected clients raise the cadence; nobody watching lowers it. The
    // poller itself never stops once started.
    setFast(on) {
      fast = on
      const ms = on ? intervalMs : idleIntervalMs
      if (timer && ms !== timerMs) {
        run(ms)
        if (on) tick()
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      timerMs = null
    },
    tick,
    refreshImages,
    // The panel changed the apps dir (a deploy landed): re-walk it on the
    // next tick even in idle mode, and take that tick now. If a tick is
    // already in flight the guard drops this one — duAt stays 0, so the
    // scheduled tick picks the walk up instead.
    diskChanged() {
      duAt = 0
      tick()
    },
  }
}
