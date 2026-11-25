<template>
  <!-- A one-time join code, shown once: this panel keeps only its hash. -->
  <div class="panel fleet-join">
    <div class="row" style="justify-content: space-between">
      <span class="section-label">Pair {{ join.name }}</span>
      <button class="small secondary" @click="$emit('done')">Done</button>
    </div>
    <p style="margin: 8px 0 6px">On that server, in its Skeppa checkout:</p>
    <div class="fleet-command">
      <code>{{ command }}</code>
      <CopyButton :text="command" label="Copy the command" />
    </div>
    <p class="hint" style="margin: 8px 0 0">
      Good once, until {{ until }}. Then restart that panel (<code>pm2 reload skeppa</code>) and it shows up here.
      It dials this panel at <code>/agent</code>, so this panel needs no way in to it.
    </p>
  </div>
</template>

<script>
import CopyButton from './CopyButton.vue'

export default {
  name: 'JoinCode',
  components: { CopyButton },
  props: {
    // { name, code, expiresAt }
    join: { type: Object, required: true },
  },
  emits: ['done'],
  computed: {
    command() {
      return `bun scripts/join.js ${location.origin} ${this.join.code}`
    },
    until() {
      return new Date(this.join.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    },
  },
}
</script>

<style scoped>
.fleet-join { margin-top: 14px; max-width: 720px; }
.fleet-command { display: flex; align-items: center; gap: 8px; background: var(--bg-sunken, rgba(127, 127, 127, 0.08)); border-radius: 6px; padding: 8px 10px; }
.fleet-command code { flex: 1; overflow-x: auto; white-space: nowrap; font-size: 12px; }
</style>
