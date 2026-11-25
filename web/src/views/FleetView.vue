<template>
  <div class="container">
    <div class="page-head" style="margin-bottom: 10px">
      <div>
        <h1 style="margin: 0">The fleet</h1>
        <div class="page-sub">
          <template v-if="nodes.length">
            {{ nodes.length }} other server{{ nodes.length === 1 ? '' : 's' }} report{{ nodes.length === 1 ? 's' : '' }} here ·
            {{ onlineCount }} online
          </template>
          <template v-else>Other Skeppa servers, reporting to this one</template>
          <template v-if="driftCount"> · <span class="fleet-drift">{{ driftCount }} on another version than this panel ({{ hereVersion }})</span></template>
        </div>
      </div>
      <div class="row">
        <button
          v-if="updatable.length"
          class="secondary"
          :disabled="updatingAll"
          title="Deploy each server's own panel project: the latest commit of the branch it follows"
          @click="updateAll"
        >{{ updatingAll ? 'Updating…' : `Update ${updatable.length === 1 ? 'the panel' : `all ${updatable.length} panels`}` }}</button>
        <button v-if="!adding" @click="startAdding">+ Add a server</button>
      </div>
    </div>

    <div v-if="adding" class="panel fleet-add">
      <div class="row">
        <input
          ref="name"
          v-model="newName"
          maxlength="40"
          placeholder="Name it — hemma-2, jobb-db, …"
          @keydown.enter.prevent="create"
          @keydown.esc.prevent="adding = false"
        />
        <button class="small" :disabled="busy || !newName.trim()" @click="create">{{ busy ? 'Adding…' : 'Add' }}</button>
        <button class="small secondary" :disabled="busy" @click="adding = false">Cancel</button>
      </div>
      <p v-if="addError" class="error">{{ addError }}</p>
      <p v-else class="hint" style="margin: 6px 0 0">
        You get a one-time code to pair it with. Its projects are then run from here; its own settings stay on its own panel.
      </p>
    </div>

    <!-- The code is shown once: this panel keeps only its hash. -->
    <div v-if="join" class="panel fleet-join">
      <div class="row" style="justify-content: space-between">
        <span class="section-label">Pair {{ join.name }}</span>
        <button class="small secondary" @click="join = null">Done</button>
      </div>
      <p style="margin: 8px 0 6px">On that server, in its Skeppa checkout:</p>
      <div class="fleet-command">
        <code>{{ joinCommand }}</code>
        <CopyButton :text="joinCommand" label="Copy the command" />
      </div>
      <p class="hint" style="margin: 8px 0 0">
        Good once, until {{ joinUntil }}. Then restart that panel (<code>pm2 reload skeppa</code>) and it shows up here.
        It dials this panel at <code>/agent</code>, so this panel needs no way in to it.
      </p>
    </div>

    <div v-if="!nodes.length && !adding && !join" class="panel" style="margin-top: 22px; max-width: 680px">
      <p style="margin-top: 0"><strong>No servers in the fleet yet.</strong></p>
      <p class="hint" style="margin-bottom: 0">
        Another Skeppa can report here: its projects, their state and their voyages, live. Keep fleets
        apart where trust ends — one at home, one at work — because whoever runs this panel sees all of it.
      </p>
    </div>

    <section v-for="n in nodes" :key="n.id" class="panel fleet-node">
      <div class="fleet-node-head">
        <span class="dot" :class="n.online ? 'green' : n.paired ? 'red' : ''" aria-hidden="true"></span>
        <template v-if="renaming === n.id">
          <input v-model="renameTo" maxlength="40" class="fleet-rename" @keydown.enter.prevent="rename(n)" @keydown.esc.prevent="renaming = 0" />
          <button class="small" :disabled="busy" @click="rename(n)">Save</button>
          <button class="small secondary" @click="renaming = 0">Cancel</button>
        </template>
        <h2 v-else class="fleet-node-name">{{ n.name }}</h2>
        <span class="chip" :class="stateChip(n).color">{{ stateChip(n).text }}</span>
        <span v-if="versionChip(n)" class="chip" :class="versionChip(n).color" :title="versionChip(n).title">{{ versionChip(n).text }}</span>
        <span class="spacer"></span>
        <span class="fleet-meta">{{ meta(n) }}</span>
        <button
          v-if="panelOf(n) && n.online"
          type="button"
          class="small secondary"
          :disabled="updating(n)"
          :title="`Deploy ${n.name}'s own panel project (${panelOf(n).info.name}): the latest commit of ${panelOf(n).info.branch}`"
          @click="updateOne(n)"
        >{{ updating(n) ? 'Updating…' : 'Update panel' }}</button>
        <ActionMenu :label="`Server ${n.name}`" :items="menu(n)" @select="key => act(key, n)" />
      </div>
      <p v-if="errors[n.id]" class="error" style="margin: 6px 0 0">{{ errors[n.id] }}</p>

      <div v-if="projectsOf(n).length" class="fleet-rows">
        <template v-for="p in projectsOf(n)" :key="p.id">
          <div class="fleet-row" :class="{ open: isOpen(n, p) }" @click="toggle(n, p)">
            <span class="dot" :class="p.dot" aria-hidden="true"></span>
            <router-link :to="shipOf(n).link(p.id)" class="fleet-name" @click.stop>{{ p.info.name }}</router-link>
            <span class="fleet-status">{{ p.status }}</span>
            <span v-if="p.branch" class="vessel-branch">{{ p.branch }}</span>
            <span class="fleet-detail">{{ p.detail }}</span>
            <span class="spacer"></span>
            <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="vessel-addr" @click.stop>{{ p.url.replace(/^https?:\/\//, '') }} ↗</a>
            <!-- The same actions as a harbor row, run on that server (lib/vesselActions.js). -->
            <span v-if="n.online" class="vessel-actions" @click.stop>
              <button v-if="p.action" type="button" class="small secondary" :disabled="isBusy(n, p)" @click="runAction(n, p, p.action.key)">
                {{ isBusy(n, p) ? 'Working…' : p.action.label }}
              </button>
              <ActionMenu :label="`Vessel ${p.info.name}`" :items="p.menu" @select="key => runAction(n, p, key)" />
            </span>
          </div>
          <div v-if="isOpen(n, p)" class="fleet-voyages">
            <p v-if="!p.voyages.length" class="hint" style="margin: 0">No voyages yet.</p>
            <button
              v-for="v in p.voyages"
              :key="v.id"
              type="button"
              class="fleet-voyage"
              :class="{ active: shown && shown.node === n.id && shown.id === v.id }"
              @click="showLog(n, v)"
            >
              <StatusBadge :status="v.status" />
              <span class="mono">#{{ v.id }}</span>
              <span>{{ v.trigger }}</span>
              <span v-if="v.commitSha" class="mono">{{ v.commitSha.slice(0, 7) }}</span>
              <span class="fleet-detail">{{ timeAgo(v.finishedAt || v.startedAt || v.createdAt) }}</span>
            </button>
            <DeployLog
              v-if="shown && shown.node === n.id && shown.project === p.id"
              :key="`${shown.node}-${shown.id}`"
              :deployment-id="shown.id"
              :node="n.id"
              :active="isActive(p, shown.id)"
              style="margin-top: 10px"
            />
          </div>
        </template>
      </div>
      <p v-else class="hint" style="margin: 10px 0 0">
        <template v-if="n.online">Nothing moored there yet — <router-link :to="shipOf(n).page('projects/new')">moor a project</router-link>.</template>
        <template v-else>{{ n.paired ? 'Nothing reported since this panel started — it shows up when the server dials in.' : 'Not paired yet: make a code and run the command on that server.' }}</template>
      </p>
    </section>

    <!-- Who did what to which server from here, and how it went (server
         nodes/events.js): every change relayed, and each server's own life. -->
    <section v-if="nodes.length || events.length" class="panel fleet-log">
      <div class="fleet-log-head">
        <span class="section-label">Fleet log</span>
        <select v-model="eventsNode" class="fleet-log-filter" aria-label="Show the log of" @change="loadEvents()">
          <option value="">every server</option>
          <option v-for="n in nodes" :key="n.id" :value="String(n.id)">{{ n.name }}</option>
        </select>
        <span class="spacer"></span>
        <button type="button" class="small secondary" :disabled="eventsBusy" @click="loadEvents()">↻ Refresh</button>
      </div>
      <p v-if="eventsError" class="error">{{ eventsError }}</p>
      <p v-else-if="!events.length" class="hint" style="margin: 8px 0 0">Nothing done to {{ eventsNode ? 'that server' : 'the fleet' }} from here yet.</p>
      <div v-else class="table-scroll">
        <table class="fleet-log-table">
          <thead>
            <tr><th>When</th><th>Server</th><th>Who</th><th>What</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="e in events" :key="e.id">
              <td class="mono fleet-log-when" :title="e.created_at">{{ timeAgo(e.created_at) }}</td>
              <td>{{ e.node_name }}</td>
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
      <div v-if="eventsMore" style="margin-top: 8px">
        <button type="button" class="small secondary" :disabled="eventsBusy" @click="loadEvents({ more: true })">Show older</button>
      </div>
    </section>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store, appUrlFor } from '../store.js'
import { timeAgo, bytes } from '../lib/format.js'
import { vesselState, statusWord, VESSEL_STATES } from '../lib/vessels.js'
import { confirmDialog } from '../lib/dialog.js'
import { nodeShip } from '../lib/ship.js'
import { describeAction, processOf, outcomeOf } from '../lib/fleetLog.js'
import { primaryAction, actionMenu, performAction, lastVoyageId } from '../lib/vesselActions.js'
import ActionMenu from '../components/ActionMenu.vue'
import CopyButton from '../components/CopyButton.vue'
import DeployLog from '../components/DeployLog.vue'
import StatusBadge from '../components/StatusBadge.vue'

const USUAL_BRANCHES = new Set(['main', 'master'])
const SHIPS = new Map() // node id -> its ship; stateless, so shared

// Other Skeppa servers reporting here (nodes/links.js on the server), read
// only for now: what each runs, how it is doing, its voyages and their logs.
// A row's actions and its project page (/fleet/:node/projects/:id, the same
// ProjectView with that server's ship) run on that server through the
// master; the crew, settings, engine room and Shipyard stay on its own panel.
export default {
  name: 'FleetView',
  components: { ActionMenu, CopyButton, DeployLog, StatusBadge },
  data() {
    return {
      adding: false,
      newName: '',
      addError: '',
      busy: false,
      busyRows: {}, // `${node}:${project}` -> true while an action runs
      updatingAll: false,
      events: [], // the Fleet log, newest first
      eventsNode: '', // '' = every server
      eventsMore: false,
      eventsBusy: false,
      eventsError: '',
      join: null, // { name, code, expiresAt }
      renaming: 0,
      renameTo: '',
      errors: {},
      open: {}, // `${node}:${project}` -> true
      shown: null, // { node, project, id }
    }
  },
  computed: {
    // The commit this panel runs ('' when it cannot tell).
    hereVersion() {
      return store.live.system?.version ?? ''
    },
    driftCount() {
      return this.nodes.filter(n => this.versionChip(n)?.drift).length
    },
    // The servers whose own panel can be deployed from here right now.
    updatable() {
      return this.nodes.filter(n => n.online && this.panelOf(n) && !this.updating(n))
    },
    nodes() {
      return Object.values(store.live.nodes ?? {}).sort((a, b) => a.name.localeCompare(b.name))
    },
    onlineCount() {
      return this.nodes.filter(n => n.online).length
    },
    joinCommand() {
      return this.join ? `bun scripts/join.js ${location.origin} ${this.join.code}` : ''
    },
    joinUntil() {
      return this.join ? new Date(this.join.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    },
  },
  created() {
    this.loadEvents()
    // What others (another tab, a project page) did meanwhile turns up too.
    this.eventsTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden' && !this.eventsBusy) this.loadEvents({ quiet: true })
    }, 20_000)
  },
  beforeUnmount() {
    clearInterval(this.eventsTimer)
  },
  methods: {
    timeAgo,
    describeAction,
    processOf,
    outcomeOf,
    // The newest page of the log, or (more) the page before what is shown.
    async loadEvents({ more = false, quiet = false } = {}) {
      const PAGE = 30
      this.eventsBusy = true
      if (!quiet) this.eventsError = ''
      try {
        const q = new URLSearchParams({ limit: String(PAGE) })
        if (this.eventsNode) q.set('node', this.eventsNode)
        if (more && this.events.length) q.set('before', String(this.events.at(-1).id))
        const page = await api.get(`/api/nodes/events?${q}`)
        const rows = Array.isArray(page) ? page : []
        if (more) this.events = [...this.events, ...rows]
        else if (!quiet || !this.events.length || rows[0]?.id !== this.events[0]?.id) {
          // a refresh keeps what Show older brought in, below the newest page
          const older = quiet ? this.events.filter(e => e.id < (rows.at(-1)?.id ?? 0)) : []
          this.events = [...rows, ...older]
        }
        if (more || !quiet) this.eventsMore = rows.length === PAGE
      } catch (err) {
        if (!quiet) this.eventsError = `The fleet log could not be read: ${err.message}`
      } finally {
        this.eventsBusy = false
      }
    },
    stateOf(n) {
      return store.live.nodeStates?.[n.id] ?? null
    },
    stateChip(n) {
      if (n.online) return { text: 'online', color: 'green' }
      if (n.paired) return { text: 'offline', color: 'red' }
      if (n.joinExpiresAt && Date.parse(n.joinExpiresAt) > store.now) return { text: 'waiting to pair', color: 'amber' }
      return { text: 'not paired', color: '' }
    },
    meta(n) {
      const sys = this.stateOf(n)?.system ?? {}
      const parts = []
      if (!n.online && n.lastSeenAt) parts.push(`seen ${timeAgo(n.lastSeenAt)}`)
      if (n.online && Array.isArray(sys.loadavg)) parts.push(`load ${sys.loadavg[0]}${sys.cpuCount ? ` / ${sys.cpuCount} cores` : ''}`)
      if (n.online && sys.memory?.total) parts.push(`${bytes(sys.memory.total - sys.memory.free)} of ${bytes(sys.memory.total)}`)
      const domain = this.stateOf(n)?.proxy?.baseDomain
      if (domain) parts.push(domain)
      return parts.join(' · ')
    },
    // What the row shows, from the node's reported LiveState.
    projectsOf(n) {
      const state = this.stateOf(n)
      const domain = state?.proxy?.baseDomain ?? ''
      return Object.values(state?.projects ?? {})
        .filter(live => live?.info)
        .map(live => {
          const key = vesselState(live)
          const last = live.lastDeployment
          const ship = this.shipOf(n)
          const action = primaryAction(live.info, live, ship)
          let detail = ''
          if (live.currentDeployment) detail = live.currentDeployment.status === 'queued' ? 'waiting to depart' : 'voyage under way…'
          else if (key === 'ahead' && live.headCommit?.sha) detail = `new: ${live.headCommit.sha.slice(0, 7)} ${(live.headCommit.message ?? '').split('\n')[0]}`
          else if (last) detail = `${last.status === 'success' ? 'deployed' : `last voyage ${last.status}`}${last.commitSha ? ` ${last.commitSha.slice(0, 7)}` : ''} ${timeAgo(last.finishedAt)}`
          return {
            id: live.info.id,
            info: live.info,
            live,
            dot: VESSEL_STATES.find(s => s.key === key)?.dot ?? '',
            status: statusWord(live),
            branch: USUAL_BRANCHES.has(live.info.branch) ? '' : live.info.branch,
            detail,
            url: appUrlFor(live.info, domain),
            voyages: Array.isArray(live.recentDeployments) ? live.recentDeployments.slice(0, 8) : [],
            action,
            menu: actionMenu(live.info, live, { exclude: action?.key, goto: true, piers: true, ship }),
          }
        })
        .sort((a, b) => a.info.name.localeCompare(b.info.name))
    },
    // One ship per node, kept: actions and links on that server (lib/ship.js).
    shipOf(n) {
      if (!SHIPS.has(n.id)) SHIPS.set(n.id, nodeShip(n.id))
      return SHIPS.get(n.id)
    },
    // A server's own panel project: the pm2 project named as its panel
    // (system.selfPm2Name). A server installed without one has none, and is
    // updated on the server itself.
    panelOf(n) {
      const state = this.stateOf(n)
      const self = state?.system?.selfPm2Name
      if (!self) return null
      return Object.values(state.projects ?? {}).find(live =>
        live?.info?.pm2_name === self && (live.info.deployed_runtime || live.info.runtime) === 'pm2') ?? null
    },
    updating(n) {
      const panel = this.panelOf(n)
      return Boolean(panel?.currentDeployment) || this.isBusy(n, { id: panel?.info?.id })
    },
    versionChip(n) {
      if (!n.version) return null
      if (!this.hereVersion) return { text: n.version, color: '', title: 'The commit its panel runs' }
      if (n.version === this.hereVersion) return { text: n.version, color: 'green', title: 'The same commit as this panel' }
      return { text: `${n.version} ≠ ${this.hereVersion}`, color: 'amber', drift: true, title: `Its panel runs ${n.version}, this one ${this.hereVersion}` }
    },
    async deployPanel(n) {
      const panel = this.panelOf(n)
      const k = `${n.id}:${panel.info.id}`
      this.busyRows = { ...this.busyRows, [k]: true }
      try {
        await this.shipOf(n).api.post(`/api/projects/${panel.info.id}/deploy`)
        this.setError(n, null)
      } catch (err) {
        this.setError(n, new Error(`Update failed: ${err.message}`))
      } finally {
        this.busyRows = { ...this.busyRows, [k]: false }
        this.loadEvents({ quiet: true })
      }
    },
    async updateOne(n) {
      const panel = this.panelOf(n)
      if (!(await confirmDialog(`Update ${n.name}'s panel? It deploys ${panel.info.name} at the latest commit of ${panel.info.branch}, and that panel restarts — its apps keep running, and it reports again in a moment.`, { confirmLabel: 'Update' }))) return
      await this.deployPanel(n)
    },
    async updateAll() {
      const targets = this.updatable
      const names = targets.map(n => n.name).join(', ')
      if (!(await confirmDialog(`Update the panel on ${targets.length === 1 ? names : `${targets.length} servers (${names})`}? Each deploys its own panel project at the latest commit of its branch and restarts — their apps keep running.`, { confirmLabel: 'Update' }))) return
      this.updatingAll = true
      try {
        await Promise.all(targets.map(n => this.deployPanel(n)))
      } finally {
        this.updatingAll = false
      }
    },
    isBusy(n, p) {
      return Boolean(this.busyRows[`${n.id}:${p.id}`])
    },
    // The row's button and ⋮, as on a harbor row: the go-to items open the
    // project's page on that server, the rest run there.
    async runAction(n, p, key) {
      const ship = this.shipOf(n)
      const page = query => this.$router.push({ path: ship.link(p.id), query })
      if (key === 'voyage') return page({ deployment: String(lastVoyageId(p.live)) })
      if (key === 'logbook') return page({ tab: 'logs' })
      if (key === 'rigging') return page({ tab: 'settings' })
      const k = `${n.id}:${p.id}`
      this.busyRows = { ...this.busyRows, [k]: true }
      try {
        await performAction(p.info, key, ship)
      } finally {
        this.busyRows = { ...this.busyRows, [k]: false }
        this.loadEvents({ quiet: true })
      }
    },
    isOpen(n, p) {
      return Boolean(this.open[`${n.id}:${p.id}`])
    },
    toggle(n, p) {
      const k = `${n.id}:${p.id}`
      this.open = { ...this.open, [k]: !this.open[k] }
      if (!this.open[k] && this.shown?.node === n.id && this.shown.project === p.id) this.shown = null
    },
    showLog(n, v) {
      const p = this.projectsOf(n).find(x => x.voyages.some(y => y.id === v.id))
      this.shown = this.shown?.node === n.id && this.shown.id === v.id ? null : { node: n.id, project: p?.id, id: v.id }
    },
    isActive(p, deploymentId) {
      const current = p.live.currentDeployment
      return Boolean(current && current.id === deploymentId)
    },
    menu(n) {
      return [
        // Its admin pages, run on that server through this panel.
        { heading: 'That server' },
        { key: 'page:projects/new', label: 'Moor a project there', disabled: !n.online },
        { key: 'page:system', label: 'Engine room', disabled: !n.online },
        { key: 'page:shipyard', label: 'Shipyard', disabled: !n.online },
        { key: 'page:settings', label: 'Rigging — harbor gate, notifications', disabled: !n.online },
        { separator: true },
        { key: 'rename', label: 'Rename' },
        { key: 'code', label: n.paired ? 'New join code (pair again)' : 'Make a join code' },
        ...(n.paired ? [{ key: 'unpair', label: 'Unpair — cut it off now', danger: true }] : []),
        { key: 'remove', label: 'Remove from the fleet', danger: true },
      ]
    },
    setError(n, err) {
      this.errors = { ...this.errors, [n.id]: err ? err.message ?? String(err) : '' }
    },
    async act(key, n) {
      this.setError(n, null)
      try {
        if (key.startsWith('page:')) {
          this.$router.push(this.shipOf(n).page(key.slice(5)))
        } else if (key === 'rename') {
          this.renaming = n.id
          this.renameTo = n.name
        } else if (key === 'code') {
          const res = await api.post(`/api/nodes/${n.id}/code`)
          this.join = { name: n.name, ...res }
        } else if (key === 'unpair') {
          if (!(await confirmDialog(`Unpair ${n.name}? It is cut off at once and stays so until it is paired again with a new code.`, { confirmLabel: 'Unpair', danger: true }))) return
          await api.post(`/api/nodes/${n.id}/unpair`)
        } else if (key === 'remove') {
          if (!(await confirmDialog(`Remove ${n.name} from the fleet? Its key stops working. Nothing on that server changes — it keeps running its own panel.`, { confirmLabel: 'Remove', danger: true }))) return
          await api.del(`/api/nodes/${n.id}`)
        }
      } catch (err) {
        this.setError(n, err)
      }
      this.loadEvents({ quiet: true })
    },
    async rename(n) {
      this.busy = true
      try {
        await api.patch(`/api/nodes/${n.id}`, { name: this.renameTo })
        this.renaming = 0
        this.setError(n, null)
        this.loadEvents({ quiet: true })
      } catch (err) {
        this.setError(n, err.fields?.name ? new Error(err.fields.name) : err)
      } finally {
        this.busy = false
      }
    },
    startAdding() {
      this.adding = true
      this.addError = ''
      this.newName = ''
      this.$nextTick(() => this.$refs.name?.focus())
    },
    async create() {
      this.busy = true
      this.addError = ''
      try {
        const res = await api.post('/api/nodes', { name: this.newName })
        this.join = { name: res.node.name, code: res.code, expiresAt: res.expiresAt }
        this.adding = false
        this.loadEvents({ quiet: true })
      } catch (err) {
        this.addError = err.fields?.name ?? err.message
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style scoped>
.fleet-add, .fleet-join { margin-top: 14px; max-width: 720px; }
.fleet-add input { flex: 1; }
.fleet-command { display: flex; align-items: center; gap: 8px; background: var(--bg-sunken, rgba(127, 127, 127, 0.08)); border-radius: 6px; padding: 8px 10px; }
.fleet-command code { flex: 1; overflow-x: auto; white-space: nowrap; font-size: 12px; }
.fleet-node { margin-top: 16px; }
.fleet-node-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fleet-node-name { margin: 0; font-size: 17px; }
.fleet-rename { max-width: 240px; }
.fleet-meta { font-size: 12px; color: var(--dim); }
.fleet-drift { color: var(--amber, #d29922); }
.fleet-log { margin-top: 24px; }
.fleet-log-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.fleet-log-filter { width: auto; }
.fleet-log-table { width: 100%; font-size: 13px; }
.fleet-log-table td { padding: 5px 8px; vertical-align: top; }
.fleet-log-when, .fleet-log-who { white-space: nowrap; color: var(--dim); }
.fleet-log-outcome { text-align: right; white-space: nowrap; }
.fleet-rows { margin-top: 10px; display: flex; flex-direction: column; }
.fleet-row { display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-top: 1px solid var(--line, rgba(127, 127, 127, 0.18)); cursor: pointer; flex-wrap: wrap; }
.fleet-row:hover, .fleet-row.open { background: var(--hover, rgba(127, 127, 127, 0.06)); }
.fleet-name { font-weight: 600; }
.fleet-status { font-size: 13px; }
.fleet-detail { font-size: 12px; color: var(--dim); }
.fleet-voyages { padding: 6px 4px 12px 22px; display: flex; flex-direction: column; gap: 4px; }
.fleet-voyage { display: flex; align-items: center; gap: 10px; background: none; border: 1px solid transparent; color: inherit; text-align: left; padding: 3px 6px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.fleet-voyage:hover, .fleet-voyage.active { border-color: var(--line, rgba(127, 127, 127, 0.3)); }
</style>
