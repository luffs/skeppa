<template>
  <div class="pier-picker">
    <label>Pier <span class="soft">(optional — where it is listed in the harbor; changes nothing it runs)</span></label>
    <select v-if="!creating" v-model="selected">
      <option value="">No pier — at anchor</option>
      <option v-for="g in piers" :key="g.id" :value="g.id">{{ g.name }}</option>
      <option value="new">New pier…</option>
    </select>
    <div v-else class="row">
      <input
        ref="name"
        v-model="newName"
        class="pier-name-input"
        maxlength="40"
        placeholder="Pier name"
        @keydown.enter.prevent="create"
        @keydown.esc.prevent="cancel"
      />
      <button type="button" class="small" :disabled="busy || !newName.trim()" @click="create">
        {{ busy ? 'Building…' : 'Create' }}
      </button>
      <button type="button" class="small secondary" :disabled="busy" @click="cancel">Cancel</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script>
import { store } from '../store.js'
import { api } from '../api.js'

// Which pier (project group) a project is listed at. Only the owner's piers
// are offered — the server refuses any other — and "New pier…" makes one in
// the owner's fleet on the spot. v-model is the pier id, '' for none.
export default {
  name: 'PierPicker',
  props: {
    modelValue: { type: [Number, String], default: '' },
    ownerId: { type: Number, default: null },
  },
  emits: ['update:modelValue'],
  data() {
    return { creating: false, newName: '', busy: false, error: '', made: null }
  },
  computed: {
    // The one just made is offered until the live store brings it in.
    piers() {
      const all = { ...(store.live.groups ?? {}) }
      if (this.made && !all[this.made.id]) all[this.made.id] = this.made
      return Object.values(all)
        .filter(g => g.owner_id === this.ownerId)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    selected: {
      get() {
        return this.modelValue ?? ''
      },
      set(value) {
        if (value === 'new') {
          this.creating = true
          this.error = ''
          this.$nextTick(() => this.$refs.name?.focus())
          return
        }
        this.$emit('update:modelValue', value)
      },
    },
  },
  methods: {
    cancel() {
      this.creating = false
      this.newName = ''
      this.error = ''
    },
    async create() {
      if (!this.newName.trim() || this.busy) return
      this.busy = true
      this.error = ''
      try {
        const pier = await api.post('/api/groups', { name: this.newName, owner_id: this.ownerId })
        this.made = pier
        this.$emit('update:modelValue', pier.id)
        this.creating = false
        this.newName = ''
      } catch (err) {
        this.error = err.fields?.name || err.message
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
