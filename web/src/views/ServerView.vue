<template>
  <div class="container">
    <router-link to="/fleet" class="mono" style="font-size: 12px; color: var(--dim)">← back to the fleet</router-link>
    <template v-if="server">
      <div class="page-head server-page-head">
        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <h1 style="margin: 0">{{ server.name }}</h1>
          <span class="chip" :class="state.color">{{ state.text }}</span>
          <span v-if="version" class="chip" :class="version.color" :title="version.title">{{ version.text }}</span>
          <span v-if="disk && diskTone" class="chip" :class="diskTone" :title="disk.title">disk {{ disk.percent }}%</span>
        </div>
        <div class="row">
          <button
            v-if="!local && panel && server.online"
            class="secondary"
            :disabled="updating"
            :title="`Deploy its own panel project (${panel.info.name}): the latest commit of ${panel.info.branch}`"
            @click="updatePanel"
          >{{ updating ? 'Updating…' : 'Update panel' }}</button>
        </div>
      </div>
      <ShipOffline />
      <div v-if="!local && server.protocolGap" class="server-banner">
        <template v-if="server.protocolGap === 'older'">
          <b>Its panel is too old for this one.</b> It speaks fleet protocol {{ server.protocol }}, which this panel no
          longer understands, so parts of its pages may not work. <i>Update panel</i> brings it level.
        </template>
        <template v-else>
          <b>Its panel is newer than this one.</b> It speaks fleet protocol {{ server.protocol }}, which this panel does
          not understand yet, so parts of its pages may not work. Update this panel.
        </template>
      </div>

      <div class="tabs">
        <button v-for="t in tabs" :key="t.key" :class="{ active: tab === t.key }" @click="setTab(t.key)">{{ t.label }}</button>
      </div>

      <!-- Overview: how it is doing, and what it runs. -->
      <div v-if="tab === 'overview'">
        <!-- the same cards as over this panel's own Engine room -->
        <ServerFacts :node="local ? null : server" style="margin-top: 14px" />

        <div class="section-head" style="margin-top: 20px">
          <span class="section-label">Vessels</span>
          <span class="spacer"></span>
          <router-link :to="`/?server=${local ? 'here' : server.id}`" class="small-link">In the harbor</router-link>
          <router-link v-if="server.online" :to="ship.page('projects/new')"><button class="small">{{ local ? '+ Moor a project' : '+ Moor a project there' }}</button></router-link>
        </div>
        <div v-if="vessels.length" class="vessel-rows">
          <ProjectRow v-for="p in vessels" :key="p.id" :project="p" :ship="ship" />
        </div>
        <p v-else class="hint">
          {{ local ? 'Nothing moored here yet.' : server.online ? 'Nothing moored there yet.' : server.paired ? 'Nothing reported since this panel started — it shows up when the server dials in.' : 'Not paired yet: make a code under Pairing and run the command on that server.' }}
        </p>
      </div>

      <SystemView v-else-if="tab === 'engine'" :node="local ? 0 : node" embedded />
      <ShipyardView v-else-if="tab === 'shipyard'" :node="local ? 0 : node" embedded />
      <SettingsView v-else-if="tab === 'rigging'" :node="local ? 0 : node" embedded />
      <FleetLog v-else-if="tab === 'log'" ref="log" :node="server.id" />

      <!-- Pairing: its name, its key, and taking it out — apart from the rest. -->
      <div v-else-if="tab === 'pairing'" class="server-pairing">
        <section class="panel">
          <h3 class="section-part-title">Name</h3>
          <div class="row inline-action">
            <input v-model="renameTo" maxlength="40" aria-label="Server name" @keydown.enter.prevent="rename" />
            <button class="secondary" :disabled="busy || !renameTo.trim() || renameTo.trim() === server.name" @click="rename">Rename</button>
          </div>
        </section>
        <section v-if="server.paired" class="panel">
          <h3 class="section-part-title">Key</h3>
          <div class="row inline-action">
            <p class="hint">
              Rotate: a new key, handed to it over its own connection — nothing to run over there. The old one stops
              working as soon as it has the new one.
            </p>
            <button class="secondary" :disabled="busy || !server.online" :title="server.online ? '' : 'It takes the new key over its connection: it has to be online'" @click="rotate">Rotate key</button>
          </div>
          <p v-if="rotated" class="hint rotate-result" :class="rotated.tone">{{ rotated.text }}</p>
          <p v-else-if="server.rotating" class="hint rotate-result amber">
            A new key is out and it has not dialled in with it yet. Both keys work until it does.
          </p>
        </section>
        <section class="panel">
          <h3 class="section-part-title">GitHub access</h3>
          <p class="hint">
            The repositories it may read through this panel's GitHub App, for its deploys. A project moored there from
            here adds its repo; what it reported the first time it was in step after pairing was taken as its own.
            It cannot add one by saying it deploys it.
          </p>
          <p v-if="!repos" class="hint">Loading…</p>
          <template v-else>
            <ul v-if="repos.allowed.length" class="repo-list">
              <li v-for="r in repos.allowed" :key="r.repo">
                <span class="mono">{{ r.repo }}</span>
                <span class="hint">{{ HOW[r.how] ?? r.how }}</span>
                <span class="spacer"></span>
                <button class="small secondary" :disabled="busy" @click="disallowRepo(r.repo)">Take back</button>
              </li>
            </ul>
            <p v-else class="hint">None yet.</p>
            <div v-if="repos.reported.length" class="repo-asks">
              <span class="section-label">It deploys, may not read</span>
              <ul class="repo-list">
                <li v-for="repo in repos.reported" :key="repo">
                  <span class="mono">{{ repo }}</span>
                  <span class="hint">its deploys of it fail to fetch</span>
                  <span class="spacer"></span>
                  <button class="small secondary" :disabled="busy" @click="allowRepo(repo)">Allow</button>
                </li>
              </ul>
            </div>
            <div class="row inline-action" style="margin-top: 10px">
              <input v-model="repoToAllow" class="code" placeholder="owner/name" aria-label="Repository to allow" @keydown.enter.prevent="allowRepo(repoToAllow)" />
              <button class="secondary" :disabled="busy || !repoToAllow.trim()" @click="allowRepo(repoToAllow)">Allow</button>
            </div>
          </template>
        </section>
        <section class="panel">
          <h3 class="section-part-title">Join code</h3>
          <p class="hint">
            {{ server.paired ? 'A new code pairs it again — on that server, with the command it shows; the key it has works until then. For a server that lost its key, or a new machine in its place.' : 'It is not paired: make a code and run the command it shows on that server.' }}
          </p>
          <button class="secondary" :disabled="busy" @click="newCode">{{ server.paired ? 'New join code' : 'Make a join code' }}</button>
          <JoinCode v-if="join" :join="join" @done="join = null" />
        </section>
        <section class="panel danger-zone">
          <h3 class="section-part-title">Cut it off</h3>
          <div class="row inline-action">
            <p class="hint">Unpair: its key stops working now; it is cut off until it is paired again. Nothing on that server changes.</p>
            <button class="danger" :disabled="busy || !server.paired" @click="unpair">Unpair</button>
          </div>
          <div class="row inline-action">
            <p class="hint">Remove it from the fleet: its key stops working and it leaves this page. Its apps keep running over there; its log stays here.</p>
            <button class="danger" :disabled="busy" @click="remove">Remove</button>
          </div>
        </section>
        <p v-if="error" class="error">{{ error }}</p>
      </div>
    </template>
    <p v-else class="hint" style="margin-top: 20px">No such server in the fleet — it may have been removed.</p>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import { timeAgo } from '../lib/format.js'
import { confirmDialog } from '../lib/dialog.js'
import { shipProvider } from '../lib/ship.js'
import { diskOf, diskTone, versionChip, stateChip, panelOf } from '../lib/fleet.js'
import ProjectRow from '../components/ProjectRow.vue'
import ServerFacts from '../components/ServerFacts.vue'
import ShipOffline from '../components/ShipOffline.vue'
import FleetLog from '../components/FleetLog.vue'
import JoinCode from '../components/JoinCode.vue'
import SystemView from './SystemView.vue'
import ShipyardView from './ShipyardView.vue'
import SettingsView from './SettingsView.vue'

// Why a repository is on a server's GitHub access list (server node_repos).
const HOW = { moored: 'moored from here', allowed: 'allowed by hand', reported: 'reported at pairing' }

const reposOf = res => ({ allowed: res?.allowed ?? [], reported: res?.reported ?? [] })

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'engine', label: 'Engine room' },
  { key: 'shipyard', label: 'Shipyard' },
  { key: 'rigging', label: 'Rigging' },
  { key: 'log', label: 'Log' },
  { key: 'pairing', label: 'Pairing' },
]

// One server — this panel (/fleet/here) or one of the fleet — the way a
// project has its page: an overview (how
// it is doing, what it runs), its Engine room, Shipyard and Rigging (this
// panel's own views, embedded, run on that server through the ship), its log,
// and pairing — name, join code, unpair, remove — kept apart. The tab is in
// the URL (?tab=), so a reload and a link land where they mean to.
export default {
  name: 'ServerView',
  components: { ProjectRow, ServerFacts, ShipOffline, FleetLog, JoinCode, SystemView, ShipyardView, SettingsView },
  mixins: [shipProvider],
  data() {
    const tab = this.$route?.query?.tab
    return {
      TABS,
      tab: TABS.some(t => t.key === tab) && !(this.node === 'here' && (tab === 'log' || tab === 'pairing')) ? tab : 'overview',
      renameTo: '',
      join: null,
      busy: false,
      error: '',
      asked: false, // its panel's deploy is being asked for
      rotated: null, // how the last Rotate key went: { text, tone }
      repos: null, // its GitHub access (GET /api/nodes/:id/repos), on Pairing
      repoToAllow: '',
      HOW,
    }
  },
  computed: {
    // /fleet/here: this panel's own page — the same tabs, without the log
    // and pairing a fleet server has (changes here are not relayed).
    local() {
      return this.node === 'here'
    },
    server() {
      if (this.local) {
        return { id: 0, name: 'this panel', online: true, paired: true, version: store.live.system?.version ?? '', lastSeenAt: '' }
      }
      return store.live.nodes?.[Number(this.node)] ?? null
    },
    tabs() {
      return this.local ? TABS.filter(t => t.key !== 'log' && t.key !== 'pairing') : TABS
    },
    state() {
      return stateChip(this.server)
    },
    version() {
      if (this.local) return this.server.version ? { text: this.server.version, color: '', title: 'The commit this panel runs' } : null
      return versionChip(this.server?.version, this.server)
    },
    disk() {
      return diskOf(this.ship)
    },
    diskTone() {
      return diskTone(this.disk)
    },
    panel() {
      return panelOf(this.ship)
    },
    updating() {
      return this.asked || Boolean(this.panel?.currentDeployment)
    },
    vessels() {
      return Object.values(this.ship.live.projects ?? {}).map(p => p?.info).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
    },
  },
  watch: {
    'server.name': {
      immediate: true,
      handler(name) {
        if (name && !this.renameTo) this.renameTo = name
      },
    },
    // Back and forward between tabs
    '$route.query.tab'(tab) {
      this.tab = TABS.some(t => t.key === tab) ? tab : 'overview'
    },
    tab: {
      immediate: true,
      handler(tab) {
        if (tab === 'pairing' && !this.local) this.loadRepos()
      },
    },
  },
  methods: {
    timeAgo,
    setTab(tab) {
      if (tab === this.tab) return
      this.tab = tab
      const query = { ...(this.$route?.query ?? {}) }
      if (tab === 'overview') delete query.tab
      else query.tab = tab
      this.$router?.push?.({ query })
    },
    async updatePanel() {
      const p = this.panel
      if (!(await confirmDialog(`Update ${this.server.name}'s panel? It deploys ${p.info.name} at the latest commit of ${p.info.branch}, and that panel restarts — its apps keep running, and it reports again in a moment.`, { confirmLabel: 'Update' }))) return
      this.asked = true
      try {
        await this.ship.api.post(`/api/projects/${p.info.id}/deploy`)
      } catch (err) {
        this.error = `Update failed: ${err.message}`
      } finally {
        this.asked = false
      }
    },
    async run(fn) {
      this.busy = true
      this.error = ''
      try {
        await fn()
      } catch (err) {
        this.error = err.fields?.name ?? err.message
      } finally {
        this.busy = false
      }
    },
    rename() {
      return this.run(async () => {
        await api.patch(`/api/nodes/${this.server.id}`, { name: this.renameTo })
      })
    },
    async loadRepos() {
      try {
        this.repos = reposOf(await api.get(`/api/nodes/${this.node}/repos`))
      } catch (err) {
        this.error = err.message
      }
    },
    allowRepo(repo) {
      return this.run(async () => {
        this.repos = reposOf(await api.post(`/api/nodes/${this.server.id}/repos`, { repo: repo.trim() }))
        this.repoToAllow = ''
      })
    },
    disallowRepo(repo) {
      return this.run(async () => {
        this.repos = reposOf(await api.del(`/api/nodes/${this.server.id}/repos?repo=${encodeURIComponent(repo)}`))
      })
    },
    rotate() {
      this.rotated = null
      return this.run(async () => {
        const res = await api.post(`/api/nodes/${this.server.id}/rotate`)
        this.rotated = res.pending
          ? { text: 'Sent, but it did not say it has it. Both keys work until it dials in with the new one.', tone: 'amber' }
          : { text: 'New key in place ✔ — the old one no longer works.', tone: 'green' }
      })
    },
    newCode() {
      return this.run(async () => {
        const res = await api.post(`/api/nodes/${this.server.id}/code`)
        this.join = { name: this.server.name, ...res }
      })
    },
    async unpair() {
      if (!(await confirmDialog(`Unpair ${this.server.name}? It is cut off at once and stays so until it is paired again with a new code.`, { confirmLabel: 'Unpair', danger: true }))) return
      await this.run(() => api.post(`/api/nodes/${this.server.id}/unpair`))
    },
    async remove() {
      if (!(await confirmDialog(`Remove ${this.server.name} from the fleet? Its key stops working. Nothing on that server changes — it keeps running its apps.`, { confirmLabel: 'Remove', danger: true }))) return
      await this.run(async () => {
        await api.del(`/api/nodes/${this.server.id}`)
        this.$router.push('/fleet')
      })
    },
  },
}
</script>

<style scoped>
.server-page-head { margin: 8px 0 4px; }
.fleet-dim { font-size: 12px; color: var(--dim); }
.small-link { font-size: 12.5px; margin-right: 10px; }
.server-pairing { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; max-width: 760px; }
.server-pairing input { max-width: 280px; }
.server-banner {
  margin: 12px 0 4px;
  padding: 10px 14px;
  border: 1px solid var(--red);
  background: var(--red-tint);
  border-radius: 8px;
  font-size: 13.5px;
}
.rotate-result { margin: 8px 0 0; }
.repo-list { list-style: none; margin: 8px 0 0; padding: 0; }
.repo-list li { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line-soft); }
.repo-list li:first-child { border-top: 0; }
.repo-asks { margin-top: 14px; }
.spacer { flex: 1; }
.rotate-result.green { color: var(--green); }
.rotate-result.amber { color: var(--amber); }
.danger-zone { border-color: var(--red-soft, rgba(248, 81, 73, 0.4)); }
</style>
