<template>
  <div>
    <select class="code" :value="selectValue" @change="onSelect">
      <option value="">{{ fallbackOption }}</option>
      <optgroup label="Shipyard" v-if="shipyard.length">
        <option v-for="img in shipyard" :key="img.ref" :value="img.ref">
          {{ img.name }} — {{ shipyardNote(img) }}
        </option>
      </optgroup>
      <optgroup label="Local image store" v-if="registry.length">
        <option v-for="img in registry" :key="img.ref" :value="img.ref">
          {{ img.ref }}{{ img.size == null ? '' : ` — ${bytes(img.size)}` }}
        </option>
      </optgroup>
      <option :value="CUSTOM">Custom…</option>
    </select>

    <input
      v-if="custom"
      ref="customInput"
      :value="modelValue"
      class="code"
      style="margin-top: 6px"
      placeholder="registry/image:tag"
      spellcheck="false"
      @input="$emit('update:modelValue', $event.target.value)"
    />

    <p class="hint status-line" v-if="status.text">
      <span v-if="status.chip" class="chip" :class="status.chip.tone">{{ status.chip.text }}</span>
      <span class="mono" style="font-size: 12.5px">{{ resolved }}</span>
      <span>{{ status.text }}</span>
      <router-link v-if="status.shipyard" to="/shipyard">Shipyard ↗</router-link>
      <button
        v-if="status.canPull"
        class="secondary small"
        :disabled="pulling"
        title="Fetch it from its registry now instead of during the next deploy"
        @click="pull"
      >{{ pulling ? 'Pulling…' : 'Pull now' }}</button>
    </p>
    <p v-if="pullError" class="error">{{ pullError }}</p>
  </div>
</template>

<script>
import { api } from '../api.js'
import { liveImages, managedWithStore, registryImages, isManagedRef } from '../lib/images.js'
import { bytes, timeAgo } from '../lib/format.js'

// Not a value any image reference can take, so it cannot collide with one.
const CUSTOM = ' custom'

// Picks an image reference for the build/run image fields: the Shipyard's
// images and whatever the local store already holds, grouped and labelled, with
// free text as the escape hatch for something neither list has yet. Everything
// it shows comes from the LiveState mirror, so the list follows a Shipyard
// build or a pull without asking for anything.
//
// The line underneath answers the question the old bare text field left to the
// next deploy: is this image actually going to be there? It never claims more
// than it knows — with the engine unreachable the store is simply unknown, and
// saying "not built" then would be a lie about every image.
export default {
  name: 'ImagePicker',
  props: {
    modelValue: { type: String, default: '' },
    // What an empty value resolves to. Empty means the panel default, which is
    // also what an unset `fallback` collapses to (the run image inherits the
    // build image — until that is empty too).
    fallback: { type: String, default: '' },
    fallbackLabel: { type: String, default: 'panel default' },
  },
  emits: ['update:modelValue'],
  data() {
    return { CUSTOM, custom: false, pulling: false, pullError: '' }
  },
  computed: {
    images() {
      return liveImages()
    },
    shipyard() {
      return managedWithStore(this.images)
    },
    registry() {
      return registryImages(this.images)
    },
    knownRefs() {
      return [...this.shipyard.map(i => i.ref), ...this.registry.map(i => i.ref)]
    },
    // The reference that actually gets used, whether picked or inherited.
    resolved() {
      return this.modelValue || this.fallback || this.images?.defaultImage || ''
    },
    fallbackOption() {
      const label = this.fallback ? this.fallbackLabel : 'panel default'
      const ref = this.fallback || this.images?.defaultImage
      return ref ? `${label} — ${ref}` : label
    },
    selectValue() {
      return this.custom ? CUSTOM : this.modelValue
    },
    // Only decided once the lists have arrived: before that everything looks
    // unknown, and the field would flip to free text for no reason.
    valueUnlisted() {
      return !!this.modelValue && !!this.images && !this.knownRefs.includes(this.modelValue)
    },
    status() {
      const ref = this.resolved
      if (!ref || !this.images) return {}
      const hit = this.shipyard.find(img => img.ref === ref)
      if (hit) return this.shipyardStatus(hit)
      if (isManagedRef(this.images, ref)) {
        return {
          chip: { text: 'undefined', tone: 'red' },
          text: 'is a Skeppa-managed name with no Shipyard definition — a deploy would fail on it.',
          shipyard: true,
        }
      }
      if (!this.images.storeListed) {
        return { text: '— engine unreachable, so the local store cannot be checked.' }
      }
      const local = this.registry.find(img => img.ref === ref)
      if (local) {
        return { chip: { text: 'in store', tone: 'green' }, text: bytes(local.size) }
      }
      return {
        chip: { text: 'not in store', tone: 'amber' },
        text: '— pulled from its registry the first time something needs it.',
        canPull: true,
      }
    },
  },
  watch: {
    // Only ever switches free text on: a reference neither list offers has to
    // stay editable. Switching it back off is the select's job, so typing
    // something that happens to match a listed image cannot yank the field away
    // mid-edit.
    valueUnlisted: {
      immediate: true,
      handler(unlisted) {
        if (unlisted) this.custom = true
      },
    },
  },
  methods: {
    bytes,
    shipyardNote(img) {
      if (img.last_build_status === 'failed') return 'last build failed'
      if (img.exists === false) return 'not built'
      if (img.last_built_at) return `built ${timeAgo(img.last_built_at)}`
      return 'never built'
    },
    shipyardStatus(img) {
      const facts = [
        img.size == null ? '' : bytes(img.size),
        img.last_built_at ? `built ${timeAgo(img.last_built_at)}` : 'never built',
      ].filter(Boolean)
      const status = { shipyard: true, text: facts.join(' · ') }
      if (img.last_build_status === 'failed') {
        status.chip = { text: 'build failed', tone: 'red' }
      } else if (img.exists === false) {
        status.chip = { text: 'not built', tone: 'amber' }
        status.text = '— rebuilt from its Containerfile when something needs it.'
      } else if (img.exists) {
        status.chip = { text: 'in store', tone: 'green' }
      }
      return status
    },
    onSelect(event) {
      const value = event.target.value
      if (value === CUSTOM) {
        this.custom = true
        this.$nextTick(() => this.$refs.customInput?.focus())
        return
      }
      this.custom = false
      this.$emit('update:modelValue', value)
    },
    // The same pull the Shipyard offers, aimed at the reference in this field —
    // so a missing image is a click here instead of a surprise halfway into a
    // deploy. LiveState republishes the store afterwards, which is what flips
    // the line above to "in store".
    async pull() {
      this.pulling = true
      this.pullError = ''
      try {
        await api.post('/api/images/pull', { ref: this.resolved })
      } catch (err) {
        this.pullError = `Pull failed: ${err.message}`
      } finally {
        this.pulling = false
      }
    },
  },
}
</script>

<style scoped>
.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
