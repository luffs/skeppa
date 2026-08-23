<template>
  <div>
    <div class="row field-row">
      <div style="flex: 1 1 160px">
        <label>Subdomain <span class="soft" v-if="!existing">(optional)</span></label>
        <input
          :value="subdomain"
          class="code"
          placeholder="myapp"
          @input="$emit('update:subdomain', $event.target.value)"
        />
      </div>
      <div style="flex: 1 1 120px">
        <label>App port <span class="soft">(blank = auto)</span></label>
        <input
          :value="port"
          class="code"
          placeholder="auto"
          @input="$emit('update:port', $event.target.value)"
        />
      </div>
    </div>

    <p class="hint" v-if="routedUrl">
      Routed:
      <!-- Only linkable once the project exists; before that there is nothing
           deployed at that address yet. -->
      <a v-if="existing" :href="routedUrl" target="_blank" rel="noopener" class="mono" style="font-size: 12.5px">{{ routedUrl }}</a>
      <span v-else class="mono" style="font-size: 12.5px">{{ routedUrl }}</span>
      <template v-if="port"> → localhost:{{ port }} · the app gets <span class="mono" style="font-size: 12px">PORT={{ port }}</span></template>
      <template v-else> → the port assigned on save</template>
    </p>
    <p class="hint" v-else-if="subdomain && !baseDomain">
      Set a base domain under Rigging → Harbor gate to route this subdomain.
    </p>
    <p class="hint" v-else>
      Optional: route <span class="mono" style="font-size: 12px">subdomain.&lt;base domain&gt;</span>
      to this app through the harbor gate proxy.
    </p>
  </div>
</template>

<script>
import { store } from '../store.js'

// Subdomain + port with the harbor gate preview. Shared by the new-project
// form and the Rigging tab; the base domain rides along in LiveState, so the
// preview needs no request of its own.
export default {
  name: 'RoutingFields',
  props: {
    subdomain: { type: String, default: '' },
    port: { type: [String, Number], default: '' },
    existing: { type: Boolean, default: false },
  },
  emits: ['update:subdomain', 'update:port'],
  computed: {
    baseDomain() {
      return store.live.proxy?.baseDomain ?? ''
    },
    routedUrl() {
      if (!this.subdomain || !this.baseDomain) return ''
      return `https://${this.subdomain}.${this.baseDomain}`
    },
  },
}
</script>
