<template>
  <!-- No wrapper element: the fields are siblings of the form's own labels, so
       they keep the shared vertical rhythm (a wrapper would make the first
       label a :first-child and zero its top margin). -->
  <label>Build image</label>
  <ImagePicker
    :model-value="buildImage"
    @update:model-value="$emit('update:buildImage', $event)"
  />
  <FieldError :errors="errors" name="build_image" />
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
    <FieldError :errors="errors" name="run_image" />

    <label>Memory limit <span class="soft">(MB, blank = unlimited)</span></label>
    <input
      :value="memoryMb"
      class="code"
      placeholder="unlimited"
      @input="$emit('update:memoryMb', $event.target.value)"
    />
    <FieldError :errors="errors" name="memory_mb" />
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
    <FieldError :errors="errors" name="network_profile" />
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
    <FieldError :errors="errors" name="networks" />
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
    <FieldError :errors="errors" name="host_access" />

    <!-- Server directories in the app's container: an admin's to set (the server enforces it). -->
    <template v-if="!tenant && (mountRoots.length || mounts.trim())">
      <label>Host mounts <span class="soft">(one per line — <span class="mono">host:container</span>, <span class="mono">:ro</span> after it for read-only)</span></label>
      <textarea
        :value="mounts"
        class="code"
        rows="2"
        :placeholder="`${mountRoots[0] || '/mnt/nas'}/media:/media:ro`"
        @input="$emit('update:mounts', $event.target.value)"
      ></textarea>
      <FieldError :errors="errors" name="mounts" />
      <p class="hint">
        Directories on the server — a network share mounted there, say — inside the app's container.
        <template v-if="mountRoots.length">Only from under <span class="mono">{{ mountRoots.join(', ') }}</span>
        (<span class="mono">MOUNT_ROOTS</span>), and never the panel's own directories.</template>
        <template v-else>Nothing is mountable now: <span class="mono">MOUNT_ROOTS</span> is not set in the panel config.</template>
        The deploy script never sees them, and the owner of a tenant's project cannot change them.<template v-if="existing">
        Applies on the next deploy or restart.</template>
      </p>
    </template>
    <p v-else-if="!tenant" class="hint">
      To mount server directories (a network share) into containers, name where they may come from with
      <span class="mono">MOUNT_ROOTS=/mnt/nas</span> in the panel config, and restart the panel.
    </p>
    <template v-else-if="mountList.length">
      <label>Host mounts</label>
      <ul class="mount-list">
        <li v-for="m in mountList" :key="m.target"><span class="mono">{{ m.target }}</span> — server directory <span class="mono">{{ m.host }}</span>{{ m.readOnly ? ', read-only' : '' }}</li>
      </ul>
      <p class="hint">Given to this project by an admin; only an admin can change them.</p>
    </template>
  </template>

  <template v-else-if="runtime === 'pm2'">
    <label>pm2 process name</label>
    <input
      :value="pm2Name"
      class="code"
      @input="$emit('update:pm2Name', $event.target.value)"
    />
    <FieldError :errors="errors" name="pm2_name" />
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
    <FieldError :errors="errors" name="publish_dir" />
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
import FieldError from './FieldError.vue'
import { store } from '../store.js'

const COMMON_PUBLISH_DIRS = ['dist', 'web/dist', 'client/dist']

// What goes with the chosen runtime (RuntimeChoice.vue picks it): the build
// sandbox image; per runtime the run image and limits or the pm2 process
// name; and the publish directory, for a static site or an app whose build
// output the gate serves. Shared by the new-project form and the project's
// Rigging tab so a change to how apps build and run reaches both at once.
export default {
  name: 'RuntimeFields',
  components: { ImagePicker, FieldError },
  props: {
    runtime: { type: String, default: 'container' },
    buildImage: { type: String, default: '' },
    runImage: { type: String, default: '' },
    pm2Name: { type: String, default: '' },
    memoryMb: { type: [String, Number], default: '' },
    networkProfile: { type: String, default: 'open' },
    hostAccess: { type: Boolean, default: false },
    networks: { type: String, default: '' },
    // Host directories in the container, as the server stores them (lib/mounts.js).
    mounts: { type: String, default: '' },
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
    // The server's field errors, each shown under its field (FieldError).
    errors: { type: Object, default: () => ({}) },
  },
  emits: ['update:buildImage', 'update:runImage', 'update:pm2Name', 'update:memoryMb',
    'update:networkProfile', 'update:hostAccess', 'update:networks', 'update:publishDir', 'update:spaFallback', 'update:gateFiles', 'update:mounts'],
  computed: {
    // Where the panel allows host mounts from (MOUNT_ROOTS) — admins see the panel store.
    mountRoots() {
      const roots = store.live?.system?.mountRoots
      return Array.isArray(roots) ? roots : []
    },
    // The stored lines, for reading: { host, target, readOnly }.
    mountList() {
      return this.mounts.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const [host = '', target = '', mode = ''] = line.split(':')
        return { host, target, readOnly: mode === 'ro' }
      })
    },
    // Where builds usually put a site, as one-click values; the current one
    // is left out.
    otherDirs() {
      return COMMON_PUBLISH_DIRS.filter(dir => dir !== this.publishDir.trim())
    },
  },
}
</script>
