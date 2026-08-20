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

      <!-- Only for installs that actually have a container engine: without a
           socket there is nothing to list, and the absence is not a fault. -->
      <template v-if="status.containerSocket">
        <div class="section-head">
          <span class="section-label">containers</span>
          <span class="mono" style="font-size: 12px; color: var(--dim)" v-if="containers.length">
            {{ containerSummary }}
          </span>
        </div>

        <p v-if="status.containerError" class="error">container engine unavailable: {{ status.containerError }}</p>
        <p v-else-if="!containers.length" class="hint">No containers on the engine.</p>
        <p v-if="containerActionError" class="error">{{ containerActionError }}</p>

        <div class="proc-list">
          <div v-for="c in containers" :key="c.name" class="proc-card" :class="{ open: openedContainer === c.name }">
            <div class="proc-head">
              <div class="proc-main">
                <div class="proc-title">
                  <span class="proc-name">{{ c.name }}</span>
                  <StatusBadge :status="c.status" :href="c.appUrl" />
                  <router-link v-if="c.project" :to="`/projects/${c.project.id}`" class="chip" style="cursor: pointer">
                    {{ c.project.name }}
                  </router-link>
                  <!-- A slug with no project left is an orphan the panel once
                       created — worth naming, but it is nobody's app now. -->
                  <span v-else-if="c.slug" class="chip amber" title="No project with this slug — left over from a deleted one">
                    {{ c.slug }}
                  </span>
                  <span v-else class="chip" title="Not created by Skeppa">external</span>
                </div>
                <div class="proc-stats">
                  <span><i>state</i>{{ c.state || '—' }}</span>
                  <!-- A stopped container has no uptime to show, but the age
                       of the container itself still says something. -->
                  <span v-if="c.uptime"><i>up</i>{{ uptimeSince(c.uptime) }}</span>
                  <span v-else><i>created</i>{{ timeAgo(c.createdAt) }}</span>
                  <span><i>cpu</i>{{ c.cpu ?? '—' }}%</span>
                  <span><i>mem</i>{{ bytes(c.memory) }}</span>
                  <span><i>restarts</i>{{ c.restarts ?? '—' }}</span>
                </div>
                <div class="proc-stats">
                  <span class="proc-image" :title="c.image"><i>image</i>{{ c.image || '—' }}</span>
                  <span v-if="c.ports?.length"><i>ports</i>{{ c.ports.join(' · ') }}</span>
                </div>
              </div>
              <div class="proc-actions">
                <button class="secondary" @click="toggleContainerLogs(c.name)">
                  {{ openedContainer === c.name ? 'Hide logs' : 'Logs' }}
                </button>
                <button class="secondary" :disabled="containerBusy === c.name" @click="runContainer(c, 'start')">Start</button>
                <button class="secondary" :disabled="containerBusy === c.name" @click="runContainer(c, 'stop')">Stop</button>
                <button class="secondary" :disabled="containerBusy === c.name" @click="runContainer(c, 'restart')">Restart</button>
              </div>
            </div>
            <Pm2Logs v-if="openedContainer === c.name" :name="c.name" :url="c.logsUrl" />
          </div>
        </div>
      </template>
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
    return {
      opened: null,
      busy: null,
      actionError: '',
      openedContainer: null,
      containerBusy: null,
      containerActionError: '',
    }
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
    // Containers carry the panel's own slug label; projects are keyed by id,
    // so the join needs a slug index of its own.
    projectsBySlug() {
      const map = {}
      for (const p of Object.values(store.live.projects ?? {})) {
        if (p.info?.slug) map[p.info.slug] = p.info
      }
      return map
    },
    // system.containers is keyed by container name, same as system.pm2.
    containers() {
      return Object.entries(this.status?.containers ?? {})
        .map(([name, c]) => {
          const project = this.projectsBySlug[c.slug] ?? null
          return {
            ...c,
            name,
            project,
            appUrl: project ? appUrlFor(project) : '',
            logsUrl: `/api/system/containers/${encodeURIComponent(name)}/logs`,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    containerSummary() {
      const running = this.containers.filter(c => c.status === 'online').length
      const other = this.containers.length - running
      return `${running} running${other ? ` · ${other} not running` : ''}`
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
    toggleContainerLogs(name) {
      this.openedContainer = this.openedContainer === name ? null : name
    },
    // Restart throws a panel-owned container away and recreates it — that is
    // the only way freshly decrypted ENV gets in — so it is confirmed like the
    // stop beside it. Start is harmless enough to go through unasked.
    async runContainer(container, act) {
      if (act !== 'start' && !confirm(`Really ${act} "${container.name}"?`)) return
      this.containerBusy = container.name
      this.containerActionError = ''
      try {
        await api.post(`/api/system/containers/${encodeURIComponent(container.name)}/${act}`)
      } catch (err) {
        this.containerActionError = `${act} ${container.name} failed: ${err.message}`
      } finally {
        this.containerBusy = null
      }
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
