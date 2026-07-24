<template>
  <div class="harbor-row">
    <div class="main">
      <div class="title-line">
        <router-link :to="`/projects/${project.id}`" class="name">{{ project.name }}</router-link>
        <StatusBadge :status="pm2Status" />
        <span v-if="undeployed" class="chip amber">commits ahead</span>
      </div>
      <div class="repo-line">{{ project.repo_full_name }} @ {{ project.branch }}</div>
      <div class="last-line">
        <span class="dot" :class="lastDot"></span>
        <span>{{ lastLine }}</span>
      </div>
    </div>
    <div class="side">
      <span class="uptime">{{ uptimeNote }}</span>
      <button class="secondary" :disabled="deploying" @click="deploy">
        {{ deploying ? 'Under way…' : 'Set sail' }}
      </button>
    </div>
  </div>
</template>

<script>
import StatusBadge from './StatusBadge.vue'
import { liveProject } from '../store.js'
import { api } from '../api.js'
import { timeAgo, uptimeSince } from '../lib/format.js'

export default {
  name: 'ProjectCard',
  components: { StatusBadge },
  props: { project: { type: Object, required: true } },
  computed: {
    live() {
      return liveProject(this.project.id)
    },
    pm2Status() {
      return this.live?.pm2?.status ?? 'unknown'
    },
    deploying() {
      return !!this.live?.currentDeployment
    },
    undeployed() {
      const live = this.live
      return !!live?.headCommit?.sha &&
        !live.currentDeployment &&
        live.headCommit.sha !== live.deployedSha
    },
    lastDot() {
      if (this.deploying) return 'blue pulse'
      const s = this.live?.lastDeployment?.status
      return s === 'success' ? 'green' : s === 'failed' ? 'red' : ''
    },
    lastLine() {
      if (this.deploying) return 'voyage under way…'
      const last = this.live?.lastDeployment
      if (!last) return 'never set sail'
      const word = last.status === 'success' ? 'succeeded' : last.status
      return `last voyage ${word} · ${timeAgo(last.finishedAt)}`
    },
    uptimeNote() {
      if (this.pm2Status === 'online') return `up ${uptimeSince(this.live?.pm2?.uptime)}`
      if (this.pm2Status === 'unknown') return '—'
      return 'not running'
    },
  },
  methods: {
    async deploy() {
      try {
        await api.post(`/api/projects/${this.project.id}/deploy`)
      } catch (err) {
        alert(`Deploy failed to start: ${err.message}`)
      }
    },
  },
}
</script>
