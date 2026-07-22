<template>
  <div class="container">
    <div class="row" style="justify-content: space-between; margin-bottom: 16px">
      <h1 style="margin: 0">System</h1>
      <button class="secondary" @click="load">↻ Refresh</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

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
      <p v-if="status.pm2?.error" class="error">pm2 unavailable: {{ status.pm2.error }}</p>
      <table v-else-if="status.pm2?.length">
        <thead>
          <tr><th>Name</th><th>Status</th><th>PID</th><th>Uptime</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in status.pm2" :key="p.pm_id">
            <td class="mono">{{ p.name }}</td>
            <td><StatusBadge :status="p.pm2_env?.status" /></td>
            <td class="hint">{{ p.pid || '—' }}</td>
            <td class="hint">{{ uptimeSince(p.pm2_env?.pm_uptime) }}</td>
            <td class="hint">{{ p.monit?.cpu ?? '—' }}%</td>
            <td class="hint">{{ bytes(p.monit?.memory) }}</td>
            <td class="hint">{{ p.pm2_env?.restart_time ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">No pm2 processes.</p>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import { api } from '../api.js'
import { bytes, uptimeSince, secondsToHuman } from '../lib/format.js'

export default {
  name: 'SystemView',
  components: { StatusBadge },
  data() {
    return { status: null, error: '' }
  },
  async created() {
    await this.load()
  },
  methods: {
    bytes,
    uptimeSince,
    secondsToHuman,
    async load() {
      this.error = ''
      try {
        this.status = await api.get('/api/system/status')
      } catch (err) {
        this.error = err.message
      }
    },
  },
}
</script>
