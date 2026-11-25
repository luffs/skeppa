<template>
  <div class="yard">
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="images?.engineError" class="yard-banner">
      <b>The container engine is unreachable</b> — {{ images.engineError }}. Definitions stay editable; building,
      pulling and the store need the engine.
    </div>

    <!-- What is built here, from a Containerfile of its own -->
    <div class="section-head yard-head">
      <span class="section-label">Built here</span>
      <span class="yard-count">{{ managedImages.length }} image{{ managedImages.length === 1 ? '' : 's' }} from a Containerfile</span>
      <span class="spacer"></span>
      <button v-if="!creating" class="small" @click="startNew">+ New image</button>
    </div>
    <div v-if="creating" class="panel yard-new">
      <div class="row">
        <input
          ref="newName"
          v-model="newName"
          class="code"
          placeholder="image-name"
          aria-label="New image name"
          @keyup.enter="create"
          @keyup.esc="creating = false"
        />
        <button class="small" :disabled="!newName.trim()" @click="create">Create</button>
        <button class="small secondary" @click="creating = false">Cancel</button>
      </div>
      <p class="hint" style="margin: 6px 0 0">
        Lowercase letters, digits and dashes. It is built as <span class="mono">{{ images?.managedPrefix || 'localhost/skeppa/' }}{{ newName.trim().toLowerCase() || 'image-name' }}:latest</span>
        and starts from a Containerfile you can edit straight away.
      </p>
    </div>

    <div v-if="images && !managedImages.length && !creating" class="panel yard-empty">
      Nothing built here yet. A Containerfile of your own makes an image projects can build or run in — a base with the
      tools your builds need, say. <button type="button" class="link-button" @click="startNew">Make one</button>
    </div>

    <div v-if="managedImages.length" class="panel proc-table yard-table yard-managed">
      <table>
        <colgroup>
          <col /><col class="c-state" /><col class="c-size" /><col class="c-when" /><col class="c-users" /><col class="c-act" />
        </colgroup>
        <thead>
          <tr><th>Image</th><th>State</th><th class="num">Size</th><th>Built</th><th>Used by</th><th aria-label="Actions"></th></tr>
        </thead>
        <tbody>
          <template v-for="img in managedImages" :key="img.id">
            <tr :class="{ open: opened === img.id }">
              <td>
                <button type="button" class="yard-name" :title="opened === img.id ? 'Close the Containerfile' : 'Open the Containerfile'" @click="toggle(img)">
                  <span class="dot" :class="stateOf(img).dot" aria-hidden="true"></span>{{ img.name }}
                </button>
                <div class="yard-ref" :title="img.ref">{{ img.ref }}</div>
              </td>
              <td><span class="chip" :class="stateOf(img).color" :title="stateOf(img).title">{{ stateOf(img).text }}</span></td>
              <td class="num">{{ img.size != null ? bytes(img.size) : '—' }}</td>
              <td class="yard-dim">{{ img.last_built_at ? timeAgo(img.last_built_at) : 'never' }}</td>
              <td>
                <UsedBySummary :counts="counts([img.ref], img.used_by)" :open="usersOpen === `m${img.id}`" @toggle="toggleUsers(`m${img.id}`)" />
              </td>
              <td class="menu yard-actions">
                <div class="yard-act">
                  <button type="button" class="small secondary" :disabled="building === img.id" @click="build(img)">
                    {{ building === img.id ? 'Building…' : 'Build' }}
                  </button>
                  <ActionMenu :label="`Image ${img.name}`" :items="menuOf(img)" @select="key => onMenu(img, key)" />
                </div>
              </td>
            </tr>
            <tr v-if="usersOpen === `m${img.id}`" class="yard-sub users-row">
              <td colspan="6"><ImageUsers :image-refs="[img.ref]" :slugs="img.used_by" /></td>
            </tr>
            <!-- The Containerfile beside what its last build said -->
            <tr v-if="opened === img.id" class="yard-sub">
              <td colspan="6">
                <div class="yard-editor" :class="{ 'with-log': buildLogs[img.id] || building === img.id }">
                  <div>
                    <div class="yard-editor-head">
                      <span class="section-label">Containerfile</span>
                      <span v-if="basesOf(drafts[img.id]).length" class="yard-dim">builds on {{ basesOf(drafts[img.id]).join(', ') }}</span>
                    </div>
                    <textarea v-model="drafts[img.id]" class="code" rows="10" spellcheck="false" aria-label="Containerfile"></textarea>
                    <div class="row" style="margin-top: 10px">
                      <button class="small" :disabled="saving === img.id || !changed(img)" @click="save(img)">{{ saving === img.id ? 'Saving…' : 'Save' }}</button>
                      <button class="small secondary" :disabled="saving === img.id || building === img.id" @click="saveAndBuild(img)">
                        {{ changed(img) ? 'Save and build' : 'Build' }}
                      </button>
                      <span v-if="savedId === img.id && !changed(img)" class="hint">Saved ✔</span>
                      <span class="spacer"></span>
                      <button class="small secondary" @click="toggle(img)">Close</button>
                    </div>
                  </div>
                  <div v-if="buildLogs[img.id] || building === img.id">
                    <div class="yard-editor-head">
                      <span class="section-label">{{ building === img.id ? 'Building…' : 'Last build' }}</span>
                      <span v-if="img.last_built_at && building !== img.id" class="yard-dim">{{ timeAgo(img.last_built_at) }}</span>
                    </div>
                    <div class="logview yard-log">{{ buildLogs[img.id] }}</div>
                  </div>
                </div>
              </td>
            </tr>
            <!-- Copy to…: the same definition onto other servers of the fleet -->
            <tr v-if="copying === img.id" class="yard-sub">
              <td colspan="6">
                <div class="copy-panel">
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
                    <button class="small" :disabled="copyBusy || !copyPicked.length" @click="copyTo(img)">
                      {{ copyBusy ? 'Copying…' : `Copy to ${copyPicked.length || ''} server${copyPicked.length === 1 ? '' : 's'}`.replace('  ', ' ') }}
                    </button>
                    <button class="small secondary" @click="toggleCopy(img)">Close</button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- What came from a registry: pulled, kept, refreshed by hand -->
    <template v-if="images?.storeListed || registryImages.length">
      <div class="section-head yard-head" style="margin-top: 30px">
        <span class="section-label">From registries</span>
        <span class="yard-count">{{ storeSummary }}</span>
      </div>
      <p v-if="storeNote" class="hint">{{ storeNote }}</p>
      <div class="panel proc-table yard-table yard-registry">
        <table v-if="registryImages.length || dangling.count">
          <colgroup>
            <col /><col class="c-facts" /><col class="c-size" /><col class="c-users" /><col class="c-act" />
          </colgroup>
          <thead>
            <tr><th>Image</th><th>Version</th><th class="num">Size</th><th>Used by</th><th aria-label="Actions"></th></tr>
          </thead>
          <tbody>
            <template v-for="img in registryImages" :key="img.id">
              <tr>
                <td>
                  <div class="yard-name plain">
                    {{ refName(img.tags[0]).name }}<span class="chip yard-tag">{{ refName(img.tags[0]).tag }}</span>
                  </div>
                  <div class="yard-ref" :title="img.tags.join(', ')">{{ refName(img.tags[0]).where }}<template v-if="img.tags.length > 1"> · +{{ img.tags.length - 1 }} more tag{{ img.tags.length === 2 ? '' : 's' }}</template></div>
                </td>
                <td class="yard-dim image-facts">{{ imageFacts(img).join(' · ') || '—' }}</td>
                <td class="num">{{ bytes(img.size) }}</td>
                <td>
                  <UsedBySummary :counts="counts(img.tags, img.used_by)" :open="usersOpen === `l${img.id}`" @toggle="toggleUsers(`l${img.id}`)" />
                </td>
                <td class="menu yard-actions">
                  <div class="yard-act">
                    <button
                      type="button"
                      class="small secondary"
                      :disabled="pulling === img.id"
                      title="Fetch the newest version of this tag from its registry"
                      @click="pull(img)"
                    >{{ pulling === img.id ? 'Pulling…' : 'Pull' }}</button>
                    <ActionMenu :label="`Image ${img.tags[0]}`" :items="registryMenuOf(img)" @select="key => onRegistryMenu(img, key)" />
                  </div>
                </td>
              </tr>
              <tr v-if="usersOpen === `l${img.id}`" class="yard-sub users-row">
                <td colspan="5"><ImageUsers :image-refs="img.tags" :slugs="img.used_by" /></td>
              </tr>
            </template>
            <!-- Untagged layers left behind by rebuilds and pulls: one line, one button -->
            <tr v-if="dangling.count" class="yard-dangling">
              <td>
                <div class="yard-name plain">Dangling layers</div>
                <div class="yard-ref">untagged leftovers of rebuilds and pulls — nothing uses them</div>
              </td>
              <td class="yard-dim">{{ dangling.count }} layer{{ dangling.count === 1 ? '' : 's' }}</td>
              <td class="num">{{ bytes(dangling.size) }}</td>
              <td></td>
              <td class="menu yard-actions">
                <button type="button" class="small secondary" :disabled="pruning" @click="prune">{{ pruning ? 'Pruning…' : 'Prune' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="hint yard-none">Nothing pulled yet.</p>
        <!-- Pull a reference before a project points at it -->
        <div class="yard-add">
          <input
            v-model="newRef"
            class="code"
            list="skeppa-suggested-images"
            placeholder="docker.io/library/node:22-alpine"
            aria-label="Image to pull"
            spellcheck="false"
            @keyup.enter="addRegistryImage"
          />
          <datalist id="skeppa-suggested-images">
            <option v-for="ref in suggestions" :key="ref" :value="ref" />
          </datalist>
          <button class="small secondary" :disabled="!newRef.trim() || adding" @click="addRegistryImage">
            {{ adding ? 'Pulling…' : 'Pull an image' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import ActionMenu from './ActionMenu.vue'
import ImageUsers from './ImageUsers.vue'
import UsedBySummary from './UsedBySummary.vue'
import { shipInject, localShip, nodeShip } from '../lib/ship.js'
import { subscribeLogs } from '../live.js'
import { confirmDialog } from '../lib/dialog.js'
import { store } from '../store.js'
import { managedWithStore, suggestedImages, imageUserCounts, fromBases } from '../lib/images.js'
import { bytes, timeAgo } from '../lib/format.js'

// Builds run on the server as a store of their own, build-<image id>
// (server routes/images.js): started detached, so the answer — through the
// fleet's relay too — comes at once, then followed line by line however long
// they take, from any tab, here or on a fleet server (lib/ship.js).

// Start one on a ship; one already running (409) is just followed.
async function startBuild(ship, imageId) {
  try {
    await ship.api.post(`/api/images/${imageId}/build?detach=1`)
  } catch (err) {
    if (err.status !== 409) throw err
  }
}

// What the last build left on the row: { status: 'success'|'failed'|'', log }.
async function storedBuild(ship, imageId) {
  try {
    const row = await ship.api.get(`/api/images/${imageId}/log`)
    return { status: row?.status ?? '', log: row?.log ?? '' }
  } catch {
    return { status: '', log: '' }
  }
}

// Follow a build's store until it is over, handing `onText` what it says as
// it comes (`onRunning` once there is something, so a build that was not
// running reads as such); resolves to the stored result. `onStop` receives
// the way to stop following early.
function followBuild(ship, imageId, { onText = () => {}, onStop = () => {} } = {}) {
  return new Promise(resolve => {
    let done = false
    const stop = subscribeLogs(imageId, async evt => {
      if (evt.type === 'backlog') onText(evt.log)
      else if (evt.type === 'line') onText(`${evt.line}\n`)
      else if (evt.type === 'end' && !done) {
        done = true
        queueMicrotask(() => stop())
        resolve(await storedBuild(ship, imageId))
      }
    }, { node: ship.node, kind: 'build' })
    onStop(() => {
      done = true
      stop()
      resolve(null)
    })
  })
}

const TEMPLATE = `FROM docker.io/oven/bun:1
# RUN apt-get update && apt-get install -y ...
`

export default {
  name: 'Shipyard',
  inject: shipInject, // which server (lib/ship.js)
  components: { ActionMenu, ImageUsers, UsedBySummary },
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
      creating: false,
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
  created() {
    this.followers = {} // image id -> stop following its build (not rendered)
  },
  beforeUnmount() {
    for (const stop of Object.values(this.followers)) stop()
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
    // The store's tagged images but those of a definition here (the table
    // above has them, with their size). A managed tag whose definition is
    // gone stays listed, so it can still be seen and removed.
    registryImages() {
      const defined = new Set(this.managedImages.map(img => img.ref))
      return this.localImages.filter(img => img.tags.length && !img.tags.some(t => defined.has(t)))
        .sort((a, b) => this.refName(a.tags[0]).name.localeCompare(this.refName(b.tags[0]).name) || a.tags[0].localeCompare(b.tags[0]))
    },
    // Untagged layers, summed: one line and one Prune, not a row each.
    dangling() {
      const layers = this.localImages.filter(img => !img.tags.length)
      return { count: layers.length, size: layers.reduce((n, i) => n + (i.size ?? 0), 0) }
    },
    storeSummary() {
      const list = this.localImages
      if (!list.length) return ''
      const total = list.reduce((n, i) => n + (i.size ?? 0), 0)
      return `${list.length} in the store · ${bytes(total)} in all`
    },
  },
  methods: {
    bytes,
    timeAgo,
    // A managed image's state at a glance: what the dot, the chip and its
    // hint say.
    stateOf(img) {
      if (this.building === img.id) return { text: 'building…', color: 'blue', dot: 'blue pulse', title: 'A build is under way' }
      if (img.last_build_status === 'failed') return { text: 'build failed', color: 'red', dot: 'red', title: 'The last build failed — the image in the store, if any, is the one before' }
      if (img.exists === false || (!img.last_built_at && img.exists !== true)) {
        return { text: 'not built', color: 'amber', dot: 'amber', title: 'Not in the engine store — built automatically when something needs it, or now with Build' }
      }
      return { text: 'built', color: 'green', dot: 'green', title: 'In the store, from the last Containerfile built' }
    },
    menuOf(img) {
      const items = [{ key: 'edit', label: this.opened === img.id ? 'Close the Containerfile' : 'Edit the Containerfile' }]
      if (this.copyTargets.length) items.push({ key: 'copy', label: this.copying === img.id ? 'Close Copy to…' : 'Copy to another server…' })
      items.push({ separator: true })
      items.push({
        key: 'remove',
        label: 'Remove…',
        danger: true,
        disabled: img.used_by.length > 0,
        hint: img.used_by.length ? `In use by ${img.used_by.join(', ')}` : 'The definition and the image it built',
      })
      return items
    },
    onMenu(img, key) {
      if (key === 'edit') this.toggle(img)
      else if (key === 'copy') this.toggleCopy(img)
      else if (key === 'remove') this.remove(img)
    },
    registryMenuOf(img) {
      return [{
        key: 'remove',
        label: 'Remove from the store…',
        danger: true,
        disabled: img.used_by.length > 0 || this.removing === img.id,
        hint: img.used_by.length ? `In use by ${img.used_by.join(', ')}` : 'Pulled again automatically when something needs it',
      }]
    },
    onRegistryMenu(img, key) {
      if (key === 'remove') this.removeLocal(img)
    },
    // docker.io/library/node:22-alpine → { name: 'node', tag: '22-alpine', where: 'docker.io/library' }
    refName(ref = '') {
      const at = ref.lastIndexOf(':')
      const slash = ref.lastIndexOf('/')
      const hasTag = at > slash
      const path = hasTag ? ref.slice(0, at) : ref
      const cut = path.lastIndexOf('/')
      return { name: path.slice(cut + 1), tag: hasTag ? ref.slice(at + 1) : 'latest', where: cut > 0 ? path.slice(0, cut) : '' }
    },
    // The images a Containerfile starts FROM (its own stages and scratch aside).
    basesOf(containerfile) {
      return [...new Set(fromBases({ managed: [{ containerfile: containerfile ?? '' }] }))]
    },
    changed(img) {
      return (this.drafts[img.id] ?? img.containerfile) !== img.containerfile
    },
    async saveAndBuild(img) {
      if (this.changed(img)) {
        await this.save(img)
        if (this.savedId !== img.id) return // the save failed: say so, build nothing
      }
      await this.build(img)
    },
    startNew() {
      this.creating = true
      this.newName = ''
      this.$nextTick(() => this.$refs.newName?.focus())
    },
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
      // A build already under way (another tab, the master, a reload) shows
      // as it goes; otherwise the last one's log.
      if (this.building !== img.id) this.follow(img)
    },
    // Follow an image's build into its log box until it is over, then show
    // what the row keeps, marked with how it went. `started`: this tab just
    // started it, so it reads as building from the first moment.
    async follow(img, { started = false } = {}) {
      this.followers[img.id]?.()
      if (started) this.building = img.id
      let text = ''
      const result = await followBuild(this.ship, img.id, {
        onText: chunk => {
          this.building = img.id // there is something running
          text += chunk
          this.buildLogs[img.id] = text
        },
        onStop: stop => { this.followers[img.id] = stop },
      })
      delete this.followers[img.id]
      if (this.building === img.id) this.building = null
      if (!result) return // stopped: the card closed, or another follow took over
      const marker = result.status === 'success' ? '✔ build finished' : result.status === 'failed' ? '✖ build failed' : ''
      const body = (result.log || text).replace(/\n+$/, '')
      if (body || started) this.buildLogs[img.id] = `${body}${marker && !body.includes(marker) ? `${body ? '\n' : ''}${marker}` : ''}\n`
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
    // Started detached, then followed line by line (followBuild) — the same
    // here and on a fleet server, however long the build takes.
    async build(img) {
      this.building = img.id
      if (this.opened !== img.id) {
        this.opened = img.id
        if (!(img.id in this.drafts)) this.drafts[img.id] = img.containerfile
      }
      this.buildLogs[img.id] = ''
      try {
        await startBuild(this.ship, img.id)
      } catch (err) {
        this.buildLogs[img.id] = `✖ ${err.message}\n`
        this.building = null
        return
      }
      await this.follow(img, { started: true })
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
          await startBuild(t.ship, id)
          let lines = 0
          const result = await followBuild(t.ship, id, {
            onText: chunk => {
              lines += chunk.split('\n').filter(Boolean).length
              say(t, `${what} — building… (${lines} line${lines === 1 ? '' : 's'})`)
            },
          })
          const ok = result?.status === 'success'
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
        this.creating = false
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
.yard-banner {
  margin: 0 0 16px;
  padding: 10px 14px;
  border: 1px solid var(--banner-border);
  background: var(--banner-bg);
  border-radius: 8px;
  font-size: 13.5px;
}
.yard-head { justify-content: flex-start; }
.yard-count { font-family: var(--mono); font-size: 12px; color: var(--dim); }
.spacer { flex: 1; }
.yard-new { margin-bottom: 12px; }
.yard-new input { max-width: 280px; }
.yard-empty { padding: 16px 18px; font-size: 14px; color: var(--dim); }

/* Both tables read as the Engine room's do: name and where it comes from on
   the left, the readings in columns, what can be done at the right. */
.yard-table col.c-state { width: 120px; }
.yard-table col.c-size { width: 96px; }
.yard-table col.c-when { width: 96px; }
.yard-table col.c-facts { width: 220px; }
.yard-table col.c-users { width: 170px; }
.yard-table col.c-act { width: 128px; }
/* Narrower windows fold readings away, the Engine room's way: a column keeps
   its slot at zero width, since the rows that open under an image span them
   all. Built and Version go first; on a phone the state (the dot says it) and
   Used by too, which leaves name, size and what can be done. */
@media (max-width: 760px) {
  .yard-table col.c-when, .yard-table col.c-facts { width: 0; }
  .yard-managed tr > :nth-child(4):not([colspan]),
  .yard-registry tr > :nth-child(2):not([colspan]) { padding: 0; overflow: hidden; visibility: hidden; white-space: nowrap; }
}
@media (max-width: 600px) {
  .yard-table col.c-state, .yard-table col.c-users { width: 0; }
  .yard-table col.c-size { width: 84px; }
  .yard-table col.c-act { width: 104px; }
  .yard-managed tr > :nth-child(2):not([colspan]),
  .yard-managed tr > :nth-child(5):not([colspan]),
  .yard-registry tr > :nth-child(4):not([colspan]) { padding: 0; overflow: hidden; visibility: hidden; white-space: nowrap; }
}
.yard-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.yard-name:hover { color: var(--accent); }
.yard-name.plain { cursor: default; }
.yard-name.plain:hover { color: var(--ink); }
.yard-tag { margin-left: 8px; padding: 1px 7px; font-family: var(--mono); font-weight: 500; letter-spacing: 0; text-transform: none; }
.yard-ref {
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.yard-dim { font-size: 12.5px; color: var(--dim); }
.yard-act { display: inline-flex; align-items: center; gap: 4px; }
tr.open > td { background: var(--row-selected); }

/* What opens under a row: the project list, the editor, Copy to… */
.yard-sub > td {
  padding: 4px 18px 16px !important;
  border-top: 0;
  background: var(--row-selected);
}
.yard-editor { display: grid; gap: 16px; }
.yard-editor.with-log { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
@media (max-width: 860px) {
  .yard-editor.with-log { grid-template-columns: minmax(0, 1fr); }
}
.yard-editor-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 8px 0 6px;
}
.yard-editor textarea { min-height: 220px; font-size: 12.5px; }
.yard-log { height: 220px; max-height: none; font-size: 12px; }

.yard-dangling td { border-top: 1px dashed var(--line); }
.yard-none { padding: 14px 18px; margin: 0; }
.yard-add {
  display: flex;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--line-soft);
}
.yard-add { flex-wrap: wrap; }
.yard-add input { flex: 0 1 340px; min-width: 0; }

/* Copy to…: the servers to copy a definition onto, each with how it went. */
.copy-panel { padding-top: 6px; }
.copy-result {
  margin-left: 10px;
  font-size: 12.5px;
  color: var(--dim);
}
.copy-result.ok { color: var(--green); }
.copy-result.bad { color: var(--red); }
</style>
