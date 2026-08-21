<template>
  <dialog ref="dlg" class="app-dialog" @cancel.prevent="settle(false)" @click="onBackdropClick">
    <p class="dialog-msg">{{ state.message }}</p>
    <div class="dialog-actions">
      <!-- Cancel first in the DOM so it takes the initial focus — Enter on a
           freshly opened dialog is the safe answer. -->
      <button v-if="!state.alertOnly" class="secondary" @click="settle(false)">{{ state.cancelLabel }}</button>
      <button :class="{ danger: state.danger }" @click="settle(true)">{{ state.confirmLabel }}</button>
    </div>
  </dialog>
</template>

<script>
import { dialogState, settleDialog } from '../lib/dialog.js'

// The one shared confirm/alert box, driven by lib/dialog.js. The native
// <dialog> element brings the focus trap and Escape handling; showModal() is
// modal without blocking the event loop, so live updates keep flowing behind
// the backdrop — the whole reason window.confirm had to go.
export default {
  name: 'AppDialog',
  data() {
    return { state: dialogState }
  },
  watch: {
    'state.open'(open) {
      const dlg = this.$refs.dlg
      if (!dlg) return
      if (open && !dlg.open) dlg.showModal()
      else if (!open && dlg.open) dlg.close()
    },
  },
  methods: {
    settle(result) {
      settleDialog(this.state.alertOnly ? undefined : result)
    },
    // A click on the backdrop lands on the <dialog> element itself; clicks on
    // the content land on its children.
    onBackdropClick(e) {
      if (e.target === this.$refs.dlg) this.settle(false)
    },
  },
}
</script>
