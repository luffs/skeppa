<template>
  <div class="container">
    <div class="page-head" style="margin-bottom: 10px">
      <div>
        <h1 style="margin: 0">The harbor</h1>
        <div class="page-sub">{{ fleetSummary }}</div>
      </div>
      <router-link to="/projects/new"><button>+ Moor a project</button></router-link>
    </div>

    <div v-if="projects.length" class="harbor-layout">
      <div class="harbor-list">
        <ProjectCard v-for="p in projects" :key="p.id" :project="p" />
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
              <div class="text"><strong>{{ e.project }}</strong> — {{ e.text }}</div>
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
import ProjectCard from '../components/ProjectCard.vue'
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
const FEED_DOT = { success: 'green', failed: 'red', running: 'blue pulse', queued: 'amber', cancelled: '' }

export default {
  name: 'DashboardView',
  components: { ProjectCard },
  data() {
    return { setup: null, setupError: '' }
  },
  computed: {
    // Rendered straight from the LiveState mirror — no API round-trip when
    // navigating here, and rows update live as projects change.
    projects() {
      return Object.values(store.live.projects ?? {})
        .map(p => p.info)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
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
      const running = all.filter(p => p.pm2?.status === 'online').length
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
      for (const p of Object.values(store.live.projects ?? {})) {
        const info = p.info
        if (!info) continue
        for (const d of p.recentDeployments ?? []) {
          const when = d.finishedAt || d.startedAt || d.createdAt
          items.push({
            ts: when ? new Date(when).getTime() : 0,
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
