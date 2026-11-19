<template>
  <button type="button" class="copy-button" :class="{ copied }" :title="copied ? 'Copied' : label" :aria-label="label" @click.stop="copy">
    <span aria-hidden="true">{{ copied ? '✓' : '⧉' }}</span>
  </button>
</template>

<script>
// Copies `text` to the clipboard, for a value shown cut short (a long path)
// that would otherwise be impossible to select whole. The clipboard API
// needs a secure context; elsewhere (plain-HTTP dev) a selected textarea and
// execCommand do it.
export default {
  name: 'CopyButton',
  props: {
    text: { type: String, required: true },
    label: { type: String, default: 'Copy' },
  },
  data() {
    return { copied: false }
  },
  unmounted() {
    clearTimeout(this.timer)
  },
  methods: {
    async copy() {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(this.text)
        else this.copyBySelection()
      } catch {
        try { this.copyBySelection() } catch { return }
      }
      this.copied = true
      clearTimeout(this.timer)
      this.timer = setTimeout(() => { this.copied = false }, 1500)
    },
    copyBySelection() {
      const area = document.createElement('textarea')
      area.value = this.text
      area.setAttribute('readonly', '')
      area.style.position = 'absolute'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      try {
        if (!document.execCommand('copy')) throw new Error('copy refused')
      } finally {
        area.remove()
      }
    },
  },
}
</script>
