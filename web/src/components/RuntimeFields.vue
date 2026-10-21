<template>
  <!-- No wrapper element: the fields are siblings of the form's own labels, so
       they keep the shared vertical rhythm (a wrapper would make the first
       label a :first-child and zero its top margin). -->
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

    <label class="check-label" v-if="!tenant && networkProfile === 'open' && !networks.trim()">
      <input
        type="checkbox"
        :checked="hostAccess"
        @change="$emit('update:hostAccess', $event.target.checked)"
      />
      Host access — reach services on the server's own 127.0.0.1
    </label>
  </template>

  <template v-else-if="runtime === 'pm2'">
    <label>pm2 process name</label>
    <input
      :value="pm2Name"
      class="code"
      @input="$emit('update:pm2Name', $event.target.value)"
    />
  </template>

  <template v-if="runtime !== 'static'">
    <label class="check-label">
      <input
        type="checkbox"
        :checked="gateFiles"
        @change="$emit('update:gateFiles', $event.target.checked)"
      />
      Let the harbor gate serve the build's files
    </label>
    <p class="hint">
      After the deploy script, the publish directory is copied into a snapshot, and a
      <span class="mono">GET</span> for a file in it — <span class="mono">index.html</span>,
      <span class="mono">/assets/…</span> — is answered by the gate, compressed and cached; every other
      request goes to the app as before. Only for files anyone may see: the app's own login does not
      guard them.<template v-if="existing"> Switched on, the files are served from the next deploy;
      switched off, the app answers everything again at once.</template>
    </p>
  </template>

  <template v-if="runtime === 'static' || gateFiles">
    <label>Publish directory <span class="soft">(relative to the working subdirectory — blank for the directory itself)</span></label>
    <input
      :value="publishDir"
      class="code"
      placeholder="dist"
      @input="$emit('update:publishDir', $event.target.value)"
    />
    <p class="suggest">
      <button
        v-for="dir in otherDirs"
        :key="dir"
        type="button"
        class="secondary small"
        @click="$emit('update:publishDir', dir)"
      >
        Use <span class="mono">{{ dir }}</span>
      </button>
    </p>
    <p class="hint">
      What the build produces — <span class="mono">dist</span> for Vite, <span class="mono">web/dist</span> or
      <span class="mono">client/dist</span> when the frontend has a folder of its own. A deploy that cannot
      find it fails and names the built sites it did find. Dot-files and symlinks are never published.
    </p>
  </template>

  <template v-if="runtime === 'static'">
    <label class="check-label">
      <input
        type="checkbox"
        :checked="spaFallback"
        @change="$emit('update:spaFallback', $event.target.checked)"
      />
      Single-page app — answer unknown paths with <span class="mono">index.html</span>
    </label>
    <p class="hint">
      For client-side routers (vue-router history mode): a reload on
      <span class="mono">/about</span> loads the app instead of a 404.
    </p>
  </template>
</template>

<script>
import ImagePicker from './ImagePicker.vue'

const COMMON_PUBLISH_DIRS = ['dist', 'web/dist', 'client/dist']

// What goes with the chosen runtime (RuntimeChoice.vue picks it): the build
// sandbox image; per runtime the run image and limits or the pm2 process
// name; and the publish directory, for a static site or an app whose build
// output the gate serves. Shared by the new-project form and the project's
// Rigging tab so a change to how apps build and run reaches both at once.
export default {
  name: 'RuntimeFields',
  components: { ImagePicker },
  props: {
    runtime: { type: String, default: 'container' },
    buildImage: { type: String, default: '' },
    runImage: { type: String, default: '' },
    pm2Name: { type: String, default: '' },
    memoryMb: { type: [String, Number], default: '' },
    networkProfile: { type: String, default: 'open' },
    hostAccess: { type: Boolean, default: false },
    networks: { type: String, default: '' },
    publishDir: { type: String, default: 'dist' },
    spaFallback: { type: Boolean, default: false },
    // An app (container or pm2) whose build output the gate serves.
    gateFiles: { type: Boolean, default: false },
    // Tenant projects never run as a host process and get no host access —
    // the pm2 option and the host-access toggle disappear (the server
    // enforces both).
    tenant: { type: Boolean, default: false },
    // Wording differs slightly for a project that already exists.
    existing: { type: Boolean, default: false },
  },
  emits: ['update:buildImage', 'update:runImage', 'update:pm2Name', 'update:memoryMb',
    'update:networkProfile', 'update:hostAccess', 'update:networks', 'update:publishDir', 'update:spaFallback', 'update:gateFiles'],
  computed: {
    // Where builds usually put a site, as one-click values; the current one
    // is left out.
    otherDirs() {
      return COMMON_PUBLISH_DIRS.filter(dir => dir !== this.publishDir.trim())
    },
  },
}
</script>
