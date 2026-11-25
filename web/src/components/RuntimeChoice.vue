<template>
  <label>Runtime</label>
  <div class="segmented">
    <button type="button" :class="{ active: runtime === 'container' }" @click="pick('container')">Container app</button>
    <button type="button" :class="{ active: runtime === 'static' }" @click="pick('static')">Static site</button>
    <button v-if="showHost" type="button" :class="{ active: runtime === 'pm2' }" @click="pick('pm2')">Host process (pm2)</button>
  </div>
  <p class="hint" v-if="runtime === 'container'">
    The start command runs in a disposable rootless-podman container, its port published on localhost.<template v-if="existing">
    Applies on the next deploy or restart.</template>
  </p>
  <p class="hint" v-else-if="runtime === 'static'">
    Nothing runs: the harbor gate serves what the build produced, and a failed build changes nothing.<template v-if="existing">
    Applies on the next deploy; what serves now keeps serving until then.</template>
  </p>
  <p class="hint" v-else-if="runtime === 'pm2'">
    Runs on the host as the panel's own user, no container around it — for the panel and tools you trust as much.<template v-if="existing">
    Applies on the next deploy.</template>
  </p>
  <p class="error" v-if="runtime === 'container' && engineMissing">
    No container engine is configured on this server (<span class="mono">CONTAINER_SOCKET</span>) —
    a container deploy will fail.
  </p>
  <p class="hint" v-if="!tenant && !showHost">
    <a href="#" class="text-link" @click.prevent="revealHost = true">Run it as a host process (pm2) instead…</a>
  </p>
</template>

<script>
import { shipInject } from '../lib/ship.js'

// The runtime switch, placed early in the project forms because it decides
// which fields follow (a static site has no start command, a container its
// image and limits). A container is the everyday choice and a static site the
// other one; a host process under pm2 is for the panel itself and the
// admin's own trusted tools, so it waits behind a link — and tenants never
// see it (the server refuses it for them too).
export default {
  name: 'RuntimeChoice',
  inject: shipInject, // which server (lib/ship.js)
  props: {
    runtime: { type: String, default: 'container' },
    tenant: { type: Boolean, default: false },
    existing: { type: Boolean, default: false },
  },
  emits: ['update:runtime'],
  data() {
    return { revealHost: false }
  },
  computed: {
    // A project that already is pm2 always shows the option it is set to.
    showHost() {
      return !this.tenant && (this.revealHost || this.runtime === 'pm2')
    },
    // Only an admin's store carries the system facts; '' means the panel was
    // started with no engine at all. Not loaded yet is not missing.
    engineMissing() {
      const system = this.ship.live?.system
      return Boolean(system?.appsDir) && !system.containerSocket
    },
  },
  methods: {
    pick(runtime) {
      if (runtime !== this.runtime) this.$emit('update:runtime', runtime)
    },
  },
}
</script>
