<template>
  <div class="container">
    <div class="page-head">
      <h1 style="margin: 0">Engine room</h1>
      <span class="mono" style="font-size: 12px; color: var(--dim)" v-if="status">
        live · updated {{ timeAgo(liveUpdatedAt) }}
      </span>
    </div>

    <p v-if="!status" class="hint">Waiting for live data…</p>

    <!-- Always exactly three cards, so the grid never leaves a stray: three
         across on desktop, and on narrow screens uptime takes a full-width
         row above the other two. -->
    <div v-if="status" class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-pair">
          <div>
            <div class="stat-value">{{ uptimeSince(status.panelStartedAt) }}</div>
            <div class="stat-sub">panel</div>
          </div>
          <div>
            <div class="stat-value">{{ uptimeSince(status.hostBootAt) }}</div>
            <div class="stat-sub">host</div>
          </div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Memory</div>
        <div class="stat-value">{{ bytes(usedMemory) }}</div>
        <div class="stat-sub">{{ memoryPercent }}% of {{ bytes(status.memory.total) }} in use</div>
        <div class="stat-sub" v-if="loadavg">load {{ loadavg.join(' · ') }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Disk</div>
        <div class="stat-value">{{ bytes(status.disk?.free) }}</div>
        <div class="stat-sub">free of {{ bytes(status.disk?.total) }}</div>
        <div class="stat-sub stat-path" :title="status.appsDir">{{ appsDirNote }}</div>
      </div>
    </div>

    <div v-if="status">
      <div class="section-head">
        <span class="section-label">pm2 processes</span>
        <span class="mono" style="font-size: 12px; color: var(--dim)" v-if="processes.length">
          {{ processSummary }}
        </span>
      </div>

      <p v-if="status.pm2Error" class="error">pm2 unavailable: {{ status.pm2Error }}</p>
      <p v-else-if="!processes.length" class="hint">No pm2 processes.</p>
      <p v-if="actionError" class="error">{{ actionError }}</p>

      <div class="proc-list">
        <div v-for="p in processes" :key="p.name" class="proc-card" :class="{ open: opened === p.name }">
          <div class="proc-head">
            <div class="proc-main">
              <div class="proc-title">
                <span class="proc-name">{{ p.name }}</span>
                <StatusBadge :status="p.status" :href="p.appUrl" />
                <span v-if="p.isPanel" class="chip blue" title="The Skeppa panel itself">panel</span>
                <!-- No ↗ here: that arrow means "opens in a new tab" on the
                     status badge next to it, and this navigates in-app. -->
                <router-link v-if="p.project" :to="`/projects/${p.project.id}`" class="chip" style="cursor: pointer">
                  {{ p.project.name }}
                </router-link>
                <span v-else class="chip" title="Not deployed by Skeppa">external</span>
              </div>
              <div class="proc-stats">
                <span><i>pid</i>{{ p.pid || '—' }}</span>
                <span><i>up</i>{{ uptimeSince(p.uptime) }}</span>
                <span><i>cpu</i>{{ p.cpu ?? '—' }}%</span>
                <span><i>mem</i>{{ bytes(p.memory) }}</span>
                <span><i>restarts</i>{{ p.restarts ?? '—' }}</span>
              </div>
            </div>
            <div class="proc-actions">
              <button class="secondary" @click="toggleLogs(p.name)">
                {{ opened === p.name ? 'Hide logs' : 'Logs' }}
              </button>
              <button class="secondary" :disabled="busy === p.name" @click="run(p, 'start')">Start</button>
              <button class="secondary" :disabled="busy === p.name" @click="run(p, 'stop')">Stop</button>
              <button class="secondary" :disabled="busy === p.name" @click="run(p, 'restart')">Restart</button>
            </div>
          </div>
          <Pm2Logs v-if="opened === p.name" :name="p.name" />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import Pm2Logs from '../components/Pm2Logs.vue'
import { store, appUrlFor } from '../store.js'
import { api } from '../api.js'
import { bytes, uptimeSince, timeAgo } from '../lib/format.js'

export default {
  name: 'SystemView',
  components: { StatusBadge, Pm2Logs },
  data() {
    return { opened: null, busy: null, actionError: '' }
  },
  computed: {
    // Fed by the server-side poller through LiveState — renders instantly on
    // navigation and refreshes itself as diffs arrive.
    status() {
      const s = store.live.system
      return s?.appsDir ? s : null
    },
    liveUpdatedAt() {
      return store.liveUpdatedAt
    },
    usedMemory() {
      const m = this.status?.memory
      return m ? m.total - m.free : null
    },
    memoryPercent() {
      const m = this.status?.memory
      return m?.total ? Math.round(((m.total - m.free) / m.total) * 100) : '—'
    },
    // `du` is unavailable on some hosts (Windows) — leave the size out entirely
    // there rather than printing a dash between the label and the path.
    appsDirNote() {
      const size = this.status?.disk?.appsDirBytes
      return size != null
        ? `apps dir ${bytes(size)} · ${this.status.appsDir}`
        : `apps dir ${this.status?.appsDir ?? ''}`
    },
    // os.loadavg() is all zeroes on Windows — only worth showing where it means something.
    loadavg() {
      const l = this.status?.loadavg
      return l?.some(n => n > 0) ? l : null
    },
    // pm2 name -> project, so managed processes can link to their project page.
    projectsByPm2Name() {
      const map = {}
      for (const p of Object.values(store.live.projects ?? {})) {
        if (p.info?.pm2_name) map[p.info.pm2_name] = p.info
      }
      return map
    },
    // system.pm2 is keyed by process name (diff-friendly); flatten for the list.
    processes() {
      return Object.entries(this.status?.pm2 ?? {})
        .map(([name, p]) => {
          const project = this.projectsByPm2Name[name] ?? null
          return {
            ...p,
            name,
            project,
            appUrl: appUrlFor(project),
            isPanel: name === this.status?.selfPm2Name,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    processSummary() {
      const online = this.processes.filter(p => p.status === 'online').length
      const other = this.processes.length - online
      return `${online} online${other ? ` · ${other} not running` : ''}`
    },
  },
  methods: {
    bytes,
    uptimeSince,
    timeAgo,
    toggleLogs(name) {
      this.opened = this.opened === name ? null : name
    },
    async run(proc, act) {
      if (!this.confirmAction(proc, act)) return
      this.busy = proc.name
      this.actionError = ''
      try {
        await api.post(`/api/system/pm2/${encodeURIComponent(proc.name)}/${act}`)
      } catch (err) {
        this.actionError = `pm2 ${act} ${proc.name} failed: ${err.message}`
      } finally {
        this.busy = null
      }
    },
    confirmAction(proc, act) {
      if (act === 'start') return true
      if (proc.isPanel) {
        return confirm(
          `"${proc.name}" is the Skeppa panel itself — ${act}ing it takes this page offline` +
            `${act === 'stop' ? ' until you start it again from the server' : ' for a moment'}. Continue?`
        )
      }
      return confirm(`Really ${act} "${proc.name}"?`)
    },
  },
}
</script>
