<template>
  <div class="container">
    <div class="row" style="justify-content: space-between; margin-bottom: 16px">
      <h1 style="margin: 0">System</h1>
      <span class="hint" v-if="status">live · updated {{ timeAgo(status.updatedAt) }}</span>
    </div>

    <p v-if="!status" class="hint">Waiting for live data…</p>

    <div v-if="status" class="grid" style="margin-bottom: 16px">
      <div class="panel">
        <div class="hint">Panel uptime</div>
        <strong>{{ secondsToHuman(status.panelUptime) }}</strong>
      </div>
      <div class="panel">
        <div class="hint">Host uptime</div>
        <strong>{{ secondsToHuman(status.hostUptime) }}</strong>
      </div>
      <div class="panel">
        <div class="hint">Apps dir ({{ status.appsDir }})</div>
        <strong>{{ bytes(status.disk?.appsDirBytes) }}</strong>
        <span class="hint" v-if="status.disk?.free != null">
          — {{ bytes(status.disk.free) }} free of {{ bytes(status.disk.total) }}</span>
      </div>
      <div class="panel">
        <div class="hint">Memory</div>
        <strong>{{ bytes(status.memory.total - status.memory.free) }} / {{ bytes(status.memory.total) }}</strong>
      </div>
    </div>

    <div class="panel" v-if="status">
      <h2 style="margin-top: 0">pm2 processes</h2>
      <p v-if="status.pm2Error" class="error">pm2 unavailable: {{ status.pm2Error }}</p>
      <table v-else-if="status.pm2?.length">
        <thead>
          <tr><th>Name</th><th>Status</th><th>PID</th><th>Uptime</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in status.pm2" :key="p.name">
            <td class="mono">{{ p.name }}</td>
            <td><StatusBadge :status="p.status" /></td>
            <td class="hint">{{ p.pid || '—' }}</td>
            <td class="hint">{{ uptimeSince(p.uptime) }}</td>
            <td class="hint">{{ p.cpu ?? '—' }}%</td>
            <td class="hint">{{ bytes(p.memory) }}</td>
            <td class="hint">{{ p.restarts ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">No pm2 processes.</p>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import { store } from '../store.js'
import { bytes, uptimeSince, secondsToHuman, timeAgo } from '../lib/format.js'

export default {
  name: 'SystemView',
  components: { StatusBadge },
  computed: {
    // Fed by the server-side poller through LiveState — renders instantly on
    // navigation and refreshes itself every poll tick.
    status() {
      const s = store.live.system
      return s?.updatedAt ? s : null
    },
  },
  methods: { bytes, uptimeSince, secondsToHuman, timeAgo },
}
</script>
