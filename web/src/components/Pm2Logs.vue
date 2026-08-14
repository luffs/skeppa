<template>
  <div class="proc-logs">
    <div class="log-toolbar">
      <div class="log-streams">
        <button :class="{ active: stream === 'out' }" @click="stream = 'out'">Output</button>
        <button :class="{ active: stream === 'err' }" @click="stream = 'err'">
          Errors<span v-if="hasErrors" class="dot red"></span>
        </button>
      </div>
      <span class="spacer"></span>
      <span class="log-meta" v-if="meta">{{ meta }}</span>
      <button class="secondary small" :disabled="busy" @click="load">↻</button>
      <button class="secondary small" :title="auto ? 'Stop auto-refresh' : 'Auto-refresh every 5s'" @click="auto = !auto">
        {{ auto ? '⏸ Live' : '▶ Paused' }}
      </button>
    </div>

    <p v-if="error" class="error" style="margin: 0 0 8px">{{ error }}</p>
    <div ref="box" class="logview" @scroll="onScroll">{{ body }}</div>
    <p class="hint" style="font-size: 11px; margin: 6px 0 0" v-if="current.path">
      <span class="mono" style="font-size: 11px">{{ current.path }}</span>
    </p>
  </div>
</template>

<script>
import { api } from '../api.js'

const EMPTY = { text: '', path: null, truncated: false, missing: false }
const REFRESH_MS = 5000

// Recent pm2 stdout/stderr for one process. The server tails both streams in a
// single response, so switching tabs is instant; polling replaces the text
// wholesale and keeps the view pinned to the bottom unless the user scrolled up.
export default {
  name: 'Pm2Logs',
  props: {
    name: { type: String, default: '' },
    // Overrides the Engine-room pm2 endpoint — the project log route serves
    // the same response shape for both runtimes.
    url: { type: String, default: '' },
    lines: { type: Number, default: 200 },
  },
  data() {
    return { data: null, stream: 'out', busy: false, error: '', auto: true, paused: false, timer: null }
  },
  computed: {
    current() {
      return this.data?.[this.stream] ?? EMPTY
    },
    hasErrors() {
      return !!this.data?.err?.text
    },
    body() {
      if (!this.data) return this.busy ? 'Loading…' : ''
      if (this.current.missing) return '(no log file yet)'
      return this.current.text || '(empty)'
    },
    meta() {
      if (!this.data) return ''
      const count = this.current.text ? this.current.text.split('\n').length : 0
      return this.current.truncated ? `last ${count} lines` : `${count} lines`
    },
  },
  watch: {
    name: { immediate: true, handler: 'load' },
    auto(on) {
      if (on) {
        this.schedule()
        this.load()
      } else {
        this.unschedule()
      }
    },
  },
  mounted() {
    if (this.auto) this.schedule()
  },
  updated() {
    if (!this.paused) this.scrollToBottom()
  },
  beforeUnmount() {
    this.unschedule()
  },
  methods: {
    schedule() {
      this.unschedule()
      this.timer = setInterval(this.load, REFRESH_MS)
    },
    unschedule() {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    },
    async load() {
      if (this.busy) return
      this.busy = true
      try {
        const target = this.url || `/api/system/pm2/${encodeURIComponent(this.name)}/logs`
        this.data = await api.get(`${target}?lines=${this.lines}`)
        this.error = ''
      } catch (err) {
        this.error = `Could not read logs: ${err.message}`
        this.unschedule()
        this.auto = false
      } finally {
        this.busy = false
      }
    },
    onScroll() {
      const el = this.$refs.box
      this.paused = el.scrollTop + el.clientHeight < el.scrollHeight - 20
    },
    scrollToBottom() {
      const el = this.$refs.box
      if (el) el.scrollTop = el.scrollHeight
    },
  },
}
</script>
