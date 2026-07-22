import { jlist } from '../deploy/pm2.js'

// Refreshes projects[*].pm2 in LiveState from `pm2 jlist`. Only runs while at
// least one WS client is connected (the Hub starts/stops it).
export function createPoller({ db, liveState, intervalMs = 5000 }) {
  let timer = null
  let ticking = false

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const projects = db.query('SELECT id, pm2_name FROM projects').all()
      if (projects.length === 0) return
      let byName = new Map()
      try {
        const list = await jlist()
        byName = new Map(list.map(p => [p.name, p]))
      } catch {
        // pm2 unavailable — statuses become 'unknown' below
      }
      for (const { id, pm2_name } of projects) {
        const live = liveState.projects[id]
        if (!live) continue
        const proc = byName.get(pm2_name)
        live.pm2 = proc
          ? {
              status: proc.pm2_env?.status ?? 'unknown',
              uptime: proc.pm2_env?.pm_uptime ?? null,
              memory: proc.monit?.memory ?? null,
              cpu: proc.monit?.cpu ?? null,
            }
          : { status: 'not started', uptime: null, memory: null, cpu: null }
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
