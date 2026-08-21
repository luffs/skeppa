<template>
  <div>
    <div class="section-head">
      <span class="section-label">managed images</span>
      <span class="mono" style="font-size: 12px; color: var(--dim)" v-if="localSummary">{{ localSummary }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="images?.engineError" class="hint">
      Engine unreachable ({{ images.engineError }}) — definitions are editable, builds and the local
      store need the engine.
    </p>

    <div class="proc-list" v-if="images">
      <div v-for="img in managedImages" :key="img.id" class="proc-card" :class="{ open: opened === img.id }">
        <!-- Same card as the Engine room's: name left, who wants it and how
             the last build went pinned right, then the numbers, the full ref
             on its own line, and the buttons. -->
        <div class="proc-head">
          <div class="proc-title">
            <span class="proc-name">{{ img.name }}</span>
            <span class="proc-tags">
              <router-link
                v-for="slug in img.used_by"
                :key="slug"
                :to="projectLink(slug)"
                class="chip"
                style="cursor: pointer"
              >{{ slug }} ↗</router-link>
              <span v-if="img.exists === false" class="chip amber" title="Not in the engine store — rebuilt automatically when needed">not built</span>
              <StatusBadge v-if="img.last_build_status" :status="img.last_build_status" />
            </span>
          </div>
          <div class="proc-stats" v-if="img.size != null || img.last_built_at">
            <span v-if="img.size != null"><i>size</i><b>{{ bytes(img.size) }}</b></span>
            <span v-if="img.last_built_at"><i>built</i><b>{{ timeAgo(img.last_built_at) }}</b></span>
          </div>
          <div class="proc-meta">
            <span class="proc-image"><i>ref</i>{{ img.ref }}</span>
          </div>
          <div class="proc-actions">
            <button class="secondary" @click="toggle(img)">{{ opened === img.id ? 'Close' : 'Edit' }}</button>
            <button class="secondary" :disabled="building === img.id" @click="build(img)">
              {{ building === img.id ? 'Building…' : 'Build' }}
            </button>
            <button
              class="danger"
              :disabled="img.used_by.length > 0"
              :title="img.used_by.length ? `In use by: ${img.used_by.join(', ')}` : 'Remove definition and image'"
              @click="remove(img)"
            >✕</button>
          </div>
        </div>
        <div v-if="opened === img.id" style="padding: 0 14px 14px">
          <label>Containerfile</label>
          <textarea v-model="drafts[img.id]" class="code" rows="8" spellcheck="false"></textarea>
          <div class="row" style="margin-top: 10px">
            <button :disabled="saving === img.id" @click="save(img)">
              {{ saving === img.id ? 'Saving…' : 'Save' }}
            </button>
            <span class="hint" v-if="savedId === img.id">Saved ✔</span>
          </div>
          <template v-if="buildLogs[img.id]">
            <label style="margin-top: 14px">Build log</label>
            <div class="logview" style="max-height: 260px">{{ buildLogs[img.id] }}</div>
          </template>
        </div>
      </div>
    </div>

    <div class="row" style="margin-top: 14px" v-if="images">
      <input
        v-model="newName"
        class="code"
        placeholder="new-image-name"
        style="flex: 0 1 240px"
        @keyup.enter="create"
      />
      <button class="secondary" :disabled="!newName.trim()" @click="create">+ New image</button>
    </div>

    <template v-if="images?.storeListed || localImages.length">
      <div class="section-head" style="margin-top: 24px">
        <span class="section-label">local image store</span>
        <button class="secondary small" :disabled="pruning" @click="prune">
          {{ pruning ? 'Pruning…' : 'Prune dangling' }}
        </button>
      </div>
      <p class="hint" v-if="storeNote">{{ storeNote }}</p>
      <p class="hint" v-if="!localImages.length">Nothing in the store yet.</p>
      <div class="table-scroll" v-else>
        <table style="min-width: 620px">
          <thead>
            <tr><th>Image</th><th>Size</th><th>Used by</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="img in localImages" :key="img.id">
              <td class="mono" style="font-size: 12.5px">
                {{ img.tags.length ? img.tags.join(', ') : '(dangling)' }}
                <span v-if="img.managed" class="chip blue" style="margin-left: 6px">managed</span>
              </td>
              <td class="mono" style="font-size: 12.5px">{{ bytes(img.size) }}</td>
              <td class="hint" style="font-size: 13px">{{ img.used_by.join(', ') || '—' }}</td>
              <td style="text-align: right; white-space: nowrap">
                <button
                  v-if="img.tags.length && !img.managed"
                  class="secondary small"
                  :disabled="pulling === img.id"
                  title="Fetch the newest version of this tag from its registry"
                  @click="pull(img)"
                >{{ pulling === img.id ? 'Pulling…' : 'Pull' }}</button>
                <button
                  v-if="img.tags.length && !img.managed"
                  class="danger small"
                  style="margin-left: 6px"
                  :disabled="removing === img.id || img.used_by.length > 0"
                  :title="img.used_by.length
                    ? `In use by: ${img.used_by.join(', ')}`
                    : 'Remove from the local store (pulled again automatically if something needs it)'"
                  @click="removeLocal(img)"
                >✕</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="row" style="margin-top: 14px">
        <input
          v-model="newRef"
          class="code"
          list="skeppa-suggested-images"
          placeholder="docker.io/library/node:22-alpine"
          style="flex: 0 1 320px"
          spellcheck="false"
          @keyup.enter="addRegistryImage"
        />
        <datalist id="skeppa-suggested-images">
          <option v-for="ref in suggestions" :key="ref" :value="ref" />
        </datalist>
        <button class="secondary" :disabled="!newRef.trim() || adding" @click="addRegistryImage">
          {{ adding ? 'Pulling…' : '+ Add registry image' }}
        </button>
      </div>
    </template>
  </div>
</template>

<script>
import StatusBadge from './StatusBadge.vue'
import { api } from '../api.js'
import { confirmDialog } from '../lib/dialog.js'
import { store } from '../store.js'
import { managedWithStore, suggestedImages } from '../lib/images.js'
import { bytes, timeAgo } from '../lib/format.js'

const TEMPLATE = `FROM docker.io/oven/bun:1
# RUN apt-get update && apt-get install -y ...
`

export default {
  name: 'Shipyard',
  components: { StatusBadge },
  data() {
    return {
      error: '',
      opened: null,
      drafts: {},
      buildLogs: {},
      building: null,
      saving: null,
      savedId: null,
      newName: '',
      newRef: '',
      adding: false,
      pruning: false,
      pulling: null,
      removing: null,
      storeNote: '',
    }
  },
  computed: {
    // Rendered straight from the LiveState mirror — no request when opening
    // the Shipyard, and rows follow builds, edits and the projects that use
    // an image, whoever made the change. The server republishes this section
    // after every mutation below, so none of them refetch anything.
    images() {
      return store.ready ? (store.live.images ?? null) : null
    },
    // LiveState keeps the definitions and the engine's store apart; the join is
    // shared with the image picker in the project forms.
    managedImages() {
      return managedWithStore(this.images)
    },
    localImages() {
      return this.images?.local ?? []
    },
    // Common images and the Containerfile bases in use here, minus whatever is
    // already in the store — a starting point for the field below the table.
    suggestions() {
      return suggestedImages(this.images, this.localImages.flatMap(img => img.tags))
    },
    localSummary() {
      const list = this.localImages
      if (!list.length) return ''
      const total = list.reduce((n, i) => n + (i.size ?? 0), 0)
      return `${list.length} images · ~${bytes(total)}`
    },
  },
  methods: {
    bytes,
    timeAgo,
    projectLink(slug) {
      const hit = Object.values(store.live.projects ?? {}).find(p => p.info?.slug === slug)
      return hit ? `/projects/${hit.info.id}` : '/'
    },
    toggle(img) {
      if (this.opened === img.id) {
        this.opened = null
        return
      }
      this.opened = img.id
      if (!(img.id in this.drafts)) this.drafts[img.id] = img.containerfile
    },
    async save(img) {
      this.saving = img.id
      this.savedId = null
      try {
        await api.patch(`/api/images/${img.id}`, { containerfile: this.drafts[img.id] })
        this.savedId = img.id
      } catch (err) {
        this.error = `Save failed: ${err.message}`
      } finally {
        this.saving = null
      }
    },
    // The build endpoint streams plain text — read it chunk by chunk into the
    // log box so long builds show progress.
    async build(img) {
      if (this.opened !== img.id) this.toggle(img)
      this.building = img.id
      this.buildLogs[img.id] = ''
      try {
        const res = await fetch(`/api/images/${img.id}/build`, { method: 'POST', credentials: 'include' })
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => null)
          throw new Error(data?.error || `${res.status} ${res.statusText}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          this.buildLogs[img.id] += decoder.decode(value, { stream: true })
        }
      } catch (err) {
        this.buildLogs[img.id] += `\n✖ ${err.message}`
      } finally {
        this.building = null
      }
    },
    async create() {
      try {
        const created = await api.post('/api/images', { name: this.newName, containerfile: TEMPLATE })
        this.newName = ''
        this.toggle({ id: created.id, containerfile: created.containerfile })
      } catch (err) {
        const fields = err.fields ? ` — ${Object.values(err.fields).join(', ')}` : ''
        this.error = `Create failed: ${err.message}${fields}`
      }
    },
    async remove(img) {
      if (!(await confirmDialog(`Remove image "${img.name}" (definition and built image)?`, { confirmLabel: 'Remove', danger: true }))) return
      try {
        await api.del(`/api/images/${img.id}`)
      } catch (err) {
        this.error = `Remove failed: ${err.message}`
      }
    },
    // Puts a reference the store does not have yet in place, so an image can be
    // prepared before a project points at it — and so the project forms' picker
    // offers it. Same endpoint as the row's Pull button; the reference is
    // validated (and managed names rejected) server-side.
    async addRegistryImage() {
      const ref = this.newRef.trim()
      this.adding = true
      this.error = ''
      this.storeNote = ''
      try {
        await api.post('/api/images/pull', { ref })
        this.newRef = ''
        this.storeNote = `Pulled ${ref}.`
      } catch (err) {
        this.error = `Pull failed: ${err.message}`
      } finally {
        this.adding = false
      }
    },
    // "podman pull" for every tag on the row — updates the local copy to the
    // registry's newest; apps pick it up on their next restart/deploy.
    async pull(img) {
      this.pulling = img.id
      this.storeNote = ''
      try {
        for (const ref of img.tags) await api.post('/api/images/pull', { ref })
        this.storeNote = `Pulled ${img.tags.join(', ')} — restart or deploy the apps using it to pick the new version up.`
      } catch (err) {
        this.error = `Pull failed: ${err.message}`
      } finally {
        this.pulling = null
      }
    },
    // "podman rmi" — removes every tag on the row, which deletes the image.
    async removeLocal(img) {
      if (!(await confirmDialog(`Remove ${img.tags.join(', ')} from the local store?`, { confirmLabel: 'Remove', danger: true }))) return
      this.removing = img.id
      this.storeNote = ''
      try {
        for (const ref of img.tags) await api.post('/api/images/remove', { ref })
        this.storeNote = `Removed ${img.tags.join(', ')}.`
      } catch (err) {
        this.error = `Remove failed: ${err.message}`
      } finally {
        this.removing = null
      }
    },
    async prune() {
      this.pruning = true
      this.storeNote = ''
      try {
        const result = await api.post('/api/images/prune')
        this.storeNote = `Removed ${result.deleted} dangling layer(s), reclaimed ${bytes(result.reclaimed)}.`
      } catch (err) {
        this.error = `Prune failed: ${err.message}`
      } finally {
        this.pruning = false
      }
    },
  },
}
</script>
