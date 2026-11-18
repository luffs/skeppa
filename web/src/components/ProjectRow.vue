<template>
  <div class="vessel-row" :class="'state-' + state" :title="repoTitle" @click="openProject">
    <div class="vessel-main">
      <div class="vessel-l1">
        <span class="dot" :class="dot" aria-hidden="true"></span>
        <router-link :to="`/projects/${project.id}`" class="vessel-name" @click.stop>{{ project.name }}</router-link>
        <span class="vessel-status">{{ statusText }}</span>
        <a v-if="appUrl" :href="appUrl" target="_blank" rel="noopener" class="vessel-addr" @click.stop>
          {{ appHost }}<span aria-hidden="true"> ↗</span>
        </a>
      </div>
      <div class="vessel-l2">{{ detail }}</div>
    </div>
    <div class="vessel-actions" @click.stop>
      <button v-if="action" type="button" class="small secondary" :disabled="busy" @click="run(action.key)">
        {{ busy ? 'Working…' : action.label }}
      </button>
      <ActionMenu :label="`Vessel ${project.name}`" :items="menu" @select="run" />
    </div>
  </div>
</template>

<script>
import ActionMenu from './ActionMenu.vue'
import { liveProject, appUrlFor } from '../store.js'
import { primaryAction, actionMenu, performAction, lastVoyageId } from '../lib/vesselActions.js'
import { timeAgo, uptimeSince } from '../lib/format.js'
import { vesselState, statusWord, VESSEL_STATES } from '../lib/vessels.js'

const short = sha => (sha ? sha.slice(0, 7) : '')
const firstLine = text => (text ?? '').split('\n')[0].trim()

// One project in the harbor, as a row: a state dot (the same states a folded
// pier sums up — lib/vessels.js), the name, what it is doing, its address;
// below, what happened last. A button only when something wants doing —
// deploy what is new, retry what failed, start what is down — and the rest
// in the ⋮ menu, moving it between piers included. The whole row opens the
// project; its links and buttons do their own thing.
export default {
  name: 'ProjectRow',
  components: { ActionMenu },
  props: { project: { type: Object, required: true } },
  data() {
    return { busy: false }
  },
  computed: {
    live() {
      return liveProject(this.project.id)
    },
    state() {
      return vesselState(this.live)
    },
    dot() {
      return VESSEL_STATES.find(s => s.key === this.state)?.dot ?? ''
    },
    // What is being served right now, not what the form says next.
    isStatic() {
      return (this.project.deployed_runtime || this.project.runtime) === 'static'
    },
    status() {
      return this.live?.pm2?.status ?? 'unknown'
    },
    // The same word the project page's badge shows.
    word() {
      return statusWord(this.live)
    },
    last() {
      return this.live?.lastDeployment ?? null
    },
    appUrl() {
      return appUrlFor(this.project)
    },
    appHost() {
      return this.appUrl.replace(/^https?:\/\//, '')
    },
    repoTitle() {
      const repo = this.project.repo_full_name || (this.project.git_url ?? '').replace(/^https:[/][/]/, '')
      return `${repo} @ ${this.project.branch}`
    },
    statusText() {
      switch (this.state) {
        case 'underway':
          return this.live.currentDeployment.status === 'queued' ? 'waiting to depart' : 'voyage under way…'
        case 'down':
          return this.word
        case 'failed':
          return `voyage failed · ${timeAgo(this.last.finishedAt)}`
        case 'ahead':
          return 'new commits'
        case 'running':
          return this.word
        default:
          return this.word === 'unknown' ? '' : this.word
      }
    },
    // The second line: the branch, then the one thing worth knowing next.
    detail() {
      const parts = [this.project.branch]
      const head = this.live?.headCommit
      if (this.state === 'ahead' && head?.sha) {
        parts.push(`${short(head.sha)} ${firstLine(head.message)}`.trim())
      } else if (this.state === 'failed') {
        if (this.last?.commitSha) parts.push(short(this.last.commitSha))
        // A failed deploy leaves what served before untouched.
        if (this.status === 'online' || this.status === 'published') parts.push('previous build still serving')
      } else if (this.state === 'running') {
        if (this.status === 'online') parts.push(`up ${uptimeSince(this.live.pm2.uptime)}`)
        if (this.last?.commitSha) parts.push(`deployed ${short(this.last.commitSha)} · ${timeAgo(this.last.finishedAt)}`)
      } else if (this.last) {
        parts.push(`last voyage ${this.last.status === 'success' ? 'succeeded' : this.last.status} · ${timeAgo(this.last.finishedAt)}`)
      }
      return parts.filter(Boolean).join(' · ')
    },
    // The one button on the row, and the rest in ⋮ — decided in
    // lib/vesselActions.js, so the project page offers exactly the same.
    action() {
      return primaryAction(this.project, this.live)
    },
    menu() {
      return actionMenu(this.project, this.live, { exclude: this.action?.key, goto: true, piers: true })
    },
  },
  methods: {
    openProject(event) {
      // A selection being made is not a click to open.
      if (window.getSelection?.()?.toString()) return
      if (event.target.closest('a, button')) return
      this.$router.push(`/projects/${this.project.id}`)
    },
    async run(key) {
      const page = query => this.$router.push({ path: `/projects/${this.project.id}`, query })
      if (key === 'voyage') return page({ deployment: String(lastVoyageId(this.live)) })
      if (key === 'logbook') return page({ tab: 'logs' })
      if (key === 'rigging') return page({ tab: 'settings' })
      this.busy = true
      try {
        await performAction(this.project, key)
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
