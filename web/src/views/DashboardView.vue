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

    <div v-else-if="ready" class="panel" style="margin-top: 22px">
      <p style="margin-top: 0">No vessels in the harbor yet.</p>
      <p class="hint" style="margin-bottom: 0">
        Configure the <router-link to="/settings" style="color: var(--accent)">GitHub App</router-link> first, then
        <router-link to="/projects/new" style="color: var(--accent)">moor your first project</router-link>.
      </p>
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
    return { deploymentsByProject: {} }
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
    // Deploys starting or finishing anywhere should refresh the log.
    deployStamp() {
      return Object.values(store.live.projects ?? {})
        .map(p => `${p.info?.id}:${p.currentDeployment?.id ?? ''}:${p.lastDeployment?.id ?? ''}`)
        .join('|')
    },
    feed() {
      const items = []
      for (const p of Object.values(store.live.projects ?? {})) {
        const info = p.info
        if (!info) continue
        for (const d of (this.deploymentsByProject[info.id] ?? []).slice(0, 5)) {
          const status = d.id === p.currentDeployment?.id ? p.currentDeployment.status : d.status
          const when = d.finished_at || d.started_at || d.created_at
          items.push({
            ts: when ? new Date(when).getTime() : 0,
            project: info.name,
            text: (FEED_TEXT[status] ?? (id => `voyage #${id} — ${status}`))(d.id),
            meta: [d.trigger, d.commit_sha?.slice(0, 7), duration(d.started_at, d.finished_at), timeAgo(when)]
              .filter(v => v && v !== '—')
              .join(' · '),
            dot: FEED_DOT[status] ?? '',
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
    deployStamp: { immediate: true, handler: 'loadFeed' },
  },
  methods: {
    async loadFeed() {
      const byProject = {}
      await Promise.all(
        this.projects.map(async p => {
          byProject[p.id] = await api.get(`/api/projects/${p.id}/deployments`).catch(() => [])
        })
      )
      this.deploymentsByProject = byProject
    },
  },
}
</script>
