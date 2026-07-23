<template>
  <router-link :to="`/projects/${project.id}`" class="panel card">
    <div class="row" style="justify-content: space-between">
      <strong>{{ project.name }}</strong>
      <StatusBadge :status="pm2Status" />
    </div>
    <div class="hint mono" style="margin-top: 4px">
      {{ project.repo_full_name }} @ {{ project.branch }}
    </div>
    <div class="row" style="margin-top: 12px; justify-content: space-between">
      <span class="hint" v-if="live?.currentDeployment">
        <StatusBadge :status="live.currentDeployment.status" /> deploying…
      </span>
      <span class="hint" v-else-if="live?.lastDeployment">
        <StatusBadge :status="live.lastDeployment.status" />
        {{ timeAgo(live.lastDeployment.finishedAt) }}
      </span>
      <span class="hint" v-else>never deployed</span>
      <span class="hint" v-if="pm2Status === 'online'">up {{ uptimeSince(live?.pm2?.uptime) }}</span>
    </div>
    <div class="row" style="margin-top: 8px" v-if="undeployed">
      <span class="badge yellow">undeployed commits</span>
      <span class="hint mono">{{ live.headCommit.sha.slice(0, 7) }}</span>
      <span class="hint">{{ timeAgo(live.headCommit.pushedAt) }}</span>
    </div>
  </router-link>
</template>

<script>
import StatusBadge from './StatusBadge.vue'
import { liveProject } from '../store.js'
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
    undeployed() {
      const live = this.live
      return !!live?.headCommit?.sha &&
        !live.currentDeployment &&
        live.headCommit.sha !== live.deployedSha
    },
  },
  methods: { timeAgo, uptimeSince },
}
</script>
