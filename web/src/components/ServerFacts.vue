<template>
  <!-- How a server is doing, at a glance — one panel: what it is (up how
       long, its harbor gate, whether it reports) on a line, and the three
       things that fill up under it, each read the same way. The same block on
       a server's Overview and over this panel's own Engine room. -->
  <div class="facts">
    <div class="facts-meta">
      <span v-if="node" class="facts-reporting" :class="{ away: !node.online }">
        <span class="dot" :class="node.online ? 'green' : 'red'" aria-hidden="true"></span>{{ reporting }}
      </span>
      <span v-if="online && system.hostBootAt" :title="`The host has been up since ${new Date(system.hostBootAt).toLocaleString()}`">
        up <b>{{ uptimeSince(system.hostBootAt) }}</b>
      </span>
      <span v-if="online && system.panelStartedAt" :title="`The panel started ${new Date(system.panelStartedAt).toLocaleString()}`">
        panel <b>{{ uptimeSince(system.panelStartedAt) }}</b>
      </span>
      <span :title="gate ? 'Its harbor gate routes subdomain.' + gate : 'No base domain: nothing is routed by subdomain'">
        gate <b :class="{ unset: !gate }">{{ gate || 'not set' }}</b>
      </span>
    </div>
    <div class="facts-gauges">
      <div v-for="g in gauges" :key="g.key" class="gauge" :class="g.tone">
        <div class="gauge-head">
          <span class="gauge-label">{{ g.label }}</span>
          <span v-if="g.percent != null" class="gauge-percent">{{ g.percent }}%</span>
        </div>
        <div class="gauge-value" :title="g.title">{{ g.value }}</div>
        <div class="gauge-meter" aria-hidden="true">
          <span v-if="g.percent != null" :style="{ width: Math.min(100, g.percent) + '%' }"></span>
        </div>
        <div class="gauge-sub" :title="g.subTitle">{{ g.sub }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import { shipInject } from '../lib/ship.js'
import { bytes, timeAgo, uptimeSince } from '../lib/format.js'

const tone = percent => (percent == null ? '' : percent >= 92 ? 'crit' : percent >= 80 ? 'warn' : '')
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null)

export default {
  name: 'ServerFacts',
  inject: shipInject, // whose (lib/ship.js)
  props: {
    // A fleet server's record (store.live.nodes), for whether and when it
    // reported; none for this panel.
    node: { type: Object, default: null },
  },
  computed: {
    system() {
      return this.ship.live.system ?? {}
    },
    // What it says now: this panel always, a fleet server while it reports.
    online() {
      return !this.node || this.node.online
    },
    reporting() {
      if (this.node.online) return 'reporting now'
      return this.node.lastSeenAt ? `last seen ${timeAgo(this.node.lastSeenAt)}` : 'never reported'
    },
    gate() {
      return this.ship.live.proxy?.baseDomain ?? ''
    },
    gauges() {
      const s = this.system
      // os.loadavg() is all zeroes on Windows: nothing to read there
      const load = this.online && Array.isArray(s.loadavg) && s.loadavg.some(n => n > 0) ? s.loadavg : null
      const cores = s.cpuCount || 0
      const loadFull = cores ? `${cores} is every core busy` : 'one per core is every core busy'
      const mem = this.online && s.memory?.total ? s.memory : null
      const disk = Number.isFinite(s.disk?.total) && Number.isFinite(s.disk?.free) && s.disk.total > 0 ? s.disk : null
      const appsDir = s.disk?.appsDirBytes != null ? `apps ${bytes(s.disk.appsDirBytes)}` : ''
      const loadPercent = load && cores ? pct(load[0], cores) : null
      const memPercent = mem ? pct(mem.total - mem.free, mem.total) : null
      const diskPercent = disk ? pct(disk.total - disk.free, disk.total) : null
      return [
        {
          key: 'load',
          label: 'Load',
          value: load ? String(load[0]) : '—',
          percent: loadPercent,
          tone: tone(loadPercent),
          sub: cores ? `of ${cores} ${cores === 1 ? 'core' : 'cores'}${load ? ` · ${load[1]} · ${load[2]}` : ''}` : '',
          title: `Average over 1, 5 and 15 minutes — ${loadFull}`,
        },
        {
          key: 'memory',
          label: 'Memory',
          value: mem ? bytes(mem.total - mem.free) : '—',
          percent: memPercent,
          tone: tone(memPercent),
          sub: mem ? `of ${bytes(mem.total)}` : '',
        },
        {
          key: 'disk',
          label: 'Disk',
          value: disk ? `${bytes(disk.free)} free` : '—',
          percent: diskPercent,
          tone: tone(diskPercent),
          sub: disk ? `of ${bytes(disk.total)}${appsDir ? ` · ${appsDir}` : ''}` : '',
          // where the apps live, for whoever wants it — not printed out
          subTitle: s.appsDir ? `apps dir: ${s.appsDir}` : '',
        },
      ]
    },
  },
  methods: {
    uptimeSince,
  },
}
</script>

<style scoped>
.facts {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 1px 0 var(--shadow);
  overflow: hidden;
  margin-bottom: 22px;
}

/* what it is, on one line */
.facts-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 22px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 13px;
  color: var(--dim);
}
.facts-meta b {
  font-family: var(--mono);
  font-weight: 600;
  color: var(--ink);
}
.facts-meta b.unset { color: var(--dim); font-weight: 400; }
.facts-reporting { color: var(--ink); font-weight: 600; }
.facts-reporting.away { color: var(--red); }
.facts-reporting .dot { margin-right: 7px; }

/* the three that fill up, side by side; stacked where it is narrow */
.facts-gauges {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}
@media (max-width: 640px) {
  .facts-gauges { grid-template-columns: 1fr; }
  .gauge + .gauge { border-left: 0; border-top: 1px solid var(--line-soft); }
}
.gauge {
  padding: 16px 20px 18px;
  min-width: 0;
}
.gauge + .gauge { border-left: 1px solid var(--line-soft); }
.gauge-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.gauge-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--dim);
}
.gauge-percent {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.gauge-value {
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 600;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gauge-meter {
  height: 5px;
  border-radius: 999px;
  background: var(--line-soft);
  margin: 10px 0 8px;
  overflow: hidden;
}
.gauge-meter span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.6s ease;
}
.gauge-sub {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* filling up: the bar and its share say so */
.gauge.warn .gauge-meter span { background: var(--amber); }
.gauge.warn .gauge-percent { color: var(--amber); }
.gauge.crit .gauge-meter span { background: var(--red); }
.gauge.crit .gauge-percent { color: var(--red); }
</style>
