<template>
  <div class="image-users">
<!-- Only the projects that actually run the image. A project that merely
         builds in it says nothing about what is running, and listing every one
         of them buried the few lines that did. -->
    <div class="user" v-for="u in runners" :key="u.slug" :class="{ off: !u.restartable }">
      <router-link :to="u.id ? `/projects/${u.id}` : '/'" class="name mono">{{ u.slug }} ↗</router-link>
      <span class="state" :class="{ stale: u.imageState === 'stale' }">{{ stateOf(u) }}</span>
      <span class="reason">{{ u.reason }}</span>
    </div>

    <!-- The rest, accounted for in one line so the count in the row above
         still adds up. -->
    <p class="rest" v-if="buildOnly.length">
      {{ buildOnly.length }} {{ buildOnly.length === 1 ? 'other only builds' : 'others only build' }} in it
    </p>

    <div class="foot">
      <button
        v-if="target.list.length"
        class="secondary small"
        :disabled="busy"
        :title="`Recreate ${target.list.map(u => u.slug).join(', ')} on the image now in the store`"
        @click="restart"
      >{{ busy ? 'Restarting…' : target.label }}</button>
      <span v-if="note" class="hint">{{ note }}</span>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'
import { confirmDialog } from '../lib/dialog.js'
import { store } from '../store.js'
import { imageUsers } from '../lib/images.js'

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
    return { busy: false, note: '' }
  },
  computed: {
    users() {
      return imageUsers(store.live, this.imageRefs, this.slugs)
    },
    runners() {
      return this.users.filter(u => u.runs)
    },
    buildOnly() {
      return this.users.filter(u => !u.runs)
    },
    // What a restart here is for, in three cases. Containers the engine says
    // are behind the store are the whole point, so they win — and the button
    // disappears as they are dealt with. When the engine cannot say (no image
    // id, or a tag the store does not list), the blunt "everything running"
    // stays on offer: silence is not permission to hide the action. When it
    // can say and nothing is behind, there is nothing to do.
    target() {
      const restartable = this.users.filter(u => u.restartable)
      const stale = restartable.filter(u => u.imageState === 'stale')
      if (stale.length) return { list: stale, label: `Restart outdated (${stale.length})` }
      if (restartable.some(u => u.imageState === 'unknown')) {
        return { list: restartable, label: `Restart running (${restartable.length})` }
      }
      return { list: [], label: '' }
    },
  },
  methods: {
    // Only the drift, and only when the engine could actually tell: an empty
    // cell here says "no claim", never "up to date".
    stateOf(u) {
      if (u.imageState === 'stale') return 'behind the store'
      if (u.imageState === 'current') return 'up to date'
      return ''
    },
    // Restart is recreate (deploy/control.js), so this is the panel's way of
    // saying "run on what the store holds now". One request per project, in
    // order: a bulk endpoint would hide which of them failed.
    async restart() {
      const list = this.target.list
      const names = list.map(u => u.slug)
      const ok = await confirmDialog(
        `Restart ${names.length} container${names.length === 1 ? '' : 's'} (${names.join(', ')}) ` +
        `on the current ${this.imageRefs.join(', ') || 'image'}?`,
        { confirmLabel: 'Restart' }
      )
      if (!ok) return
      this.busy = true
      this.note = ''
      const failed = []
      for (const u of list) {
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
/* The grid lives on the list, not on each project, so the tracks are sized
   once across every row — a grid per row sizes its own max-content columns
   and the list comes out ragged. Hence `display: contents` below: each
   project's four cells become direct children of this grid. */
.image-users {
  display: grid;
  grid-template-columns: minmax(140px, max-content) max-content 1fr;
  gap: 2px 16px;
  align-items: baseline;
  padding: 4px 0 2px;
  font-size: 12.5px;
}
.user { display: contents; }
.user > * { padding: 3px 0; }
/* A restart cannot help this one — it is still a user of the image, and still
   a link, just not something the button below will touch. The dimming goes on
   the cells because `display: contents` leaves the row itself no box. */
.user.off > * { opacity: 0.55; }

.name { white-space: nowrap; }
.reason, .state { color: var(--dim); }
.rest { grid-column: 1 / -1; margin: 4px 0 0; color: var(--dim); }
.state.stale { color: var(--amber); font-weight: 600; }

.foot {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.foot:empty { display: none; }

@media (max-width: 620px) {
  /* No room for four columns; each project becomes a small block instead, and
     the rows go back to carrying their own box so the dimming has something
     to sit on. */
  .image-users { display: block; }
  .user { display: block; padding: 6px 0; }
  .user > * { display: block; padding: 0; }
  .user.off { opacity: 0.55; }
  .user.off > * { opacity: 1; }
}
</style>
