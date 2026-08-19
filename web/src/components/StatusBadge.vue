<template>
  <!-- With an href the badge doubles as the link to the running app; without
       one it stays a plain span. -->
  <component
    :is="href ? 'a' : 'span'"
    class="chip"
    :class="[color, { linked: href }]"
    v-bind="linkAttrs"
  >{{ status || 'unknown' }}<span v-if="href" class="ext" aria-hidden="true">↗</span></component>
</template>

<script>
const COLORS = {
  success: 'green',
  online: 'green',
  running: 'blue',
  queued: 'amber',
  stopping: 'amber',
  launching: 'amber',
  failed: 'red',
  errored: 'red',
  stopped: 'red',
  cancelled: '',
}

export default {
  name: 'StatusBadge',
  props: {
    status: { type: String, default: '' },
    // Public address of the app this badge describes, when it has one.
    href: { type: String, default: '' },
  },
  computed: {
    color() {
      return COLORS[this.status] ?? ''
    },
    linkAttrs() {
      if (!this.href) return {}
      return {
        href: this.href,
        target: '_blank',
        rel: 'noopener',
        title: `Open ${this.href}`,
        'aria-label': `${this.status || 'unknown'} — open ${this.href}`,
      }
    },
  },
}
</script>
