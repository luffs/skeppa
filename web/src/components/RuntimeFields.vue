<template>
  <!-- No wrapper element: the fields are siblings of the form's own labels, so
       they keep the shared vertical rhythm (a wrapper would make the first
       label a :first-child and zero its top margin). -->
  <label>Runtime</label>
  <select :value="runtime" class="code" @change="$emit('update:runtime', $event.target.value)">
    <option value="pm2">pm2 — host process</option>
    <option value="container">container — rootless podman</option>
  </select>
  <p class="hint" v-if="runtime === 'container'">
    The start command runs in a disposable container: source read-only at
    <span class="mono">/app</span>, <span class="mono">shared/</span> writable at
    <span class="mono">/data</span>, the app port published on localhost.<template v-if="existing">
    Takes effect on the next deploy or restart.</template>
  </p>

  <label>Build image</label>
  <ImagePicker
    :model-value="buildImage"
    @update:model-value="$emit('update:buildImage', $event)"
  />
  <p class="hint">
    OCI image the deploy script runs in when the podman build sandbox is enabled
    (<span class="mono">SKEPPA_SANDBOX=podman</span>). Ignored in host mode.
  </p>

  <template v-if="runtime === 'container'">
    <label>Run image</label>
    <ImagePicker
      :model-value="runImage"
      :fallback="buildImage"
      fallback-label="same as build image"
      @update:model-value="$emit('update:runImage', $event)"
    />

    <label>Memory limit <span class="soft">(MB, blank = unlimited)</span></label>
    <input
      :value="memoryMb"
      class="code"
      placeholder="unlimited"
      @input="$emit('update:memoryMb', $event.target.value)"
    />
    <p class="hint">
      Hard cap: past it the app is OOM-killed and restarted by the engine, so a
      leak crashes this project instead of starving the server.<template v-if="existing">
      Applies on the next deploy or restart.</template>
    </p>

    <label>Network profile</label>
    <select :value="networkProfile" class="code" @change="$emit('update:networkProfile', $event.target.value)">
      <option value="open">open — internet and LAN, as before</option>
      <option value="restricted">restricted — only its shared networks, nothing else</option>
    </select>
    <p class="hint" v-if="networkProfile === 'restricted'">
      No internet, no LAN, no host — enforced by having no route out. The app
      port stays routable, and it reaches the containers on its shared networks.
      With no networks listed it gets a private one of its own. The setting for
      code you don't fully trust.<template v-if="existing"> Applies on the next
      deploy or restart.</template>
    </p>

    <label>Shared networks <span class="soft">(names, space-separated — blank for none)</span></label>
    <input
      :value="networks"
      class="code"
      placeholder="db-net"
      @input="$emit('update:networks', $event.target.value)"
    />
    <p class="hint">
      Projects listing the same name can reach each other by container name
      (<span class="mono">skeppa-app-&lt;slug&gt;</span>). Shared networks never
      grant internet — that comes from the profile.
    </p>

    <label class="check-label" v-if="networkProfile === 'open' && !networks.trim()">
      <input
        type="checkbox"
        :checked="hostAccess"
        @change="$emit('update:hostAccess', $event.target.checked)"
      />
      Host access — reach services on the server's own 127.0.0.1
    </label>
  </template>

  <template v-else>
    <label>pm2 process name</label>
    <input
      :value="pm2Name"
      class="code"
      @input="$emit('update:pm2Name', $event.target.value)"
    />
  </template>
</template>

<script>
import ImagePicker from './ImagePicker.vue'

// Runtime picker plus the images and names that go with it — the build sandbox
// image, and per runtime either the run image or the pm2 process name. Shared by
// the new-project form and the project's Rigging tab so a change to how apps
// build and run reaches both places at once.
export default {
  name: 'RuntimeFields',
  components: { ImagePicker },
  props: {
    runtime: { type: String, default: 'pm2' },
    buildImage: { type: String, default: '' },
    runImage: { type: String, default: '' },
    pm2Name: { type: String, default: '' },
    memoryMb: { type: [String, Number], default: '' },
    networkProfile: { type: String, default: 'open' },
    hostAccess: { type: Boolean, default: false },
    networks: { type: String, default: '' },
    // Wording differs slightly for a project that already exists.
    existing: { type: Boolean, default: false },
  },
  emits: ['update:runtime', 'update:buildImage', 'update:runImage', 'update:pm2Name', 'update:memoryMb',
    'update:networkProfile', 'update:hostAccess', 'update:networks'],
}
</script>
