<template>
  <div class="container">
    <div class="page-head" style="margin-bottom: 10px">
      <div>
        <h1 style="margin: 0">The harbor</h1>
        <!-- The counts are filters too: a click shows just those vessels. -->
        <div class="page-sub harbor-summary">
          {{ projects.length }} vessel{{ projects.length === 1 ? '' : 's' }} moored ·
          <button
            type="button"
            class="summary-filter"
            :class="{ active: stateFilter === 'running' }"
            :aria-pressed="stateFilter === 'running' ? 'true' : 'false'"
            title="Show only the vessels running"
            @click="toggleState('running')"
          >{{ counts.running }} running</button> ·
          <button
            type="button"
            class="summary-filter"
            :class="{ active: stateFilter === 'attention', warn: counts.attention > 0 }"
            :aria-pressed="stateFilter === 'attention' ? 'true' : 'false'"
            title="Show only the vessels that are down, failed or have new commits"
            @click="toggleState('attention')"
          >{{ counts.attention }} need{{ counts.attention === 1 ? 's' : '' }} attention</button>
        </div>
      </div>
      <div class="row">
        <button v-if="projects.length" class="secondary" @click="startPier">+ New pier</button>
        <router-link to="/projects/new"><button>+ Moor a project</button></router-link>
      </div>
    </div>

    <!-- Search and filter, both kept in the URL (?q=, ?state=), so a reload or
         Back from a project keeps them. / jumps here, Escape clears. -->
    <div v-if="projects.length" class="harbor-tools">
      <div class="harbor-search">
        <input
          ref="search"
          v-model="query"
          type="search"
          placeholder="Search vessels — name, repo, branch, pier"
          aria-label="Search vessels"
          autocomplete="off"
          @keydown.esc="query = ''"
        />
        <span v-if="filtering" class="harbor-count">{{ visible.length }} of {{ projects.length }}</span>
      </div>
      <span v-if="stateFilter" class="chip blue filter-chip">
        {{ STATE_FILTERS[stateFilter].label }}
        <button type="button" class="filter-chip-clear" aria-label="Clear the filter" @click="stateFilter = ''">✕</button>
      </span>
      <span class="spacer"></span>
      <!-- While filtering every pier with a match is open, so there is nothing to
           fold; the map has nothing folded at all. -->
      <button v-if="pierIds.length && !filtering && view === 'list'" type="button" class="small secondary" @click="toggleAll">
        <StableLabel :text="allFolded ? 'Unfold all' : 'Fold all'" :variants="['Unfold all', 'Fold all']" />
      </button>
      <div class="segmented harbor-view" role="group" aria-label="Show the harbor as">
        <button type="button" :class="{ active: view === 'list' }" :aria-pressed="view === 'list' ? 'true' : 'false'" @click="setView('list')">List</button>
        <button type="button" :class="{ active: view === 'map' }" :aria-pressed="view === 'map' ? 'true' : 'false'" @click="setView('map')">Harbor</button>
      </div>
    </div>

    <!-- The map gets the whole width, the log under it; the list keeps the log beside it. -->
    <div v-if="projects.length" class="harbor-layout" :class="{ 'as-map': view === 'map' }">
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
        <p v-if="filtering && !visible.length" class="hint harbor-none">
          No vessel matches<template v-if="query"> “{{ query }}”</template><template v-if="stateFilter"> among those that {{ STATE_FILTERS[stateFilter].that }}</template><template v-if="view === 'map'"> — the rest of the harbor is dimmed</template>.
          <button type="button" class="link-button" @click="clearFilters">Clear</button>
        </p>
        <HarborMap v-if="view === 'map'" :fleets="allFleets" :matches="matchIds" :state-filter="stateFilter" :counts="counts" @toggle-state="toggleState" />
        <template v-for="f in fleets" v-else :key="f.key">
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
          <span class="mono" style="font-size: 11px; color: var(--dim)">{{ filtering ? `${visible.length} project${visible.length === 1 ? '' : 's'}` : 'all projects' }}</span>
        </div>
        <template v-if="feed.length">
          <!-- The entries scroll inside the panel; the buttons stay in reach under them. -->
          <div ref="feedScroll" class="feed-scroll">
            <!-- Under the map, with room for it, the log is ruled like a logbook:
                 a line per entry, a column per particular, read one way — down. -->
            <table v-if="logAsTable" class="feed-table">
              <!-- the columns' widths, said once: the cells follow -->
              <colgroup>
                <col class="feed-c-mark" /><col class="feed-c-time" /><col class="feed-c-vessel" /><col />
                <col class="feed-c-fact" /><col class="feed-c-fact" /><col class="feed-c-took" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" colspan="2">Time</th>
                  <th scope="col">Vessel</th>
                  <th scope="col">Event</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Commit</th>
                  <th scope="col" class="feed-took">Took</th>
                </tr>
              </thead>
              <tbody v-for="day in feedDays" :key="day.label">
                <tr class="feed-day-row"><th class="feed-day" scope="rowgroup" colspan="7">{{ day.label }}</th></tr>
                <tr v-for="e in day.entries" :key="e.key" class="feed-row">
                  <td class="feed-mark"><span class="dot" :class="e.dot"></span></td>
                  <td class="feed-fact">{{ e.when }}</td>
                  <td class="feed-vessel"><span v-if="e.owner" class="feed-owner">{{ e.owner }} ·</span> <router-link :to="e.to" class="feed-project">{{ e.project }}</router-link></td>
                  <td class="feed-event">{{ e.text }}</td>
                  <td class="feed-fact">{{ e.trigger }}</td>
                  <td class="feed-fact">{{ e.sha }}</td>
                  <td class="feed-fact feed-took">{{ e.took }}</td>
                </tr>
              </tbody>
            </table>
            <template v-for="day in feedDays" v-else :key="day.label">
              <div class="feed-day">{{ day.label }}</div>
              <div v-for="e in day.entries" :key="e.key" class="feed-entry">
                <span class="dot" :class="e.dot"></span>
                <div class="body">
                  <div class="text"><span v-if="e.owner" class="feed-owner">{{ e.owner }} ·</span> <router-link :to="e.to" class="feed-project">{{ e.project }}</router-link> {{ e.text }}</div>
                  <div class="meta">{{ e.meta }}</div>
                </div>
              </div>
            </template>
          </div>
          <div v-if="feedMore || feedShown > FEED_FIRST" class="feed-more">
            <button v-if="feedMore" type="button" class="small secondary" @click="feedShown += FEED_STEP">
              Show {{ Math.min(feedMore, FEED_STEP) }} more
            </button>
            <button v-if="feedShown > FEED_FIRST" type="button" class="small secondary" @click="showLess">
              Show less
            </button>
          </div>
          <p v-if="feedCut" class="hint feed-cut">Older voyages are in each project's own history.</p>
        </template>
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
import StableLabel from '../components/StableLabel.vue'
import HarborMap from '../components/HarborMap.vue'
import PierHead from '../components/PierHead.vue'
import { store, liveProject } from '../store.js'
import { STATE_FILTERS, filterWords, matchesSearch, matchesState, stateCounts } from '../lib/harborFilter.js'
import { api } from '../api.js'
import { logEntries, byDay } from '../lib/shiplog.js'

// The log opens on the latest few; Show more reveals what LiveState already
// holds, a step at a time.
const FEED_FIRST = 8
const FEED_STEP = 12
// From here up the log under the map has room for its seven columns.
const WIDE_LOG = '(min-width: 820px)'

// Which piers are folded away is this browser's own convenience; storage
// can be missing or throw (private windows), and then everything is open.
const COLLAPSED_KEY = 'skeppa.collapsedPiers'
const VIEW_KEY = 'skeppa.harborView'
function loadView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'list'
  } catch {
    return 'list'
  }
}
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

export default {
  name: 'DashboardView',
  components: { ProjectRow, PierHead, StableLabel, HarborMap },
  data() {
    const q = this.$route?.query ?? {}
    return {
      STATE_FILTERS,
      query: typeof q.q === 'string' ? q.q : '',
      stateFilter: q.state in STATE_FILTERS ? q.state : '',
      // List or map: from the URL first, then this browser's last choice.
      view: q.view === 'map' || q.view === 'list' ? q.view : loadView(),
      FEED_FIRST, // read by the template
      FEED_STEP,
      setup: null,
      setupError: '',
      addingPier: false,
      pierName: '',
      pierBusy: false,
      pierError: '',
      collapsed: loadCollapsed(),
      feedShown: FEED_FIRST,
      // Whether the window is wide enough for the log as a table (WIDE_LOG).
      wide: true,
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
    filtering() {
      return Boolean(this.query.trim() || this.stateFilter)
    },
    // The projects the search and the state filter let through.
    visible() {
      const words = filterWords(this.query)
      return this.projects.filter(p =>
        matchesState(liveProject(p.id), this.stateFilter) &&
        matchesSearch(p, words, {
          pierName: store.live.groups?.[p.group_id]?.name ?? '',
          ownerName: p.owner_id === store.user?.id ? '' : this.ownerName(p),
        }))
    },
    // The summary's numbers, over the whole harbor whatever is filtered.
    counts() {
      return stateCounts(this.projects.map(p => liveProject(p.id)))
    },
    // The list's harbor: filtered, only what matches — piers with nothing
    // to show included.
    fleets() {
      return this.buildFleets(this.visible, this.filtering)
    },
    // The map's: the whole harbor, which it dims rather than thins out.
    allFleets() {
      return this.buildFleets(this.projects, false)
    },
    // The ids the search and filter let through, or null when nothing filters.
    matchIds() {
      return this.filtering ? new Set(this.visible.map(p => p.id)) : null
    },
    pierIds() {
      return this.fleets.flatMap(f => f.piers.map(x => x.pier.id))
    },
    allFolded() {
      return this.pierIds.length > 0 && this.pierIds.every(id => this.collapsed[id])
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
    // Built straight off the LiveState mirror: the server keeps the tail of
    // each project's history in `recentDeployments`, so the log needs no
    // request of its own — Show more included — and moves as deploys queue,
    // start and finish. lib/shiplog.js says how far back it can be trusted.
    log() {
      const shown = new Set(this.visible.map(p => p.id)) // the same scope as the list, filter included
      const lives = Object.values(store.live.projects ?? {}).filter(p => shown.has(p.info?.id))
      return logEntries(lives, info => this.feedOwner(info))
    },
    feed() {
      return this.log.entries.slice(0, this.feedShown)
    },
    feedDays() {
      return byDay(this.feed, store.now)
    },
    // The log under the map is a table where the window has the width for
    // one; on a phone it stays the list it is beside the list.
    logAsTable() {
      return this.view === 'map' && this.wide
    },
    feedMore() {
      return this.log.entries.length - this.feed.length
    },
    // Everything the client has is shown, and some project has more than it
    // was sent: say where the rest is rather than end as if that were all.
    feedCut() {
      return !this.feedMore && this.log.horizon > 0
    },
  },
  watch: {
    query() {
      this.syncQuery()
    },
    stateFilter() {
      this.syncQuery()
    },
    view() {
      this.syncQuery()
    },
    // The checklist only concerns an empty harbor — don't poke GitHub on
    // every dashboard visit once projects exist.
    needsSetup: { immediate: true, handler(v) { if (v && !this.setup) this.checkSetup() } },
  },
  mounted() {
    window.addEventListener('keydown', this.onSlash)
    // not reactive itself: the query whose answer `wide` follows
    this.wideQuery = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_LOG) : null
    if (this.wideQuery) {
      this.wide = this.wideQuery.matches
      this.wideQuery.addEventListener?.('change', this.onWide)
    }
  },
  unmounted() {
    window.removeEventListener('keydown', this.onSlash)
    this.wideQuery?.removeEventListener?.('change', this.onWide)
  },
  methods: {
    // The harbor split by owner: your own projects first, then everyone
    // else's by name. A tenant only ever has one fleet (their own), so for
    // them nothing changes; an admin sees who owns what without a legend.
    // Within a fleet: its piers by name (empty ones too — something has to
    // be there to moor at — unless `prune`), then the projects at no pier. A
    // group_id the store does not know (yet) reads as no pier.
    buildFleets(list, prune) {
      const me = store.user?.id
      const groups = new Map()
      for (const p of list) {
        const key = p.owner_id ?? 'none'
        if (!groups.has(key)) groups.set(key, { key, ...this.ownerLabel(p), mine: p.owner_id === me, projects: [] })
        groups.get(key).projects.push(p)
      }
      const fleets = [...groups.values()].sort((a, b) => (b.mine - a.mine) || a.label.localeCompare(b.label))
      const piers = Object.values(store.live.groups ?? {})
      for (const f of fleets) {
        const own = piers
          .filter(g => g.owner_id === f.key)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(pier => ({ pier, projects: [] }))
        const byId = new Map(own.map(x => [x.pier.id, x]))
        f.loose = []
        for (const p of f.projects) (byId.get(p.group_id)?.projects ?? f.loose).push(p)
        f.piers = prune ? own.filter(x => x.projects.length) : own
      }
      return fleets
    },
    onWide(event) {
      this.wide = event.matches
    },
    // / jumps to the search, unless someone is typing somewhere already.
    onSlash(event) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const el = event.target
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      this.$refs.search?.focus()
    },
    setView(view) {
      this.view = view
      try {
        localStorage.setItem(VIEW_KEY, view)
      } catch {
        // not remembered — fine
      }
    },
    toggleState(key) {
      this.stateFilter = this.stateFilter === key ? '' : key
    },
    clearFilters() {
      this.query = ''
      this.stateFilter = ''
    },
    // Search and filter into the URL, replacing the entry: typing is not
    // history worth stepping back through.
    syncQuery() {
      const query = { ...(this.$route?.query ?? {}) }
      const q = this.query.trim()
      if (q) query.q = q
      else delete query.q
      if (this.stateFilter) query.state = this.stateFilter
      else delete query.state
      if (this.view === 'map') query.view = 'map'
      else delete query.view
      this.$router?.replace?.({ query })
    },
    toggleAll() {
      if (this.allFolded) for (const id of this.pierIds) delete this.collapsed[id]
      else for (const id of this.pierIds) this.collapsed[id] = true
      saveCollapsed(this.collapsed)
    },
    showLess() {
      this.feedShown = FEED_FIRST
      if (this.$refs.feedScroll) this.$refs.feedScroll.scrollTop = 0
    },
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
    // While filtering, a pier with a match is open, whatever is remembered —
    // and the remembered folds come back with the filter cleared.
    isCollapsed(id) {
      return !this.filtering && Boolean(this.collapsed[id])
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
