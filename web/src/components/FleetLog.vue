<template>
  <!-- Who did what to which server from here, and how it went (server
       nodes/events.js): every change relayed, and each server's own life. -->
  <section class="panel fleet-log">
    <div class="fleet-log-head">
      <span class="section-label">{{ node ? 'Log' : 'Fleet log' }}</span>
      <select v-if="!node" v-model="pick" class="fleet-log-filter" aria-label="Show the log of" @change="load()">
        <option value="">every server</option>
        <option v-for="n in nodes" :key="n.id" :value="String(n.id)">{{ n.name }}</option>
      </select>
      <span class="spacer"></span>
      <button type="button" class="small secondary" :disabled="busy" @click="load()">↻ Refresh</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!events.length" class="hint" style="margin: 8px 0 0">Nothing done to {{ node || pick ? 'that server' : 'the fleet' }} from here yet.</p>
    <div v-else class="table-scroll">
      <table class="fleet-log-table">
        <thead>
          <tr><th>When</th><th v-if="!node">Server</th><th>Who</th><th>What</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="e in events" :key="e.id">
            <td class="mono fleet-log-when" :title="e.created_at">{{ timeAgo(e.created_at) }}</td>
            <td v-if="!node">{{ e.node_name }}</td>
            <td class="fleet-log-who">{{ e.username || (e.action === 'paired' ? 'its join code' : 'this panel') }}</td>
            <td>
              {{ describeAction(e.action) }}<template v-if="e.subject || processOf(e.action)">{{ " " }}<b>{{ e.subject || processOf(e.action) }}</b></template>
            </td>
            <td class="fleet-log-outcome">
              <span v-if="outcomeOf(e).text" class="chip" :class="outcomeOf(e).tone" :title="outcomeOf(e).why || e.action">{{ outcomeOf(e).text }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="more" style="margin-top: 8px">
      <button type="button" class="small secondary" :disabled="busy" @click="load({ older: true })">Show older</button>
    </div>
  </section>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import { timeAgo } from '../lib/format.js'
import { describeAction, processOf, outcomeOf } from '../lib/fleetLog.js'

const PAGE = 30

// The Fleet's log: every server's (with a filter), or one server's (`node`).
// Refreshed every 20 s while the page is in sight, and on `refresh()` — the
// page calls it after its own changes.
export default {
  name: 'FleetLog',
  props: {
    node: { type: Number, default: 0 },
  },
  data() {
    return { events: [], pick: '', more: false, busy: false, error: '' }
  },
  computed: {
    nodes() {
      return Object.values(store.live.nodes ?? {}).sort((a, b) => a.name.localeCompare(b.name))
    },
    nodeId() {
      return this.node ? String(this.node) : this.pick
    },
  },
  created() {
    this.load()
    this.timer = setInterval(() => {
      if (document.visibilityState !== 'hidden' && !this.busy) this.load({ quiet: true })
    }, 20_000)
  },
  beforeUnmount() {
    clearInterval(this.timer)
  },
  methods: {
    timeAgo,
    describeAction,
    processOf,
    outcomeOf,
    refresh() {
      return this.load({ quiet: true })
    },
    // The newest page, or (older) the page before what is shown. A quiet
    // refresh keeps what Show older brought in, below the newest page.
    async load({ older = false, quiet = false } = {}) {
      this.busy = true
      if (!quiet) this.error = ''
      try {
        const q = new URLSearchParams({ limit: String(PAGE) })
        if (this.nodeId) q.set('node', this.nodeId)
        if (older && this.events.length) q.set('before', String(this.events.at(-1).id))
        const page = await api.get(`/api/nodes/events?${q}`)
        const rows = Array.isArray(page) ? page : []
        if (older) this.events = [...this.events, ...rows]
        else if (!quiet || !this.events.length || rows[0]?.id !== this.events[0]?.id) {
          const kept = quiet ? this.events.filter(e => e.id < (rows.at(-1)?.id ?? 0)) : []
          this.events = [...rows, ...kept]
        }
        if (older || !quiet) this.more = rows.length === PAGE
      } catch (err) {
        if (!quiet) this.error = `The log could not be read: ${err.message}`
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style scoped>
.fleet-log { margin-top: 24px; }
.fleet-log-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.fleet-log-filter { width: auto; }
.fleet-log-table { width: 100%; font-size: 13px; }
.fleet-log-table td { padding: 5px 8px; vertical-align: top; }
.fleet-log-when, .fleet-log-who { white-space: nowrap; color: var(--dim); }
.fleet-log-outcome { text-align: right; white-space: nowrap; }
</style>
