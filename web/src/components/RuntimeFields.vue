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
    // Wording differs slightly for a project that already exists.
    existing: { type: Boolean, default: false },
  },
  emits: ['update:runtime', 'update:buildImage', 'update:runImage', 'update:pm2Name'],
}
</script>
