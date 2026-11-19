<template>
  <div class="field">
    <label>Publish directory <span class="soft">(relative to the working subdirectory — blank for the directory itself)</span></label>
    <input :value="modelValue" class="code" placeholder="dist" @input="$emit('update:modelValue', $event.target.value)" />
    <FieldError :errors="errors" name="publish_dir" />
    <p class="suggest">
      <button v-for="dir in otherDirs" :key="dir" type="button" class="secondary small" @click="$emit('update:modelValue', dir)">
        Use <span class="mono">{{ dir }}</span>
      </button>
    </p>
    <p class="hint">What the build produces. A deploy that cannot find it fails and names the built sites it did find; dot-files and symlinks are never published.</p>
  </div>
</template>

<script>
import FieldError from './FieldError.vue'

const COMMON_PUBLISH_DIRS = ['dist', 'web/dist', 'client/dist']

// Where the build puts the files the harbor gate serves: a static site's
// whole site (Runtime), or an app's built files (Routing, gate files).
export default {
  name: 'PublishDirField',
  components: { FieldError },
  props: {
    modelValue: { type: String, default: 'dist' },
    errors: { type: Object, default: () => ({}) },
  },
  emits: ['update:modelValue'],
  computed: {
    // Where builds usually put a site, as one-click values; the current one is left out.
    otherDirs() {
      return COMMON_PUBLISH_DIRS.filter(dir => dir !== (this.modelValue ?? '').trim())
    },
  },
}
</script>
