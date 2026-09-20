<template>
  <div class="commit-line" :class="{ open }">
    <span class="mono">{{ sha ? sha.slice(0, 7) : '—' }}</span>
    <span ref="message" class="hint commit-msg" :title="open ? null : message">{{ message }}</span>
    <a v-if="open || clipped" href="#" class="commit-toggle" @click.stop.prevent="open = !open">
      {{ open ? 'less' : 'more' }}
    </a>
  </div>
</template>

<script>
// A commit's short sha and message on one line. Some repositories write a
// whole paragraph as the subject (git's %s folds the first paragraph into one
// line), which used to make a single voyage as tall as the rest of the table.
// The message is cut with an ellipsis, and only when it really is cut — that
// depends on the column's width, so it is measured, not guessed from the
// length — a "more" link opens it in place. The click stops here: in the
// voyages table the row's own click selects the deployment.
export default {
  name: 'CommitMessage',
  props: {
    sha: { type: String, default: '' },
    message: { type: String, default: '' },
  },
  data() {
    return { open: false, clipped: false, observer: null }
  },
  mounted() {
    this.measure()
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.measure())
      this.observer.observe(this.$refs.message)
    }
  },
  updated() {
    this.measure()
  },
  beforeUnmount() {
    this.observer?.disconnect()
  },
  methods: {
    // Only while closed: an open message has nothing clipped to measure, and
    // the link must stay so it can be closed again.
    measure() {
      const el = this.$refs.message
      if (!el || this.open) return
      const clipped = el.scrollWidth > el.clientWidth + 1
      if (clipped !== this.clipped) this.clipped = clipped
    },
  },
}
</script>
