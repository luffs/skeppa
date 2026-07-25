<template>
  <section class="panel collapse-section" :class="{ open }">
    <button type="button" class="collapse-head" :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
      <span class="collapse-chevron" aria-hidden="true">▸</span>
      <span class="collapse-title">{{ title }}</span>
      <span v-if="$slots.meta" class="collapse-meta" @click.stop><slot name="meta" /></span>
    </button>
    <!-- v-show, not v-if: collapsing must not wipe half-filled form fields inside. -->
    <div v-show="open" class="collapse-body">
      <slot />
    </div>
  </section>
</template>

<script>
export default {
  name: 'CollapseSection',
  props: {
    title: { type: String, required: true },
    startOpen: { type: Boolean, default: true },
  },
  data() {
    return { open: this.startOpen }
  },
}
</script>
