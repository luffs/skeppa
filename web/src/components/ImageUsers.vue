<template>
  <span class="image-users" v-if="users.length">
    <router-link
      v-for="u in shown"
      :key="u.slug"
      :to="u.id ? `/projects/${u.id}` : '/'"
      class="chip"
      :title="roleOf(u)"
    >{{ u.slug }} ↗</router-link>

    <!-- The count only appears once the list is long enough to be in the way;
         a handful of names is more useful than a number that hides them. -->
    <button v-if="hidden" class="more" @click="expanded = !expanded">
      {{ expanded ? 'show fewer' : `+${hidden}` }}
    </button>

    <button
      v-if="restartable.length"
      class="secondary small"
      :disabled="busy"
      :title="`Recreate ${restartable.map(u => u.slug).join(', ')} on the image now in the store`"
      @click="restartAll"
    >{{ busy ? 'Restarting…' : `Restart ${restartable.length}` }}</button>

    <span v-if="note" class="hint">{{ note }}</span>
  </span>
  <span v-else class="hint">—</span>
</template>

<script>
import { api } from '../api.js'
import { confirmDialog } from '../lib/dialog.js'
import { store } from '../store.js'
import { imageUsers } from '../lib/images.js'

// How many names fit before a count serves better than the list.
const SHOWN = 3

export default {
  name: 'ImageUsers',
  // `ref` is a reserved attribute in templates, so the image's references
  // cannot be a prop by that name. Plural because one entry in the engine's
  // store can wear several tags, any of which a project may name.
  props: {
    imageRefs: { type: Array, default: () => [] },
    slugs: { type: Array, default: () => [] },
  },
  data() {
    return { expanded: false, busy: false, note: '' }
  },
  computed: {
    users() {
      return imageUsers(store.live.images, store.live.projects, this.imageRefs, this.slugs)
    },
    shown() {
      return this.expanded ? this.users : this.users.slice(0, SHOWN)
    },
    hidden() {
      return Math.max(0, this.users.length - SHOWN)
    },
    // Only the ones a restart actually moves onto the new image. Everything
    // else in the list either builds in the image (a deploy's job) or is not
    // running, and offering one button for all of them would promise what it
    // cannot do.
    restartable() {
      return this.users.filter(u => u.restartable)
    },
  },
  methods: {
    roleOf(u) {
      if (u.builds && u.runs) return 'Builds and runs in this image'
      if (u.runs) return 'Runs in this image'
      if (u.builds) return 'Builds in this image — a deploy is what picks a new one up'
      return 'Uses this image'
    },
    // Restart is recreate (deploy/control.js), so this is the panel's way of
    // saying "run on what the store holds now". One request per project, in
    // order: a bulk endpoint would hide which of them failed.
    async restartAll() {
      const names = this.restartable.map(u => u.slug)
      const ok = await confirmDialog(
        `Restart ${names.length} running container${names.length === 1 ? '' : 's'} (${names.join(', ')}) ` +
        `on the current ${this.imageRefs.join(', ') || 'image'}?`,
        { confirmLabel: 'Restart' }
      )
      if (!ok) return
      this.busy = true
      this.note = ''
      const failed = []
      for (const u of this.restartable) {
        try {
          await api.post(`/api/projects/${u.id}/pm2/restart`)
        } catch (err) {
          failed.push(`${u.slug}: ${err.message}`)
        }
      }
      this.busy = false
      this.note = failed.length
        ? `${names.length - failed.length}/${names.length} restarted — ${failed.join('; ')}`
        : `Restarted ${names.join(', ')}.`
    },
  },
}
</script>

<style scoped>
/* Inline and wrapping, so the same element works inside a table cell and in
   the flex row of chips on an image card. */
.image-users {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* A count that reads as part of the chip row rather than as another button. */
.more {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px dashed var(--line);
  background: none;
  color: var(--dim);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}
.more:hover { color: var(--ink); border-color: var(--dim); }
.image-users a.chip,
.more { cursor: pointer; }
</style>
