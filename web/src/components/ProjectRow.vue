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
import { store, liveProject, appUrlFor } from '../store.js'
import { api } from '../api.js'
import { alertDialog, confirmDialog } from '../lib/dialog.js'
import { timeAgo, uptimeSince } from '../lib/format.js'
import { vesselState, statusWord, VESSEL_STATES } from '../lib/vessels.js'

const short = sha => (sha ? sha.slice(0, 7) : '')
const firstLine = text => (text ?? '').split('\n')[0].trim()

// One project in the harbor, as a row: a state dot (the same states a folded
// pier sums up — lib/vessels.js), the name, what it is doing, its address;
// below, what happened last. A button only when something wants doing —
// deploy what is new, retry what failed, start what is down — and the rest
// in the ⋯ menu, moving it between piers included. The whole row opens the
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
    // The one button on the row, when there is something to do.
    action() {
      if (this.state === 'ahead') return { key: 'deploy', label: 'Deploy latest' }
      if (this.state === 'failed') return { key: 'deploy', label: 'Retry deploy' }
      if (this.state === 'down' && !this.isStatic) return { key: 'start', label: 'Start' }
      if (this.state === 'idle' && !this.last) return { key: 'deploy', label: 'Deploy' }
      return null
    },
    // The owner's other piers; a project only ever moors at its owner's.
    piers() {
      return Object.values(store.live.groups ?? {})
        .filter(g => g.owner_id === this.project.owner_id && g.id !== this.project.group_id)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    menu() {
      const items = [{ key: 'deploy', label: 'Deploy', disabled: this.state === 'underway' }]
      if (this.appUrl) items.push({ key: 'open', label: 'Open app ↗' })
      if (!this.isStatic) {
        if (this.status === 'online') items.push({ key: 'restart', label: 'Restart' }, { key: 'stop', label: 'Stop…' })
        else items.push({ key: 'start', label: 'Start' })
      }
      items.push({ key: 'rigging', label: 'Rigging' })
      if (this.piers.length || this.project.group_id != null) {
        items.push({ heading: 'Move to pier' })
        for (const g of this.piers) items.push({ key: `pier:${g.id}`, label: g.name })
        if (this.project.group_id != null) items.push({ key: 'pier:', label: 'At anchor (no pier)' })
      }
      return items
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
      if (key === 'open') return window.open(this.appUrl, '_blank', 'noopener')
      if (key === 'rigging') return this.$router.push({ path: `/projects/${this.project.id}`, query: { tab: 'settings' } })
      if (key.startsWith('pier:')) return this.moveTo(key.slice(5))
      if (key === 'stop' && !(await confirmDialog(`Really stop "${this.project.name}"?`, { confirmLabel: 'Stop' }))) return
      this.busy = true
      try {
        if (key === 'deploy') await api.post(`/api/projects/${this.project.id}/deploy`)
        else await api.post(`/api/projects/${this.project.id}/pm2/${key}`)
      } catch (err) {
        alertDialog(`${key === 'deploy' ? 'Deploy' : key[0].toUpperCase() + key.slice(1)} failed: ${err.message}`)
      } finally {
        this.busy = false
      }
    },
    // Only the pier changes; the live store moves the row.
    async moveTo(groupId) {
      try {
        await api.patch(`/api/projects/${this.project.id}`, { group_id: groupId === '' ? null : Number(groupId) })
      } catch (err) {
        const why = err.fields ? Object.values(err.fields).join(', ') : err.message
        alertDialog(`Could not move ${this.project.name}: ${why}`)
      }
    },
  },
}
</script>
