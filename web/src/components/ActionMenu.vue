<template>
  <div ref="root" class="action-menu" @focusout="onFocusOut">
    <button
      ref="toggle"
      type="button"
      class="small secondary action-menu-toggle"
      :aria-label="label"
      :title="label"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open ? close() : show(0)"
      @keydown.down.prevent="show(0)"
      @keydown.up.prevent="show(-1)"
    >
      <span aria-hidden="true">⋯</span>
    </button>
    <div v-if="open" ref="list" class="action-menu-list" role="menu" :aria-label="label" @keydown="onKey">
      <template v-for="(item, i) in items" :key="item.key ?? 'h' + i">
        <!-- A heading starts a section; it is read out, never focused. -->
        <div v-if="item.heading" class="action-menu-heading" role="presentation">{{ item.heading }}</div>
        <button
          v-else
          type="button"
          role="menuitem"
          class="action-menu-item"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          :title="item.hint || null"
          @click="pick(item)"
        >
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<script>
// A "⋯" button that opens a short list of actions. Keyboard: arrows move,
// Home/End jump, Escape closes and hands focus back to the button; a click
// anywhere else or tabbing away closes it too. Emits `select` with the
// item's key — the parent does the work, confirmations included.
export default {
  name: 'ActionMenu',
  props: {
    label: { type: String, default: 'Actions' },
    // [{ key, label, danger?, disabled?, hint? }] or { heading } to start a section
    items: { type: Array, required: true },
  },
  emits: ['select'],
  data() {
    return { open: false }
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.onOutside)
  },
  methods: {
    enabled() {
      return [...(this.$refs.list?.querySelectorAll('.action-menu-item:not(:disabled)') ?? [])]
    },
    // `at` is the item to focus: 0 the first, -1 the last.
    show(at) {
      this.open = true
      document.addEventListener('pointerdown', this.onOutside)
      this.$nextTick(() => {
        const items = this.enabled()
        items.at(at)?.focus()
      })
    },
    close({ refocus = false } = {}) {
      if (!this.open) return
      this.open = false
      document.removeEventListener('pointerdown', this.onOutside)
      if (refocus) this.$refs.toggle?.focus()
    },
    pick(item) {
      if (item.disabled) return
      this.close({ refocus: true })
      this.$emit('select', item.key)
    },
    onOutside(event) {
      if (!this.$refs.root?.contains(event.target)) this.close()
    },
    onFocusOut(event) {
      if (event.relatedTarget && !this.$refs.root?.contains(event.relatedTarget)) this.close()
    },
    onKey(event) {
      const items = this.enabled()
      const here = items.indexOf(document.activeElement)
      const go = i => {
        event.preventDefault()
        items.at(i % items.length)?.focus()
      }
      if (event.key === 'ArrowDown') go(here + 1)
      else if (event.key === 'ArrowUp') go(here - 1)
      else if (event.key === 'Home') go(0)
      else if (event.key === 'End') go(-1)
      else if (event.key === 'Escape') {
        event.preventDefault()
        this.close({ refocus: true })
      } else if (event.key === 'Tab') this.close()
    },
  },
}
</script>
