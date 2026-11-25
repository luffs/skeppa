<template>
  <div class="container">
    <div class="page-head" style="margin-bottom: 10px">
      <div>
        <h1 style="margin: 0">The fleet</h1>
        <div class="page-sub">
          <template v-if="nodes.length">
            {{ nodes.length + 1 }} servers · {{ onlineCount + 1 }} online
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
        You get a one-time code to pair it with. It is then run from here; its own panel turns off.
      </p>
    </div>

    <JoinCode v-if="join" :join="join" @done="join = null" />

    <div v-if="!nodes.length && !adding && !join" class="panel" style="margin-top: 22px; max-width: 680px">
      <p style="margin-top: 0"><strong>No servers in the fleet yet.</strong></p>
      <p class="hint" style="margin-bottom: 0">
        Another Skeppa can report here and be run from here: its projects, their state and their voyages, live. Keep
        fleets apart where trust ends — one at home, one at work — because whoever runs this panel runs all of it.
      </p>
    </div>

    <!-- A row a server, this panel first: how it is doing, and a link to its
         own page (its vessels are in the Harbor, filtered by server). -->
    <div v-if="nodes.length" class="panel flush fleet-servers">
      <div class="table-scroll">
        <table class="fleet-table">
          <thead>
            <tr><th>Server</th><th>State</th><th>Version</th><th>Load</th><th>Memory</th><th>Disk</th><th>Vessels</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.key" class="fleet-server" :class="{ here: !r.node }">
              <td class="fleet-server-name">
                <span class="dot" :class="r.dot" aria-hidden="true"></span>
                <router-link v-if="r.node" :to="`/fleet/${r.node.id}`">{{ r.name }}</router-link>
                <span v-else>{{ r.name }}</span>
              </td>
              <td>
                <span class="chip" :class="r.state.color">{{ r.state.text }}</span>
                <span v-if="r.seen" class="fleet-dim"> {{ r.seen }}</span>
              </td>
              <td><span v-if="r.version" class="chip" :class="r.version.color" :title="r.version.title">{{ r.version.text }}</span></td>
              <td class="mono">{{ r.load || '—' }}</td>
              <td class="mono" :title="r.memory?.title">{{ r.memory ? `${r.memory.percent}%` : '—' }}</td>
              <td>
                <span v-if="r.disk" class="chip" :class="r.diskTone" :title="r.disk.title">{{ r.disk.percent }}%</span>
                <span v-else class="mono">—</span>
              </td>
              <td>
                <router-link :to="`/?server=${r.filter}`" class="fleet-vessels">
                  {{ r.vessels.count }}<template v-if="r.vessels.attention"> · <span class="fleet-attention">{{ r.vessels.attention }} need{{ r.vessels.attention === 1 ? 's' : '' }} attention</span></template>
                </router-link>
              </td>
              <td class="fleet-server-actions">
                <button
                  v-if="r.node && r.panel && r.node.online"
                  type="button"
                  class="small secondary"
                  :disabled="updating(r)"
                  :title="`Deploy ${r.name}'s own panel project (${r.panel.info.name}): the latest commit of ${r.panel.info.branch}`"
                  @click="updateOne(r)"
                >{{ updating(r) ? 'Updating…' : 'Update panel' }}</button>
                <router-link v-if="!r.node" to="/system" class="small-link">Engine room</router-link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="error" class="error" style="margin: 8px 12px">{{ error }}</p>
    </div>

    <FleetLog v-if="nodes.length" ref="log" />
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import { confirmDialog } from '../lib/dialog.js'
import { localShip, nodeShip } from '../lib/ship.js'
import { diskOf, diskTone, memoryOf, loadOf, versionChip, stateChip, lastSeen, vesselsOf, panelOf } from '../lib/fleet.js'
import FleetLog from '../components/FleetLog.vue'
import JoinCode from '../components/JoinCode.vue'

const SHIPS = new Map() // node id -> its ship; stateless, so shared

// The fleet: a row a server — this panel among them — with how it is doing,
// leading to the server's own page (ServerView: its overview, engine room,
// Shipyard, Rigging, log and pairing). Vessels live in the Harbor; here a
// server only says how many, and how many want looking at. Adding a server,
// updating every panel, and the Fleet log.
export default {
  name: 'FleetView',
  components: { FleetLog, JoinCode },
  data() {
    return {
      adding: false,
      newName: '',
      addError: '',
      busy: false,
      busyPanels: {}, // node id -> true while its panel deploy is being asked for
      updatingAll: false,
      join: null, // { name, code, expiresAt }
      error: '',
    }
  },
  computed: {
    hereVersion() {
      return store.live.system?.version ?? ''
    },
    nodes() {
      return Object.values(store.live.nodes ?? {}).sort((a, b) => a.name.localeCompare(b.name))
    },
    onlineCount() {
      return this.nodes.filter(n => n.online).length
    },
    // This panel, then every server of the fleet, as the table shows them.
    rows() {
      const row = (node, ship) => {
        const state = stateChip(node)
        const disk = diskOf(ship)
        return {
          key: node ? `n${node.id}` : 'here',
          node,
          ship,
          name: node ? node.name : 'this panel',
          dot: !node || node.online ? 'green' : node.paired ? 'red' : '',
          state,
          seen: lastSeen(node),
          version: node ? versionChip(node.version) : (this.hereVersion ? { text: this.hereVersion, color: '', title: 'The commit this panel runs' } : null),
          load: !node || node.online ? loadOf(ship) : '',
          memory: !node || node.online ? memoryOf(ship) : null,
          disk,
          diskTone: diskTone(disk),
          vessels: vesselsOf(ship),
          filter: node ? String(node.id) : 'here',
          panel: node ? panelOf(ship) : null,
        }
      }
      return [row(null, localShip), ...this.nodes.map(n => row(n, shipFor(n.id)))]
    },
    driftCount() {
      return this.rows.filter(r => r.node && r.version?.drift).length
    },
    // The servers whose own panel can be deployed from here right now.
    updatable() {
      return this.rows.filter(r => r.node?.online && r.panel && !this.updating(r))
    },
  },
  methods: {
    updating(r) {
      return Boolean(r.panel?.currentDeployment) || Boolean(this.busyPanels[r.node?.id])
    },
    async deployPanel(r) {
      this.busyPanels = { ...this.busyPanels, [r.node.id]: true }
      try {
        await r.ship.api.post(`/api/projects/${r.panel.info.id}/deploy`)
      } catch (err) {
        this.error = `Updating ${r.name} failed: ${err.message}`
      } finally {
        this.busyPanels = { ...this.busyPanels, [r.node.id]: false }
        this.$refs.log?.refresh()
      }
    },
    async updateOne(r) {
      if (!(await confirmDialog(`Update ${r.name}'s panel? It deploys ${r.panel.info.name} at the latest commit of ${r.panel.info.branch}, and that panel restarts — its apps keep running, and it reports again in a moment.`, { confirmLabel: 'Update' }))) return
      this.error = ''
      await this.deployPanel(r)
    },
    async updateAll() {
      const targets = this.updatable
      const names = targets.map(r => r.name).join(', ')
      if (!(await confirmDialog(`Update the panel on ${targets.length === 1 ? names : `${targets.length} servers (${names})`}? Each deploys its own panel project at the latest commit of its branch and restarts — their apps keep running.`, { confirmLabel: 'Update' }))) return
      this.error = ''
      this.updatingAll = true
      try {
        await Promise.all(targets.map(r => this.deployPanel(r)))
      } finally {
        this.updatingAll = false
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
        this.$refs.log?.refresh()
      } catch (err) {
        this.addError = err.fields?.name ?? err.message
      } finally {
        this.busy = false
      }
    },
  },
}

function shipFor(id) {
  if (!SHIPS.has(id)) SHIPS.set(id, nodeShip(id))
  return SHIPS.get(id)
}
</script>

<style scoped>
.fleet-add { margin-top: 14px; max-width: 720px; }
.fleet-add input { flex: 1; }
.fleet-servers { margin-top: 16px; }
.fleet-table { width: 100%; font-size: 13.5px; }
.fleet-table th, .fleet-table td { padding: 8px 10px; text-align: left; white-space: nowrap; }
.fleet-server.here td { background: var(--hover, rgba(127, 127, 127, 0.04)); }
.fleet-server-name { font-weight: 600; }
.fleet-server-name .dot { margin-right: 8px; }
.fleet-server-actions { text-align: right; }
.fleet-dim { font-size: 12px; color: var(--dim); }
.fleet-drift, .fleet-attention { color: var(--amber, #d29922); }
.fleet-vessels { color: inherit; }
.small-link { font-size: 12.5px; }
</style>
