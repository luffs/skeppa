<template>
  <div class="pier-head">
    <template v-if="!renaming">
      <button
        type="button"
        class="pier-toggle"
        :aria-expanded="collapsed ? 'false' : 'true'"
        :title="collapsed ? 'Show the vessels at this pier' : 'Fold this pier away'"
        @click="$emit('toggle')"
      >
        <span class="pier-chevron" :class="{ open: !collapsed }" aria-hidden="true">▸</span>
        <span class="pier-name">{{ pier.name }}</span>
      </button>
      <span class="fleet-detail">{{ count }} vessel{{ count === 1 ? '' : 's' }}</span>
      <!-- Folded, the cards are out of sight: the heading says what they would. -->
      <span v-if="collapsed && summary.length" class="pier-summary">
        <span v-for="s in summary" :key="s.key" class="pier-state" :class="'state-' + s.key">
          <span class="dot" :class="s.dot"></span>{{ s.text }}
        </span>
      </span>
      <span v-if="deploying" class="fleet-detail">setting out…</span>
      <ActionMenu class="pier-actions" text="Orders" :label="`Orders for every vessel at ${pier.name}`" :items="menu" @select="onSelect" />
    </template>
    <div v-else class="row pier-rename">
      <input
        ref="name"
        v-model="newName"
        maxlength="40"
        @keydown.enter.prevent="saveName"
        @keydown.esc.prevent="renaming = false"
      />
      <button type="button" class="small" :disabled="busy || !newName.trim()" @click="saveName">Save</button>
      <button type="button" class="small secondary" :disabled="busy" @click="renaming = false">Cancel</button>
    </div>
    <p v-if="error" class="error pier-error">{{ error }}</p>
  </div>
</template>

<script>
import ActionMenu from './ActionMenu.vue'
import { store, liveProject } from '../store.js'
import { api } from '../api.js'
import { confirmDialog, alertDialog } from '../lib/dialog.js'
import { summarizeVessels } from '../lib/vessels.js'

// The heading over one pier in the harbor: fold it away (folded, it sums up
// the vessels' state), and a menu to deploy everything moored there, rename
// it, or remove it (its projects stay, at anchor).
export default {
  name: 'PierHead',
  components: { ActionMenu },
  props: {
    pier: { type: Object, required: true },
    // The project infos moored here.
    projects: { type: Array, default: () => [] },
    collapsed: { type: Boolean, default: false },
  },
  emits: ['toggle'],
  data() {
    return { renaming: false, newName: '', busy: false, deploying: false, error: '' }
  },
  computed: {
    count() {
      return this.projects.length
    },
    summary() {
      return summarizeVessels(this.projects.map(p => liveProject(p.id)))
    },
    // The server leaves the panel's own project out of a pier deploy (a
    // self-deploy reloads the panel mid-way); say so before, not after. Only
    // an admin can have it, and only an admin's store names it.
    deployable() {
      const self = store.live.system?.selfPm2Name
      return this.projects.filter(p => !(self && p.runtime === 'pm2' && p.pm2_name === self))
    },
    menu() {
      const n = this.deployable.length
      return [
        {
          key: 'deploy',
          label: n ? `Deploy all ${n}` : 'Deploy all',
          disabled: !n || this.deploying,
          hint: n ? '' : 'Nothing here to deploy',
        },
        { key: 'rename', label: 'Rename…' },
        { key: 'remove', label: 'Remove pier…', danger: true },
      ]
    },
  },
  methods: {
    onSelect(key) {
      if (key === 'deploy') this.deployAll()
      else if (key === 'rename') this.startRename()
      else if (key === 'remove') this.remove()
    },
    startRename() {
      this.newName = this.pier.name
      this.error = ''
      this.renaming = true
      this.$nextTick(() => this.$refs.name?.select())
    },
    async saveName() {
      if (!this.newName.trim() || this.busy) return
      this.busy = true
      this.error = ''
      try {
        await api.patch(`/api/groups/${this.pier.id}`, { name: this.newName })
        this.renaming = false
      } catch (err) {
        this.error = err.fields?.name || err.message
      } finally {
        this.busy = false
      }
    },
    async deployAll() {
      const n = this.deployable.length
      const left = this.count - n
      const ok = await confirmDialog(
        `Deploy all ${n} vessel${n === 1 ? '' : 's'} at “${this.pier.name}”? Each sets out on its own, as if you clicked its Deploy button.` +
          (left ? ' The panel itself stays — deploy it on its own.' : ''),
        { confirmLabel: 'Deploy all' }
      )
      if (!ok) return
      this.deploying = true
      this.error = ''
      try {
        const { skipped = [] } = await api.post(`/api/groups/${this.pier.id}/deploy`)
        // The panel was announced in the confirmation; anything else the
        // server held back is news.
        const news = skipped.filter(s => this.deployable.some(p => p.id === s.project_id))
        if (news.length) alertDialog(`Not deployed: ${news.map(s => `${s.name} (${s.reason})`).join(', ')}.`)
      } catch (err) {
        this.error = `Deploy failed: ${err.message}`
      } finally {
        this.deploying = false
      }
    },
    async remove() {
      const n = this.count
      const ok = await confirmDialog(
        `Remove the pier “${this.pier.name}”?` +
          (n ? ` Its ${n} vessel${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} in the harbor, at anchor — nothing is deployed or stopped.` : ''),
        { confirmLabel: 'Remove pier', danger: true }
      )
      if (!ok) return
      this.error = ''
      try {
        await api.del(`/api/groups/${this.pier.id}`)
      } catch (err) {
        this.error = err.message
      }
    },
  },
}
</script>
