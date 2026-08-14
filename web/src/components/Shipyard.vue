<template>
  <div>
    <div class="section-head">
      <span class="section-label">managed images</span>
      <span class="mono" style="font-size: 12px; color: var(--dim)" v-if="localSummary">{{ localSummary }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="data?.engine_error" class="hint">
      Engine unreachable ({{ data.engine_error }}) — definitions are editable, builds and the local
      store need the engine.
    </p>

    <div class="proc-list" v-if="data">
      <div v-for="img in data.managed" :key="img.id" class="proc-card" :class="{ open: opened === img.id }">
        <div class="proc-head">
          <div class="proc-main">
            <div class="proc-title">
              <span class="proc-name">{{ img.name }}</span>
              <StatusBadge v-if="img.last_build_status" :status="img.last_build_status" />
              <span v-if="img.exists === false" class="chip amber" title="Not in the engine store — rebuilt automatically when needed">not built</span>
              <router-link
                v-for="slug in img.used_by"
                :key="slug"
                :to="projectLink(slug)"
                class="chip"
                style="cursor: pointer"
              >{{ slug }} ↗</router-link>
            </div>
            <div class="proc-stats">
              <span class="mono" style="font-size: 12px">{{ img.ref }}</span>
              <span v-if="img.size != null"><i>size</i>{{ bytes(img.size) }}</span>
              <span v-if="img.last_built_at"><i>built</i>{{ timeAgo(img.last_built_at) }}</span>
            </div>
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

    <div class="row" style="margin-top: 14px" v-if="data">
      <input
        v-model="newName"
        class="code"
        placeholder="new-image-name"
        style="flex: 0 1 240px"
        @keyup.enter="create"
      />
      <button class="secondary" :disabled="!newName.trim()" @click="create">+ New image</button>
    </div>

    <template v-if="data && localImages.length">
      <div class="section-head" style="margin-top: 24px">
        <span class="section-label">local image store</span>
        <button class="secondary small" :disabled="pruning" @click="prune">
          {{ pruning ? 'Pruning…' : 'Prune dangling' }}
        </button>
      </div>
      <p class="hint" v-if="storeNote">{{ storeNote }}</p>
      <div class="table-scroll">
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
              <td style="text-align: right">
                <button
                  v-if="img.tags.length && !img.managed"
                  class="secondary small"
                  :disabled="pulling === img.id"
                  title="Fetch the newest version of this tag from its registry"
                  @click="pull(img)"
                >{{ pulling === img.id ? 'Pulling…' : 'Pull' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script>
import StatusBadge from './StatusBadge.vue'
import { api } from '../api.js'
import { store } from '../store.js'
import { bytes, timeAgo } from '../lib/format.js'

const TEMPLATE = `FROM docker.io/oven/bun:1
# RUN apt-get update && apt-get install -y ...
`

export default {
  name: 'Shipyard',
  components: { StatusBadge },
  data() {
    return {
      data: null,
      error: '',
      opened: null,
      drafts: {},
      buildLogs: {},
      building: null,
      saving: null,
      savedId: null,
      newName: '',
      pruning: false,
      pulling: null,
      storeNote: '',
    }
  },
  computed: {
    localImages() {
      return this.data?.local ?? []
    },
    localSummary() {
      const list = this.localImages
      if (!list.length) return ''
      const total = list.reduce((n, i) => n + (i.size ?? 0), 0)
      return `${list.length} images · ~${bytes(total)}`
    },
  },
  created() {
    this.load()
  },
  methods: {
    bytes,
    timeAgo,
    projectLink(slug) {
      const hit = Object.values(store.live.projects ?? {}).find(p => p.info?.slug === slug)
      return hit ? `/projects/${hit.info.id}` : '/'
    },
    async load() {
      try {
        this.data = await api.get('/api/images')
        this.error = ''
      } catch (err) {
        this.error = `Could not load images: ${err.message}`
      }
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
        await this.load()
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
        await this.load()
      }
    },
    async create() {
      try {
        const created = await api.post('/api/images', { name: this.newName, containerfile: TEMPLATE })
        this.newName = ''
        await this.load()
        this.toggle({ id: created.id, containerfile: created.containerfile })
      } catch (err) {
        const fields = err.fields ? ` — ${Object.values(err.fields).join(', ')}` : ''
        this.error = `Create failed: ${err.message}${fields}`
      }
    },
    async remove(img) {
      if (!confirm(`Remove image "${img.name}" (definition and built image)?`)) return
      try {
        await api.del(`/api/images/${img.id}`)
        await this.load()
      } catch (err) {
        this.error = `Remove failed: ${err.message}`
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
        await this.load()
      } catch (err) {
        this.error = `Pull failed: ${err.message}`
      } finally {
        this.pulling = null
      }
    },
    async prune() {
      this.pruning = true
      this.storeNote = ''
      try {
        const result = await api.post('/api/images/prune')
        this.storeNote = `Removed ${result.deleted} dangling layer(s), reclaimed ${bytes(result.reclaimed)}.`
        await this.load()
      } catch (err) {
        this.error = `Prune failed: ${err.message}`
      } finally {
        this.pruning = false
      }
    },
  },
}
</script>
