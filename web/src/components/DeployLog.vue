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
import { subscribeLogs } from '../ws.js'

// Live log for running deployments (WS subscription with server-sent backlog),
// stored log for finished ones. Auto-scrolls unless the user scrolled up.
export default {
  name: 'DeployLog',
  props: {
    deploymentId: { type: Number, required: true },
    active: { type: Boolean, default: false },
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
          else this.text += evt.line + '\n'
        })
      } else {
        const dep = await api.get(`/api/deployments/${this.deploymentId}`).catch(() => null)
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
