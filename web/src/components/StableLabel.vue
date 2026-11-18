<template>
  <span class="stable-label">
    <span
      v-for="t in all"
      :key="t"
      :class="{ 'stable-ghost': t !== text }"
      :aria-hidden="t !== text ? 'true' : null"
    >{{ t }}</span>
  </span>
</template>

<script>
// A button label that keeps its button the same size whatever it says: every
// label the button can show is laid out in the same grid cell, all but the
// current one invisible, so the widest decides the width. A button going
// "Check remote" → "Checking…" no longer nudges its neighbours along.
export default {
  name: 'StableLabel',
  props: {
    text: { type: String, required: true },
    // Every other label this button can show.
    variants: { type: Array, default: () => [] },
  },
  computed: {
    all() {
      return [...new Set([this.text, ...this.variants])]
    },
  },
}
</script>
