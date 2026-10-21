<template>
  <label>Runtime</label>
  <div class="segmented">
    <button type="button" :class="{ active: runtime === 'container' }" @click="pick('container')">Container app</button>
    <button type="button" :class="{ active: runtime === 'static' }" @click="pick('static')">Static site</button>
    <button v-if="showHost" type="button" :class="{ active: runtime === 'pm2' }" @click="pick('pm2')">Host process (pm2)</button>
  </div>
  <p class="hint" v-if="runtime === 'container'">
    The start command runs in a disposable rootless-podman container: source read-only at
    <span class="mono">/app</span>, <span class="mono">shared/</span> writable at
    <span class="mono">/data</span>, the app port published on localhost.<template v-if="existing">
    Takes effect on the next deploy or restart.</template>
  </p>
  <p class="hint" v-else-if="runtime === 'static'">
    Nothing runs: after the deploy script, the publish directory is copied into a snapshot
    that the harbor gate serves under the project's subdomain. Visitors keep the previous
    version until a build has finished, and a failed build changes nothing.<template v-if="existing">
    Takes effect on the next deploy — whatever serves the project now keeps serving it until then.</template>
  </p>
  <p class="hint" v-else-if="runtime === 'pm2'">
    Runs straight on the host as the panel's own user, under pm2 — no container around it.
    For the panel itself and tools you trust as much as the panel.<template v-if="existing">
    Takes effect on the next deploy.</template>
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
import { store } from '../store.js'

// The runtime switch, placed early in the project forms because it decides
// which fields follow (a static site has no start command, a container its
// image and limits). A container is the everyday choice and a static site the
// other one; a host process under pm2 is for the panel itself and the
// admin's own trusted tools, so it waits behind a link — and tenants never
// see it (the server refuses it for them too).
export default {
  name: 'RuntimeChoice',
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
      const system = store.live?.system
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
