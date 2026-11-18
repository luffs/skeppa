<template>
  <div class="container">
    <div class="page-head" style="margin-bottom: 10px">
      <div>
        <h1 style="margin: 0">The harbor</h1>
        <div class="page-sub">{{ fleetSummary }}</div>
      </div>
      <div class="row">
        <button v-if="projects.length" class="secondary" @click="startPier">+ New pier</button>
        <router-link to="/projects/new"><button>+ Moor a project</button></router-link>
      </div>
    </div>

    <div v-if="projects.length" class="harbor-layout">
      <div class="harbor-list">
        <div v-if="addingPier" class="pier-new">
          <div class="row">
            <input
              ref="pierName"
              v-model="pierName"
              maxlength="40"
              placeholder="Name the pier — Clients, Experiments, …"
              @keydown.enter.prevent="createPier"
              @keydown.esc.prevent="addingPier = false"
            />
            <button class="small" :disabled="pierBusy || !pierName.trim()" @click="createPier">
              {{ pierBusy ? 'Building…' : 'Create' }}
            </button>
            <button class="small secondary" :disabled="pierBusy" @click="addingPier = false">Cancel</button>
          </div>
          <p v-if="pierError" class="error">{{ pierError }}</p>
          <p v-else class="hint" style="margin: 6px 0 0">
            A pier only sorts the list — what a project runs, reaches or is routed as stays the same.
            Moor vessels at it from each project's Rigging.
          </p>
        </div>
        <template v-for="f in fleets" :key="f.key">
          <!-- One fleet is the whole harbor: headings only once there is more than one. -->
          <div v-if="fleets.length > 1" class="fleet-head">
            <span class="section-label">{{ f.label }}</span>
            <span v-if="f.detail" class="fleet-detail">{{ f.detail }}</span>
            <span class="spacer"></span>
            <span class="fleet-detail">{{ f.projects.length }} vessel{{ f.projects.length === 1 ? '' : 's' }}</span>
          </div>
          <div v-for="s in f.piers" :key="'pier' + s.pier.id" class="pier">
            <PierHead
              :pier="s.pier"
              :projects="s.projects"
              :collapsed="isCollapsed(s.pier.id)"
              @toggle="toggleCollapsed(s.pier.id)"
            />
            <div v-if="!isCollapsed(s.pier.id)" class="pier-body">
              <div v-if="s.projects.length" class="vessel-rows">
                <ProjectRow v-for="p in s.projects" :key="p.id" :project="p" />
              </div>
              <p v-else class="hint pier-empty">
                Nothing moored here yet — pick this pier under a project's Rigging.
              </p>
            </div>
          </div>
          <!-- Projects at no pier: headed only when there are piers to tell them from. -->
          <div v-if="f.piers.length && f.loose.length" class="pier-head anchor-head">
            <span class="pier-name">At anchor</span>
            <span class="fleet-detail">{{ f.loose.length }} vessel{{ f.loose.length === 1 ? '' : 's' }} at no pier</span>
          </div>
          <div v-if="f.loose.length" class="vessel-rows">
            <ProjectRow v-for="p in f.loose" :key="p.id" :project="p" />
          </div>
        </template>
      </div>
      <div class="feed-panel">
        <div class="feed-head">
          <span class="section-label">Ship's log</span>
          <span class="mono" style="font-size: 11px; color: var(--dim)">all projects</span>
        </div>
        <div v-if="feed.length">
          <div v-for="(e, i) in feed" :key="i" class="feed-entry">
            <span class="dot" :class="e.dot"></span>
            <div class="body">
              <div class="text"><span v-if="e.owner" class="feed-owner">{{ e.owner }} ·</span> <strong>{{ e.project }}</strong> — {{ e.text }}</div>
              <div class="meta">{{ e.meta }}</div>
            </div>
          </div>
        </div>
        <p v-else class="hint" style="margin: 0">Nothing in the log yet.</p>
      </div>
    </div>

    <div v-else-if="ready" class="panel" style="margin-top: 22px; max-width: 680px">
      <p style="margin-top: 0">
        <strong>No vessels in the harbor yet.</strong> Three steps to the first voyage:
      </p>

      <div class="crew-rows" style="margin-top: 8px">
        <div class="crew-row">
          <span class="chip" :class="setupStep > 1 ? 'green' : setupStep === 1 ? 'blue' : ''">
            {{ setupStep > 1 ? '✓' : '1' }}
          </span>
          <span>Connect GitHub — Skeppa creates the GitHub App for you</span>
          <span class="spacer"></span>
          <router-link v-if="setupStep === 1" to="/settings"><button class="small">Create GitHub App</button></router-link>
        </div>
        <div class="crew-row">
          <span class="chip" :class="setupStep > 2 ? 'green' : setupStep === 2 ? 'blue' : ''">
            {{ setupStep > 2 ? '✓' : '2' }}
          </span>
          <span>Install the app on GitHub, picking the repos to deploy</span>
          <span v-if="setupStep > 2 && setup.repos != null" class="hint">
            {{ setup.repos }} repo{{ setup.repos === 1 ? '' : 's' }} reachable
          </span>
          <span class="spacer"></span>
          <a v-if="setupStep === 2 && setup.install_url" :href="setup.install_url">
            <button class="small">Install on GitHub</button>
          </a>
        </div>
        <div class="crew-row">
          <span class="chip" :class="setupStep === 3 ? 'blue' : ''">3</span>
          <span>Moor your first project — pick the repo, give it a deploy script</span>
          <span class="spacer"></span>
          <router-link v-if="setupStep === 3" to="/projects/new"><button class="small">Moor a project</button></router-link>
        </div>
      </div>

      <p v-if="setupProblem" class="error" style="margin-bottom: 0">{{ setupProblem }}</p>
      <p v-else-if="!setup" class="hint" style="margin-bottom: 0">Taking bearings…</p>
    </div>
  </div>
</template>

<script>
import ProjectRow from '../components/ProjectRow.vue'
import PierHead from '../components/PierHead.vue'
import { store } from '../store.js'
import { api } from '../api.js'
import { timeAgo, duration } from '../lib/format.js'

const FEED_TEXT = {
  success: id => `made port — voyage #${id} succeeded`,
  failed: id => `ran aground — voyage #${id} failed`,
  running: id => `voyage #${id} under way…`,
  queued: id => `voyage #${id} waiting to depart`,
  cancelled: id => `voyage #${id} called off`,
}
// Which piers are folded away is this browser's own convenience; storage
// can be missing or throw (private windows), and then everything is open.
const COLLAPSED_KEY = 'skeppa.collapsedPiers'
function loadCollapsed() {
  try {
    const ids = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Object.fromEntries((Array.isArray(ids) ? ids : []).map(id => [id, true]))
  } catch {
    return {}
  }
}
function saveCollapsed(map) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Object.keys(map).map(Number)))
  } catch {
    // not remembered — fine
  }
}

const FEED_DOT = { success: 'green', failed: 'red', running: 'blue pulse', queued: 'amber', cancelled: '' }

export default {
  name: 'DashboardView',
  components: { ProjectRow, PierHead },
  data() {
    return {
      setup: null,
      setupError: '',
      addingPier: false,
      pierName: '',
      pierBusy: false,
      pierError: '',
      collapsed: loadCollapsed(),
    }
  },
  computed: {
    // Rendered straight from the LiveState mirror — no API round-trip when
    // navigating here, and rows update live as projects change.
    projects() {
      // The server already scopes the live stream per socket; this keeps the
      // intent explicit client-side and costs nothing.
      const mineOnly = store.user?.role === 'tenant'
      return Object.values(store.live.projects ?? {})
        .map(p => p.info)
        .filter(Boolean)
        .filter(p => !mineOnly || p.owner_id === store.user.id)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    // The harbor split by owner: your own projects first, then everyone
    // else's by name. A tenant only ever has one fleet (their own), so for
    // them nothing changes; an admin sees who owns what without a legend.
    fleets() {
      const me = store.user?.id
      const groups = new Map()
      for (const p of this.projects) {
        const key = p.owner_id ?? 'none'
        if (!groups.has(key)) groups.set(key, { key, ...this.ownerLabel(p), mine: p.owner_id === me, projects: [] })
        groups.get(key).projects.push(p)
      }
      const fleets = [...groups.values()].sort((a, b) => (b.mine - a.mine) || a.label.localeCompare(b.label))
      // Within a fleet: its piers by name (empty ones too — something has to
      // be there to moor at), then the projects at no pier. A group_id the
      // store does not know (yet) reads as no pier.
      const piers = Object.values(store.live.groups ?? {})
      for (const f of fleets) {
        const own = piers
          .filter(g => g.owner_id === f.key)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(pier => ({ pier, projects: [] }))
        const byId = new Map(own.map(s => [s.pier.id, s]))
        f.loose = []
        for (const p of f.projects) (byId.get(p.group_id)?.projects ?? f.loose).push(p)
        f.piers = own
      }
      return fleets
    },
    ready() {
      return store.ready
    },
    needsSetup() {
      return this.ready && !this.projects.length
    },
    // 0 = still checking, 1 = connect GitHub, 2 = install the app, 3 = moor a project
    setupStep() {
      if (!this.setup) return 0
      if (!this.setup.configured) return 1
      if (!this.setup.installed) return 2
      return 3
    },
    setupProblem() {
      return this.setupError || this.setup?.error || ''
    },
    fleetSummary() {
      const all = Object.values(store.live.projects ?? {}).filter(p => p.info)
      const n = all.length
      const running = all.filter(p => ['online', 'published'].includes(p.pm2?.status)).length
      const attention = all.filter(
        p =>
          (p.headCommit?.sha && !p.currentDeployment && p.headCommit.sha !== p.deployedSha) ||
          ['stopped', 'errored'].includes(p.pm2?.status)
      ).length
      return `${n} vessel${n === 1 ? '' : 's'} moored · ${running} running · ${attention} need${attention === 1 ? 's' : ''} attention`
    },
    // Built straight off the LiveState mirror: the server keeps the tail of
    // each project's history in `recentDeployments`, so the log needs no
    // request of its own and moves as deploys queue, start and finish.
    feed() {
      const items = []
      const shown = new Set(this.projects.map(p => p.id)) // the same scope as the list
      for (const p of Object.values(store.live.projects ?? {})) {
        const info = p.info
        if (!info || !shown.has(info.id)) continue
        for (const d of p.recentDeployments ?? []) {
          const when = d.finishedAt || d.startedAt || d.createdAt
          items.push({
            ts: when ? new Date(when).getTime() : 0,
            owner: this.feedOwner(info),
            project: info.name,
            text: (FEED_TEXT[d.status] ?? (id => `voyage #${id} — ${d.status}`))(d.id),
            meta: [d.trigger, d.commitSha?.slice(0, 7), duration(d.startedAt, d.finishedAt), timeAgo(when)]
              .filter(v => v && v !== '—')
              .join(' · '),
            dot: FEED_DOT[d.status] ?? '',
          })
        }
        if (p.headCommit?.sha && !p.currentDeployment && p.headCommit.sha !== p.deployedSha) {
          items.push({
            ts: p.headCommit.pushedAt ? new Date(p.headCommit.pushedAt).getTime() : 0,
            owner: this.feedOwner(info),
            project: info.name,
            text: `new commits sighted on ${info.branch}`,
            meta: ['push', p.headCommit.sha.slice(0, 7), timeAgo(p.headCommit.pushedAt)].filter(Boolean).join(' · '),
            dot: 'amber',
          })
        }
      }
      return items.sort((a, b) => b.ts - a.ts).slice(0, 8)
    },
  },
  watch: {
    // The checklist only concerns an empty harbor — don't poke GitHub on
    // every dashboard visit once projects exist.
    needsSetup: { immediate: true, handler(v) { if (v && !this.setup) this.checkSetup() } },
  },
  methods: {
    startPier() {
      this.addingPier = true
      this.pierName = ''
      this.pierError = ''
      this.$nextTick(() => this.$refs.pierName?.focus())
    },
    // A pier made here is the signed-in user's own; an admin sorts someone
    // else's projects from that project's Rigging, which makes the pier in
    // the owner's fleet.
    async createPier() {
      if (!this.pierName.trim() || this.pierBusy) return
      this.pierBusy = true
      this.pierError = ''
      try {
        await api.post('/api/groups', { name: this.pierName })
        this.addingPier = false
      } catch (err) {
        this.pierError = err.fields?.name || err.message
      } finally {
        this.pierBusy = false
      }
    },
    isCollapsed(id) {
      return Boolean(this.collapsed[id])
    },
    toggleCollapsed(id) {
      if (this.collapsed[id]) delete this.collapsed[id]
      else this.collapsed[id] = true
      saveCollapsed(this.collapsed)
    },
    // The owner's name as the crew list knows it (admins mirror the crew;
    // a tenant never sees anyone else's projects, so never needs it).
    ownerName(info) {
      return store.live.users?.[info.owner_id]?.username || info.owner_handle || `crew #${info.owner_id}`
    },
    ownerLabel(info) {
      if (info.owner_id == null) return { label: 'Unowned', detail: '' }
      if (info.owner_id === store.user?.id) return { label: 'Your fleet', detail: '' }
      const where = info.owner_role === 'tenant' ? info.owner_domain || (info.owner_handle ? `@${info.owner_handle}` : '') : 'admin'
      return { label: this.ownerName(info), detail: where }
    },
    // Only other people's entries are tagged: your own read as they always did.
    feedOwner(info) {
      return info.owner_id === store.user?.id ? '' : this.ownerName(info)
    },
    async checkSetup() {
      this.setupError = ''
      try {
        this.setup = await api.get('/api/github/setup')
      } catch (err) {
        this.setupError = err.message
      }
    },
  },
}
</script>
