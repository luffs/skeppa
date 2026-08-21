import { reactive } from 'vue'

// Promise-based replacement for window.confirm/alert. The native dialogs
// block the main thread for as long as they sit open, which stalls WebSocket
// message handling long enough for the live connection to drop — the page
// used to come back from a confirm already disconnected. These render an
// in-page <dialog> (AppDialog.vue) instead and never stop the world.
export const dialogState = reactive({
  open: false,
  message: '',
  confirmLabel: '',
  cancelLabel: '',
  danger: false,
  alertOnly: false,
})

let resolver = null
const queue = []

function present({ props, resolve }) {
  Object.assign(dialogState, props, { open: true })
  resolver = resolve
}

function enqueue(props) {
  return new Promise(resolve => {
    if (dialogState.open) queue.push({ props, resolve })
    else present({ props, resolve })
  })
}

// Resolves true on confirm, false on cancel/escape/backdrop click.
export function confirmDialog(message, { confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false } = {}) {
  return enqueue({ message, confirmLabel, cancelLabel, danger, alertOnly: false })
}

// One acknowledge button; resolves once dismissed.
export function alertDialog(message, { confirmLabel = 'OK' } = {}) {
  return enqueue({ message, confirmLabel, cancelLabel: '', danger: false, alertOnly: true })
}

// Called by AppDialog when the user settles the open dialog.
export function settleDialog(result) {
  if (!dialogState.open) return
  dialogState.open = false
  resolver?.(result)
  resolver = null
  const next = queue.shift()
  if (next) present(next)
}
