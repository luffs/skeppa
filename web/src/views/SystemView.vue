<template>
  <div class="container">
    <div class="page-head">
      <h1 style="margin: 0">Engine room</h1>
      <span class="mono" style="font-size: 12px" :style="{ color: connected ? 'var(--dim)' : 'var(--amber, #d29922)' }" v-if="status">
        {{ updatedLabel }}
      </span>
    </div>

    <p v-if="!status" class="hint">Waiting for live data…</p>

    <!-- Always exactly three cards, so the grid never leaves a stray: three
         across on desktop, and on narrow screens uptime takes a full-width
         row above the other two. -->
    <div v-if="status" class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <!-- Label over value, the same vocabulary as the process cards. -->
        <div class="stat-pair">
          <div>
            <div class="stat-tag">panel</div>
            <div class="stat-value">{{ uptimeSince(status.panelStartedAt) }}</div>
          </div>
          <div>
            <div class="stat-tag">host</div>
            <div class="stat-value">{{ uptimeSince(status.hostBootAt) }}</div>
          </div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Memory</div>
        <div class="stat-value">{{ bytes(usedMemory) }}</div>
        <div class="stat-meter" v-if="memoryUsedPercent != null">
          <span :class="meterClass(memoryUsedPercent)" :style="{ width: memoryUsedPercent + '%' }"></span>
        </div>
        <div class="stat-sub">{{ memoryPercent }}% of {{ bytes(status.memory.total) }} in use</div>
        <!-- Load is a count, not a percentage: read against the cores, it
             says how busy the host is (a load of 4 on 4 cores is full). -->
        <div class="stat-sub" v-if="loadavg" :title="loadHint">
          load {{ loadavg.join(' · ') }}<template v-if="cpuCount"> of {{ cpuCount }} {{ cpuCount === 1 ? 'core' : 'cores' }}</template>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Disk</div>
        <div class="stat-value">{{ bytes(status.disk?.free) }}</div>
        <div class="stat-meter" v-if="diskUsedPercent != null">
          <span :class="meterClass(diskUsedPercent)" :style="{ width: diskUsedPercent + '%' }"></span>
        </div>
        <!-- Worded like the memory card so the meter under it reads as what
             it is — used share — while the big number stays the free space. -->
        <div class="stat-sub" v-if="diskUsedPercent != null">
          {{ diskUsedPercent }}% of {{ bytes(status.disk.total) }} in use
        </div>
        <div class="stat-sub" v-else>free of {{ bytes(status.disk?.total) }}</div>
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

      <!-- One row per process, the readings in fixed columns so they compare
           straight down — the same columns, in the same order, as the
           containers table below. What can be done to a process sits behind
           its ⋮; its logs open as a row of their own underneath. -->
      <div v-if="processes.length" class="panel proc-table">
        <table>
          <colgroup>
            <col /><col class="c-project" /><col class="c-status" /><col class="c-up" /><col class="c-cpu" />
            <col class="c-mem" /><col class="c-restarts" /><col class="c-pid" /><col class="c-menu" />
          </colgroup>
          <thead>
            <tr>
              <!-- Every header sorts: a click picks the column, a second one
                   flips it. Names go A→Z first, readings biggest first. -->
              <th
                v-for="col in processColumns"
                :key="col.key"
                :class="[col.cls, { num: col.num }]"
                :aria-sort="ariaSort('pm2', col.key)"
                :title="col.title || null"
              >
                <button type="button" class="sort-head" :class="{ sorted: sorts.pm2.key === col.key }" @click="sortBy('pm2', col.key)">
                  {{ col.label }}<span class="sort-arrow" aria-hidden="true">{{ sorts.pm2.dir === 'asc' ? '▲' : '▼' }}</span>
                </button>
              </th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="p in sortedProcesses" :key="p.name">
              <tr :class="{ open: opened === p.name }">
                <td><div class="proc-name" :title="p.name">{{ p.name }}</div></td>
                <td class="c-project">
                  <span v-if="p.isPanel" class="chip blue" title="The Skeppa panel itself">panel</span>
                  <span v-else-if="p.isProxy" class="chip blue" title="The panel's own reverse proxy — routes subdomains to the apps">harbor gate</span>
                  <router-link v-else-if="p.project" :to="`/projects/${p.project.id}`" class="chip proc-project">{{ p.project.name }}</router-link>
                  <span v-else class="chip" title="Not deployed by Skeppa">external</span>
                </td>
                <td><StatusBadge :status="p.status" :href="p.appUrl" /></td>
                <td class="num c-up">{{ uptimeSince(p.uptime) }}</td>
                <td class="num c-cpu">{{ p.cpu == null ? '—' : `${p.cpu}%` }}</td>
                <td class="num">{{ bytes(p.memory) }}</td>
                <td class="num c-restarts">{{ p.restarts ?? '—' }}</td>
                <td class="num c-pid">{{ p.pid || '—' }}</td>
                <td class="menu">
                  <ActionMenu :label="`Process ${p.name}`" :items="processMenu(p)" @select="onProcess(p, $event)" />
                </td>
              </tr>
              <tr v-if="opened === p.name" class="proc-logs-row">
                <td colspan="9"><Pm2Logs :name="p.name" /></td>
              </tr>
            </template>
          </tbody>
        </table>
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

        <div v-if="containers.length" class="panel proc-table">
          <table>
            <colgroup>
              <col /><col class="c-project" /><col class="c-status" /><col class="c-up" /><col class="c-cpu" />
              <col class="c-mem" /><col class="c-restarts" /><col class="c-pid" /><col class="c-menu" />
            </colgroup>
            <thead>
              <tr>
                <th
                  v-for="col in containerColumns"
                  :key="col.key"
                  :class="[col.cls, { num: col.num }]"
                  :aria-sort="ariaSort('containers', col.key)"
                  :title="col.title || null"
                >
                  <button type="button" class="sort-head" :class="{ sorted: sorts.containers.key === col.key }" @click="sortBy('containers', col.key)">
                    {{ col.label }}<span class="sort-arrow" aria-hidden="true">{{ sorts.containers.dir === 'asc' ? '▲' : '▼' }}</span>
                  </button>
                </th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="c in sortedContainers" :key="c.name">
                <tr :class="{ open: openedContainer === c.name }">
                  <td>
                    <div class="proc-name" :title="c.name">{{ c.name }}</div>
                    <!-- The container-only facts, small under the name: the
                         image (whole ref on hover), ports, and the raw state
                         only when it says more than the badge — exited,
                         created, paused. -->
                    <div class="proc-facts">
                      <span class="proc-image" :title="c.image">{{ shortImage(c.image) || '—' }}</span>
                      <!-- The tag moved under a running container: worth
                           saying, but not an error — the app is fine, just not
                           on the new image until something restarts it. -->
                      <span
                        v-if="c.imageSuperseded"
                        class="chip amber"
                        title="The tag now points at a different image in the store — restart to run the newer one"
                      >superseded</span>
                      <span v-if="c.ports?.length">{{ c.ports.join(' · ') }}</span>
                      <span v-if="c.state && c.state !== 'running'">{{ c.state }}</span>
                    </div>
                  </td>
                  <td class="c-project">
                    <router-link v-if="c.project" :to="`/projects/${c.project.id}`" class="chip proc-project">{{ c.project.name }}</router-link>
                    <!-- A slug with no project left is an orphan the panel once
                         created — worth naming, but it is nobody's app now. -->
                    <span v-else-if="c.slug" class="chip amber" title="No project with this slug — left over from a deleted one">{{ c.slug }}</span>
                    <span v-else class="chip" title="Not created by Skeppa">external</span>
                  </td>
                  <td><StatusBadge :status="c.status" :href="c.appUrl" /></td>
                  <!-- A stopped container has no uptime, but its age still says something. -->
                  <td class="num c-up" :title="c.uptime ? null : 'Not running — how long ago the container was created'">
                    {{ c.uptime ? uptimeSince(c.uptime) : timeAgo(c.createdAt) }}
                  </td>
                  <td class="num c-cpu">{{ c.cpu == null ? '—' : `${c.cpu}%` }}</td>
                  <td class="num">
                    {{ bytes(c.memory) }}
                    <span
                      v-if="c.memPercent != null"
                      class="stat-meter"
                      :title="`${c.memPercent}% of the ${c.project.memory_mb} MB limit`"
                    ><span :class="meterClass(c.memPercent)" :style="{ width: c.memPercent + '%' }"></span></span>
                  </td>
                  <td class="num c-restarts" :title="CRASHES_HINT">{{ c.restarts ?? '—' }}</td>
                  <td class="num c-pid">{{ c.pid || '—' }}</td>
                  <td class="menu">
                    <ActionMenu :label="`Container ${c.name}`" :items="containerMenu(c)" @select="onContainer(c, $event)" />
                  </td>
                </tr>
                <tr v-if="openedContainer === c.name" class="proc-logs-row">
                  <td colspan="9"><Pm2Logs :name="c.name" :url="c.logsUrl" :prev-url="c.prevUrl" /></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import Pm2Logs from '../components/Pm2Logs.vue'
import ActionMenu from '../components/ActionMenu.vue'
import { store, appUrlFor } from '../store.js'
import { api } from '../api.js'
import { confirmDialog } from '../lib/dialog.js'
import { bytes, uptimeSince, timeAgo } from '../lib/format.js'
import { runsSupersededImage } from '../lib/images.js'
import { sortRows, nextSort, loadSort, saveSort } from '../lib/engineSort.js'

// The headers of both tables, in column order. `cls` folds a column away on
// narrower windows (style.css); `num` right-aligns it.
const COLUMNS = [
  { key: 'project', label: 'Project', cls: 'c-project' },
  { key: 'status', label: 'Status' },
  { key: 'up', label: 'Up', cls: 'c-up', num: true },
  { key: 'cpu', label: 'CPU', cls: 'c-cpu', num: true },
  { key: 'mem', label: 'Mem', num: true },
  { key: 'restarts', label: 'Restarts', cls: 'c-restarts', num: true },
  { key: 'pid', label: 'PID', cls: 'c-pid', num: true },
]
const SORT_KEYS = { pm2: 'skeppa.engineSort.pm2', containers: 'skeppa.engineSort.containers' }

// The engine counts only the restarts its own on-failure policy performed, so
// this is a crash counter, not an activity log: restarting from here recreates
// the container and the new one starts back at zero.
const CRASHES_HINT = 'Crashes the engine restarted the container after. A restart from here recreates it, which starts the count over.'

export default {
  name: 'SystemView',
  components: { StatusBadge, Pm2Logs, ActionMenu },
  data() {
    return {
      opened: null,
      busy: null,
      actionError: '',
      openedContainer: null,
      containerBusy: null,
      containerActionError: '',
      CRASHES_HINT,
      // One sort per table, remembered in the browser.
      sorts: { pm2: loadSort(SORT_KEYS.pm2), containers: loadSort(SORT_KEYS.containers) },
    }
  },
  computed: {
    // Cores on the host, 0 when the server could not say.
    cpuCount() {
      return this.status?.cpuCount || 0
    },
    loadHint() {
      const full = this.cpuCount ? `${this.cpuCount} is every core busy` : 'one per core is every core busy'
      return `Average over 1, 5 and 15 minutes — ${full}`
    },
    // The headers, with CPU's hint saying what full would read.
    columns() {
      const n = this.cpuCount
      const cpuHint = n > 1 ? `% of one core — all ${n} cores busy is ${n * 100}%` : '% of one core'
      return COLUMNS.map(c => (c.key === 'cpu' ? { ...c, title: cpuHint } : c))
    },
    processColumns() {
      return [{ key: 'name', label: 'Process' }, ...this.columns]
    },
    // The engine's restart count is a crash count (see CRASHES_HINT).
    containerColumns() {
      return [{ key: 'name', label: 'Container' }, ...this.columns.map(c => (c.key === 'restarts'
        ? { ...c, label: 'Crashes', title: CRASHES_HINT }
        : c))]
    },
    // Fed by the server-side poller through LiveState — renders instantly on
    // navigation and refreshes itself as diffs arrive.
    status() {
      const s = store.live.system
      return s?.appsDir ? s : null
    },
    connected() {
      return store.connected
    },
    // Diffs arrive every few seconds while connected, so a seconds counter
    // would mostly flicker between 0s and 5s — "just now" is the honest
    // reading under 10s, and the counter takes over once things go quiet.
    updatedLabel() {
      if (!this.connected) return `reconnecting · last data ${timeAgo(this.liveUpdatedAt)}`
      const fresh = this.liveUpdatedAt && store.now - this.liveUpdatedAt < 10_000
      return `live · updated ${fresh ? 'just now' : timeAgo(this.liveUpdatedAt)}`
    },
    liveUpdatedAt() {
      return store.liveUpdatedAt
    },
    usedMemory() {
      const m = this.status?.memory
      return m ? m.total - m.free : null
    },
    memoryPercent() {
      return this.memoryUsedPercent ?? '—'
    },
    // Used fractions for the meters. null hides the bar entirely — a full or
    // empty bar on missing data would be a claim, not an absence.
    memoryUsedPercent() {
      const m = this.status?.memory
      return m?.total ? Math.round(((m.total - m.free) / m.total) * 100) : null
    },
    diskUsedPercent() {
      const d = this.status?.disk
      return d?.total && d.free != null ? Math.round(((d.total - d.free) / d.total) * 100) : null
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
          const isPanel = name === this.status?.selfPm2Name
          const isProxy = name === this.status?.proxyPm2Name
          return {
            ...p,
            name,
            project,
            appUrl: appUrlFor(project),
            isPanel,
            isProxy,
            // What the Project column says, for sorting by it.
            projectLabel: isPanel ? 'panel' : isProxy ? 'harbor gate' : project?.name ?? 'external',
          }
        })
    },
    sortedProcesses() {
      return sortRows(this.processes, this.sorts.pm2, store.now)
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
          // With a configured limit the memory reading finally has a
          // denominator, which is what makes a meter honest.
          const limit = project?.memory_mb
          return {
            ...c,
            name,
            project,
            appUrl: project ? appUrlFor(project) : '',
            logsUrl: `/api/system/containers/${encodeURIComponent(name)}/logs`,
            // Only a container the panel owns has a post-mortem to show.
            prevUrl: project ? `/api/system/containers/${encodeURIComponent(name)}/logs/previous` : '',
            memPercent: limit && c.memory != null
              ? Math.min(100, Math.round((c.memory / (limit * 1024 * 1024)) * 100))
              : null,
            imageSuperseded: runsSupersededImage(store.live.images, c),
            projectLabel: project?.name ?? (c.slug || 'external'),
          }
        })
    },
    sortedContainers() {
      return sortRows(this.containers, this.sorts.containers, store.now)
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
    // Managed images all live under the one reserved prefix with the one
    // tag — "localhost/skeppa/bun-node:latest" carries one word of signal.
    // Registry refs stay whole: there the ref IS the information. The full
    // string remains in the cell's tooltip.
    shortImage(ref) {
      const prefix = store.live.images?.managedPrefix
      if (!prefix || !ref?.startsWith(prefix)) return ref
      return ref.slice(prefix.length).replace(/:latest$/, '')
    },
    // Anything the engine or pm2 would let us stop.
    running(status) {
      return status === 'online' || status === 'launching' || status === 'stopping'
    },
    // State as the app's usual dot colors; in-flight states pulse.
    statusDot(status) {
      if (status === 'online') return 'green'
      if (status === 'launching' || status === 'stopping' || status === 'queued') return 'amber pulse'
      if (status === 'stopped' || status === 'errored' || status === 'failed') return 'red'
      return ''
    },
    // Meter color by how close to full: calm until 80%, amber to 92%, red past.
    meterClass(usedPercent) {
      return usedPercent >= 92 ? 'crit' : usedPercent >= 80 ? 'warn' : ''
    },
    // A row's ⋮: its logs first (the everyday look), then only the actions
    // the state can use — a Start on something running and a Stop on
    // something stopped were noise. Busy rows keep the menu but not the acts.
    stateItems(status, busy, { dangerStop = false } = {}) {
      if (!this.running(status)) return [{ key: 'start', label: 'Start', disabled: busy }]
      return [
        { key: 'restart', label: 'Restart', disabled: busy },
        { key: 'stop', label: 'Stop', danger: dangerStop, disabled: busy },
      ]
    },
    processMenu(p) {
      return [
        { key: 'logs', label: this.opened === p.name ? 'Hide logs' : 'Show logs' },
        { separator: true },
        ...this.stateItems(p.status, this.busy === p.name, { dangerStop: p.isPanel }),
      ]
    },
    containerMenu(c) {
      return [
        { key: 'logs', label: this.openedContainer === c.name ? 'Hide logs' : 'Show logs' },
        { separator: true },
        ...this.stateItems(c.status, this.containerBusy === c.name),
      ]
    },
    onProcess(p, key) {
      if (key === 'logs') this.toggleLogs(p.name)
      else this.run(p, key)
    },
    onContainer(c, key) {
      if (key === 'logs') this.toggleContainerLogs(c.name)
      else this.runContainer(c, key)
    },
    sortBy(table, key) {
      this.sorts[table] = nextSort(this.sorts[table], key)
      saveSort(SORT_KEYS[table], this.sorts[table])
    },
    // For the header's aria-sort: only the sorted column says which way.
    ariaSort(table, key) {
      const s = this.sorts[table]
      return s.key === key ? (s.dir === 'asc' ? 'ascending' : 'descending') : null
    },
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
      if (act !== 'start' && !(await confirmDialog(`Really ${act} "${container.name}"?`, { confirmLabel: act.charAt(0).toUpperCase() + act.slice(1) }))) return
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
      if (!(await this.confirmAction(proc, act))) return
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
    // Resolves to a boolean; start needs no asking.
    confirmAction(proc, act) {
      if (act === 'start') return true
      const label = act.charAt(0).toUpperCase() + act.slice(1)
      if (proc.isPanel) {
        return confirmDialog(
          `"${proc.name}" is the Skeppa panel itself — ${act === 'stop' ? 'stopping' : 'restarting'} it takes this page offline` +
            `${act === 'stop' ? ' until you start it again from the server' : ' for a moment'}. Continue?`,
          { confirmLabel: label, danger: true }
        )
      }
      return confirmDialog(`Really ${act} "${proc.name}"?`, { confirmLabel: label })
    },
  },
}
</script>
