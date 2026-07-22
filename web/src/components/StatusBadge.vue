<template>
  <span class="badge" :class="color">{{ status || 'unknown' }}</span>
</template>

<script>
const COLORS = {
  success: 'green',
  online: 'green',
  running: 'blue',
  queued: 'yellow',
  stopping: 'yellow',
  launching: 'yellow',
  failed: 'red',
  errored: 'red',
  stopped: 'red',
  cancelled: '',
}

export default {
  name: 'StatusBadge',
  props: { status: { type: String, default: '' } },
  computed: {
    color() {
      return COLORS[this.status] ?? ''
    },
  },
}
</script>
