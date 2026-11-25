<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 8px">
      <span class="row" style="gap: 10px">
        <span class="section-label">Below deck</span>
        <span class="mono" style="font-size: 12px; color: var(--dim)">voyage #{{ deploymentId }} log</span>
      </span>
      <button v-if="paused" class="secondary small" @click="resume">▼ Resume auto-scroll</button>
    </div>
    <div ref="box" class="logview" @scroll="onScroll">{{ text }}</div>
  </div>
</template>

<script>
import { api } from '../api.js'
import { subscribeLogs } from '../live.js'

// Live log for running deployments (the deployment's own store, backlog on
// open), stored log for finished ones. Auto-scrolls unless the user scrolled up.
export default {
  name: 'DeployLog',
  props: {
    deploymentId: { type: Number, required: true },
    active: { type: Boolean, default: false },
    // A deployment on another server reporting here (the Fleet page): its
    // live log comes through that node's store, the stored one is asked of it.
    node: { type: Number, default: 0 },
  },
  data() {
    return { text: '', paused: false, unsubscribe: null }
  },
  watch: {
    deploymentId: { immediate: true, handler: 'reload' },
    active(nowActive) {
      if (!nowActive) this.reload() // finished: swap live stream for the stored log
    },
  },
  updated() {
    if (!this.paused) this.scrollToBottom()
  },
  beforeUnmount() {
    this.unsubscribe?.()
  },
  methods: {
    async reload() {
      this.unsubscribe?.()
      this.unsubscribe = null
      this.text = ''
      this.paused = false
      if (this.active) {
        this.unsubscribe = subscribeLogs(this.deploymentId, evt => {
          if (evt.type === 'backlog') this.text = evt.log
          else if (evt.type === 'line') this.text += evt.line + '\n'
        }, { node: this.node })
      } else {
        const path = this.node ? `/api/nodes/${this.node}/deployments/${this.deploymentId}` : `/api/deployments/${this.deploymentId}`
        const dep = await api.get(path).catch(err => ({ log: `(${err?.message ?? 'could not load the log'})` }))
        this.text = dep?.log ?? ''
      }
    },
    onScroll() {
      const el = this.$refs.box
      this.paused = el.scrollTop + el.clientHeight < el.scrollHeight - 20
    },
    resume() {
      this.paused = false
      this.scrollToBottom()
    },
    scrollToBottom() {
      const el = this.$refs.box
      if (el) el.scrollTop = el.scrollHeight
    },
  },
}
</script>
