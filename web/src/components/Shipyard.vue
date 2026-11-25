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
              <UsedBySummary :counts="counts([img.ref], img.used_by)" :open="usersOpen === `m${img.id}`"
                @toggle="toggleUsers(`m${img.id}`)" />
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
          <div class="proc-users" v-if="usersOpen === `m${img.id}`">
            <ImageUsers :image-refs="[img.ref]" :slugs="img.used_by" />
          </div>
          <div class="proc-actions">
            <button class="secondary" @click="toggle(img)">{{ opened === img.id ? 'Close' : 'Edit' }}</button>
            <button class="secondary" :disabled="building === img.id" @click="build(img)">
              {{ building === img.id ? 'Building…' : 'Build' }}
            </button>
            <!-- The same definition onto other servers of the fleet (copyTo). -->
            <button v-if="copyTargets.length" class="secondary" @click="toggleCopy(img)">
              {{ copying === img.id ? 'Close' : 'Copy to…' }}
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
        <div v-if="copying === img.id" class="copy-panel">
          <p class="hint" style="margin: 0 0 8px">
            Copies the saved Containerfile of <span class="mono">{{ img.name }}</span>. Where an image of that name
            exists its Containerfile is replaced; each server builds its own.
          </p>
          <label v-for="t in copyTargets" :key="t.key" class="check-label" style="margin-top: 4px">
            <input v-model="copyPicked" type="checkbox" :value="t.key" :disabled="!t.online" />
            {{ t.label }}<span v-if="!t.online" class="hint"> — offline</span>
            <span v-if="copyResults[t.key]" class="copy-result" :class="copyResults[t.key].tone">{{ copyResults[t.key].text }}</span>
          </label>
          <label class="check-label" style="margin-top: 10px">
            <input v-model="copyBuild" type="checkbox" />
            Build it there afterwards
          </label>
          <div class="row" style="margin-top: 10px">
            <button :disabled="copyBusy || !copyPicked.length" @click="copyTo(img)">
              {{ copyBusy ? 'Copying…' : `Copy to ${copyPicked.length || ''} server${copyPicked.length === 1 ? '' : 's'}`.replace('  ', ' ') }}
            </button>
          </div>
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
            <template v-for="img in localImages" :key="img.id">
            <tr>
              <td class="mono" style="font-size: 12.5px">
                {{ img.tags.length ? img.tags.join(', ') : '(dangling)' }}
                <span v-if="img.managed" class="chip blue" style="margin-left: 6px">managed</span>
                <!-- What the tag above does not say: which image this actually
                     is, and how old this copy of it is. -->
                <div class="image-facts" v-if="imageFacts(img).length">
                  <span v-for="fact in imageFacts(img)" :key="fact">{{ fact }}</span>
                </div>
              </td>
              <td class="mono" style="font-size: 12.5px">{{ bytes(img.size) }}</td>
              <td style="font-size: 13px">
                <!-- One row can be the default build image of every project on
                     the server, so the row only counts them; the list opens
                     underneath, where it has the width to say something about
                     each one. -->
                <UsedBySummary :counts="counts(img.tags, img.used_by)" :open="usersOpen === `l${img.id}`"
                  @toggle="toggleUsers(`l${img.id}`)" />
              </td>
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
            <tr v-if="usersOpen === `l${img.id}`" class="users-row">
              <td colspan="4">
                <ImageUsers :image-refs="img.tags" :slugs="img.used_by" />
              </td>
            </tr>
            </template>
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
import ImageUsers from './ImageUsers.vue'
import UsedBySummary from './UsedBySummary.vue'
import { shipInject, localShip, nodeShip } from '../lib/ship.js'
import { confirmDialog } from '../lib/dialog.js'
import { store } from '../store.js'
import { managedWithStore, suggestedImages, imageUserCounts } from '../lib/images.js'
import { bytes, timeAgo } from '../lib/format.js'

// POST …/build on a ship (lib/ship.js — this panel, or a fleet server through
// the relay), its log handed to `onText` as it streams in. Through the relay
// it arrives whole when the build is done, and a build longer than the
// relay's wait goes on over there while this says so.
async function runBuild(ship, imageId, onText) {
  const res = await fetch(ship.url(`/api/images/${imageId}/build`), { method: 'POST', credentials: 'include' })
  if (res.status === 504) throw new Error('still building over there — the status shows here when it is done')
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error || `${res.status} ${res.statusText}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    onText(decoder.decode(value, { stream: true }))
  }
}

const TEMPLATE = `FROM docker.io/oven/bun:1
# RUN apt-get update && apt-get install -y ...
`

export default {
  name: 'Shipyard',
  inject: shipInject, // which server (lib/ship.js)
  components: { StatusBadge, ImageUsers, UsedBySummary },
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
      usersOpen: null,
      pruning: false,
      pulling: null,
      removing: null,
      storeNote: '',
      copying: null, // the image whose Copy to… is open
      copyPicked: [], // target keys
      copyBuild: false,
      copyBusy: false,
      copyResults: {}, // target key -> { text, tone }
    }
  },
  computed: {
    // Rendered straight from the LiveState mirror — no request when opening
    // the Shipyard, and rows follow builds, edits and the projects that use
    // an image, whoever made the change. The server republishes this section
    // after every mutation below, so none of them refetch anything.
    images() {
      return store.ready ? (this.ship.live.images ?? null) : null
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
    // Where a definition can be copied: this panel and every server of the
    // fleet, but not the one this Shipyard is about. Admins only have a fleet.
    copyTargets() {
      if (store.user?.role !== 'admin') return []
      const targets = []
      if (this.ship.node) targets.push({ key: 'local', label: 'this panel', online: true, ship: localShip })
      for (const n of Object.values(store.live.nodes ?? {})) {
        if (n.id === this.ship.node || !n.paired) continue
        targets.push({ key: `n${n.id}`, label: n.name, online: n.online, ship: nodeShip(n.id) })
      }
      return targets.sort((a, b) => (a.key === 'local' ? -1 : b.key === 'local' ? 1 : a.label.localeCompare(b.label)))
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
    counts(refs, slugs) {
      return imageUserCounts(this.ship.live, refs, slugs)
    },
    // One list open at a time: two of them push the rows around more than
    // either is worth.
    toggleUsers(key) {
      this.usersOpen = this.usersOpen === key ? null : key
    },
    // Only what this image genuinely carries: most registry images publish no
    // version label at all, and one built here has no registry digest.
    imageFacts(img) {
      const facts = []
      if (img.version) facts.push(`v${img.version}`)
      if (img.createdAt) facts.push(`built ${timeAgo(img.createdAt)}`)
      if (img.digest) facts.push(img.digest.replace(/^sha256:/, '').slice(0, 12))
      return facts
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
        await this.ship.api.patch(`/api/images/${img.id}`, { containerfile: this.drafts[img.id] })
        this.savedId = img.id
      } catch (err) {
        this.error = `Save failed: ${err.message}`
      } finally {
        this.saving = null
      }
    },
    // The build endpoint streams plain text — read it chunk by chunk into the
    // log box so long builds show progress (on a fleet server the relay hands
    // the log over when the build is done).
    async build(img) {
      if (this.opened !== img.id) this.toggle(img)
      this.building = img.id
      this.buildLogs[img.id] = ''
      try {
        await runBuild(this.ship, img.id, text => { this.buildLogs[img.id] += text })
      } catch (err) {
        this.buildLogs[img.id] += `\n✖ ${err.message}`
      } finally {
        this.building = null
      }
    },
    toggleCopy(img) {
      this.copying = this.copying === img.id ? null : img.id
      this.copyPicked = []
      this.copyResults = {}
    },
    // The saved Containerfile onto each picked server: created where it has no
    // image of that name, replaced where it does, left alone where it already
    // says the same — then built there, if asked. One server failing does not
    // stop the others; each says how it went.
    async copyTo(img) {
      this.copyBusy = true
      const picked = this.copyTargets.filter(t => this.copyPicked.includes(t.key))
      const say = (t, text, tone = '') => { this.copyResults = { ...this.copyResults, [t.key]: { text, tone } } }
      await Promise.all(picked.map(async t => {
        say(t, 'copying…')
        try {
          const there = (t.ship.live.images?.managed ?? []).find(i => i.name === img.name)
          let id = there?.id
          let what
          if (!there) {
            id = (await t.ship.api.post('/api/images', { name: img.name, containerfile: img.containerfile })).id
            what = 'created'
          } else if (there.containerfile !== img.containerfile) {
            await t.ship.api.patch(`/api/images/${there.id}`, { containerfile: img.containerfile })
            what = 'updated'
          } else {
            what = 'already the same'
          }
          if (!this.copyBuild) return say(t, `${what} ✔${what === 'updated' ? ' — build it there to use it' : ''}`, 'ok')
          say(t, `${what} — building…`)
          let log = ''
          await runBuild(t.ship, id, text => { log += text })
          const ok = log.includes('✔ build finished')
          say(t, ok ? `${what}, built ✔` : `${what}, build failed — the log is in its Shipyard`, ok ? 'ok' : 'bad')
        } catch (err) {
          const fields = err.fields ? ` — ${Object.values(err.fields).join(', ')}` : ''
          say(t, `✖ ${err.message}${fields}`, 'bad')
        }
      }))
      this.copyBusy = false
    },
    async create() {
      try {
        const created = await this.ship.api.post('/api/images', { name: this.newName, containerfile: TEMPLATE })
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
        await this.ship.api.del(`/api/images/${img.id}`)
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
        await this.ship.api.post('/api/images/pull', { ref })
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
        for (const ref of img.tags) await this.ship.api.post('/api/images/pull', { ref })
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
        for (const ref of img.tags) await this.ship.api.post('/api/images/remove', { ref })
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
        const result = await this.ship.api.post('/api/images/prune')
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

<style scoped>
/* The open project list: a row of its own under the table row it belongs
   to, and a block under the head of an image card. Both are the same panel,
   set apart from what they hang off rather than boxed in again. */
.users-row > td {
  padding-top: 0;
  border-top: 0;
}
.proc-users {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}

/* Copy to…: the servers to copy a definition onto, each with how it went. */
.copy-panel {
  padding: 10px 14px 14px;
  border-top: 1px solid var(--line-soft);
}
.copy-result {
  margin-left: 10px;
  font-size: 12.5px;
  color: var(--dim);
}
.copy-result.ok { color: var(--green, #3fb950); }
.copy-result.bad { color: var(--red, #f85149); }

/* A dim second line inside the image cell: facts about the image itself,
   subordinate to the reference above them. */
.image-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--dim);
}
</style>
