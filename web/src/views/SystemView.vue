<template>
  <div class="container">
    <div class="page-head">
      <h1 style="margin: 0">Engine room</h1>
      <span class="mono" style="font-size: 12px; color: var(--dim)" v-if="status">
        live · updated {{ timeAgo(liveUpdatedAt) }}
      </span>
    </div>

    <p v-if="!status" class="hint">Waiting for live data…</p>

    <div v-if="status" class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Panel uptime</div>
        <div class="stat-value">{{ uptimeSince(status.panelStartedAt) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Host uptime</div>
        <div class="stat-value">{{ uptimeSince(status.hostBootAt) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Apps dir · {{ status.appsDir }}</div>
        <div class="stat-value">{{ bytes(status.disk?.appsDirBytes) }}</div>
        <div class="stat-sub" v-if="status.disk?.free != null">
          {{ bytes(status.disk.free) }} free of {{ bytes(status.disk.total) }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Memory</div>
        <div class="stat-value">{{ bytes(status.memory.total - status.memory.free) }} / {{ bytes(status.memory.total) }}</div>
      </div>
    </div>

    <div class="panel flush" v-if="status">
      <div class="section-label" style="padding: 16px 20px 0">pm2 processes</div>
      <p v-if="status.pm2Error" class="error" style="padding: 0 20px 16px">pm2 unavailable: {{ status.pm2Error }}</p>
      <div v-else-if="pm2List.length" class="table-scroll">
        <table style="min-width: 640px">
          <thead>
            <tr><th>Name</th><th>Status</th><th>PID</th><th>Uptime</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in pm2List" :key="p.name">
              <td class="mono">{{ p.name }}</td>
              <td><StatusBadge :status="p.status" /></td>
              <td class="mono" style="color: var(--dim)">{{ p.pid || '—' }}</td>
              <td class="mono" style="color: var(--dim)">{{ uptimeSince(p.uptime) }}</td>
              <td class="mono" style="color: var(--dim)">{{ p.cpu ?? '—' }}%</td>
              <td class="mono" style="color: var(--dim)">{{ bytes(p.memory) }}</td>
              <td class="mono" style="color: var(--dim)">{{ p.restarts ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="hint" style="padding: 12px 20px 16px">No pm2 processes.</p>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import { store } from '../store.js'
import { bytes, uptimeSince, timeAgo } from '../lib/format.js'

export default {
  name: 'SystemView',
  components: { StatusBadge },
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
    // system.pm2 is keyed by process name (diff-friendly); flatten for the table.
    pm2List() {
      return Object.entries(this.status?.pm2 ?? {}).map(([name, p]) => ({ name, ...p }))
    },
  },
  methods: { bytes, uptimeSince, timeAgo },
}
</script>
