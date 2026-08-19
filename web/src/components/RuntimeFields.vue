<template>
  <div>
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

    <template v-if="runtime === 'container'">
      <label>Run image <span class="soft" v-if="!existing">(optional)</span></label>
      <input
        :value="runImage"
        class="code"
        :list="listId"
        :placeholder="existing ? 'same as build image' : 'panel default'"
        @input="$emit('update:runImage', $event.target.value)"
      />
      <datalist :id="listId">
        <option v-for="ref in imageRefs" :key="ref" :value="ref" />
      </datalist>
    </template>
  </div>
</template>

<script>
import { imageRefs } from '../lib/images.js'

// Runtime picker plus the image field that only applies to containers. Shared
// by the new-project form and the project's Rigging tab so a change to how
// apps run reaches both places at once.
export default {
  name: 'RuntimeFields',
  props: {
    runtime: { type: String, default: 'pm2' },
    runImage: { type: String, default: '' },
    // Wording differs slightly for a project that already exists.
    existing: { type: Boolean, default: false },
    // Distinct datalist ids so a view can host more than one image field.
    listId: { type: String, default: 'skeppa-run-images' },
  },
  emits: ['update:runtime', 'update:runImage'],
  computed: {
    imageRefs,
  },
}
</script>
