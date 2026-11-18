<template>
  <div class="repo-picker-wrap">
    <!-- Picked: the choice itself, plainly — the search and the list are done
         with until Change brings them back. -->
    <div v-if="!choosing && modelValue" class="repo-picked">
      <div class="repo-picked-main">
        <div class="repo-l1">
          <span class="repo-name">{{ selected?.name ?? modelValue }}</span>
          <span class="repo-owner">{{ selected?.owner ?? '' }}</span>
          <span v-if="selected?.private" class="repo-flag" title="Private repository">🔒</span>
          <span v-if="selected?.fork" class="chip">fork</span>
          <span v-if="selected?.archived" class="chip">archived</span>
          <span v-if="moored[modelValue]" class="chip blue" :title="mooredTitle(modelValue)">{{ mooredLabel(modelValue) }}</span>
        </div>
        <div v-if="selected" class="repo-l2">{{ detail(selected) }}</div>
      </div>
      <button ref="change" type="button" class="small secondary" @click="change">Change</button>
    </div>

    <template v-else>
      <div class="repo-picker">
        <div class="repo-picker-bar">
          <input
            ref="search"
            v-model="query"
            type="search"
            class="repo-search"
            placeholder="Search repositories"
            aria-label="Search repositories"
            :aria-controls="listId"
            :aria-activedescendant="highlightedId || null"
            autocomplete="off"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="pickHighlighted"
            @keydown.esc="cancelChange"
          />
          <div class="repo-sort" role="group" aria-label="Sort repositories by">
            <button
              v-for="s in sorts"
              :key="s.key"
              type="button"
              class="small"
              :class="sort === s.key ? '' : 'secondary'"
              :aria-pressed="sort === s.key ? 'true' : 'false'"
              @click="setSort(s.key)"
            >{{ s.label }}</button>
          </div>
        </div>

        <div :id="listId" ref="list" class="repo-list" role="listbox" aria-label="Repositories">
          <p v-if="loading" class="hint repo-empty">Loading repositories…</p>
          <template v-for="g in groups" :key="g.owner ?? '-'">
            <div v-if="g.owner" class="repo-group" role="presentation">
              {{ g.owner }} <span class="repo-group-count">{{ g.repos.length }}</span>
            </div>
            <div
              v-for="r in g.repos"
              :id="optionId(r)"
              :key="r.full_name"
              role="option"
              class="repo-option"
              :class="{ selected: r.full_name === modelValue, highlighted: r.full_name === highlightedName, archived: r.archived }"
              :aria-selected="r.full_name === modelValue ? 'true' : 'false'"
              @click="pick(r)"
              @mousemove="highlightedName = r.full_name"
            >
              <div class="repo-l1">
                <span class="repo-name"><template v-for="(seg, i) in marks(r.name)" :key="i"><mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></span>
                <span v-if="r.private" class="repo-flag" title="Private repository">🔒</span>
                <span v-if="r.fork" class="chip">fork</span>
                <span v-if="r.archived" class="chip">archived</span>
                <span v-if="moored[r.full_name]" class="chip blue" :title="mooredTitle(r.full_name)">{{ mooredLabel(r.full_name) }}</span>
                <span v-if="r.full_name === modelValue" class="repo-check" aria-hidden="true">✓</span>
              </div>
              <div class="repo-l2">{{ detail(r) }}</div>
            </div>
          </template>
          <p v-if="!loading && !shown.length" class="hint repo-empty">
            <template v-if="query">No repository matches “{{ query }}”.</template>
            <template v-else>No repositories yet.</template>
          </p>
          <!-- What is left out of the list is a question about the list: asked at its end. -->
          <div v-if="archivedCount" class="repo-archived">
            <button type="button" class="link-button" @click="showArchived = !showArchived">
              {{ showArchived ? 'Hide archived' : `Show ${archivedCount} archived` }}
            </button>
          </div>
        </div>
      </div>
      <!-- Under the frame: about the list, not part of it. The list is cached
           on the server; Refresh asks GitHub itself. -->
      <div v-if="!loading" class="repo-meta">
        <span>{{ countLine }}</span>
        <span class="spacer"></span>
        <button v-if="modelValue" type="button" class="link-button" @click="cancelChange">Keep {{ selected?.name ?? modelValue }}</button>
        <button
          type="button"
          class="link-button"
          :disabled="refreshing"
          title="The list is kept for a while — ask GitHub for it again"
          @click="$emit('refresh')"
        ><StableLabel :text="refreshing ? 'Refreshing…' : '↻ Refresh'" :variants="['Refreshing…', '↻ Refresh']" /></button>
      </div>
    </template>
  </div>
</template>

<script>
import StableLabel from './StableLabel.vue'
import { store } from '../store.js'
import { timeAgo } from '../lib/format.js'
import { REPO_SORTS, searchWords, matchesRepo, sortRepos, groupRepos, highlight } from '../lib/repos.js'

const SORT_KEY = 'skeppa.repoSort'
const loadSort = () => {
  try {
    const s = localStorage.getItem(SORT_KEY)
    return REPO_SORTS.some(x => x.key === s) ? s : 'name'
  } catch {
    return 'name'
  }
}

let uid = 0

// Picking the repository to moor: a search box and a list in the page, not
// a dropdown — on the mooring form this is the first and biggest choice.
// Sorted by name, last push or creation (remembered per browser), grouped by
// account when there is more than one, each row with what tells repos apart
// (language, last push, description) and whether a project already uses it.
// v-model is the full name; `picked` hands the whole repo over, `refresh`
// asks the parent for the list again, past the server's cache. Once picked,
// the choice shows as one card and the list folds away until Change.
export default {
  name: 'RepoPicker',
  components: { StableLabel },
  props: {
    repos: { type: Array, default: () => [] },
    modelValue: { type: String, default: '' },
    loading: { type: Boolean, default: false },
    // A Refresh is under way (the list stays as it is meanwhile).
    refreshing: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'picked', 'refresh'],
  data() {
    uid += 1
    return {
      listId: `repo-list-${uid}`,
      query: '',
      sort: loadSort(),
      showArchived: false,
      highlightedName: '',
      sorts: REPO_SORTS,
      // The list is open while nothing is picked, or after Change.
      choosing: !this.modelValue,
    }
  },
  computed: {
    words() {
      return searchWords(this.query)
    },
    owners() {
      return new Set(this.repos.map(r => r.owner))
    },
    archivedCount() {
      return this.repos.filter(r => r.archived).length
    },
    // What the list shows: matching, archived ones only on request (the
    // picked one always), in the chosen order.
    shown() {
      const list = this.repos.filter(r =>
        (this.showArchived || !r.archived || r.full_name === this.modelValue) && matchesRepo(r, this.words))
      return sortRepos(list, this.sort)
    },
    groups() {
      return groupRepos(this.shown)
    },
    // The rows in the order they appear, for the arrow keys.
    flat() {
      return this.groups.flatMap(g => g.repos)
    },
    highlightedId() {
      const r = this.flat.find(x => x.full_name === this.highlightedName)
      return r ? this.optionId(r) : ''
    },
    selected() {
      return this.repos.find(r => r.full_name === this.modelValue) ?? null
    },
    // full name → the projects that already moor it.
    moored() {
      const out = {}
      for (const p of Object.values(store.live.projects ?? {})) {
        const info = p.info
        if (!info?.repo_full_name || info.git_url) continue
        ;(out[info.repo_full_name] ??= []).push(info.name)
      }
      return out
    },
    countLine() {
      const n = this.repos.length
      const accounts = this.owners.size
      if (!n) return ''
      return `${n} repo${n === 1 ? '' : 's'}${accounts > 1 ? ` across ${accounts} accounts` : ''}`
    },
  },
  watch: {
    // A new search starts at the top match.
    query() {
      this.highlightedName = this.flat[0]?.full_name ?? ''
    },
  },
  mounted() {
    if (this.choosing) this.$refs.search?.focus({ preventScroll: true })
  },
  methods: {
    optionId(r) {
      return `${this.listId}-${r.full_name.replace(/[^A-Za-z0-9_-]/g, '_')}`
    },
    marks(text) {
      return highlight(text, this.words)
    },
    detail(r) {
      const when = this.sort === 'created'
        ? (r.created_at ? `created ${timeAgo(r.created_at)}` : '')
        : (r.pushed_at ? `pushed ${timeAgo(r.pushed_at)}` : 'never pushed')
      return [r.language, when, r.description].filter(Boolean).join(' · ')
    },
    setSort(key) {
      this.sort = key
      try {
        localStorage.setItem(SORT_KEY, key)
      } catch {
        // not remembered — fine
      }
    },
    pick(r) {
      this.highlightedName = r.full_name
      this.$emit('update:modelValue', r.full_name)
      this.$emit('picked', r)
      this.choosing = false
      this.query = ''
      this.$nextTick(() => this.$refs.change?.focus({ preventScroll: true }))
    },
    // Back to the list, at the picked one, to pick another.
    change() {
      this.choosing = true
      this.highlightedName = this.modelValue
      this.$nextTick(() => {
        this.$refs.search?.focus({ preventScroll: true })
        this.$refs.list?.querySelector('.repo-option.selected')?.scrollIntoView?.({ block: 'nearest' })
      })
    },
    // Changed one's mind: keep the repo already picked (Escape, or the link).
    cancelChange() {
      if (!this.modelValue) return
      this.choosing = false
      this.query = ''
      this.$nextTick(() => this.$refs.change?.focus({ preventScroll: true }))
    },
    mooredLabel(fullName) {
      const names = this.moored[fullName] ?? []
      return `moored as ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`
    },
    mooredTitle(fullName) {
      return `Already moored: ${(this.moored[fullName] ?? []).join(', ')} — another project can use it too, on another branch say`
    },
    move(step) {
      const list = this.flat
      if (!list.length) return
      const here = list.findIndex(r => r.full_name === this.highlightedName)
      const next = here === -1 ? (step > 0 ? 0 : list.length - 1) : (here + step + list.length) % list.length
      this.highlightedName = list[next].full_name
      this.$nextTick(() => {
        this.$refs.list?.querySelector('.repo-option.highlighted')?.scrollIntoView?.({ block: 'nearest' })
      })
    },
    pickHighlighted() {
      const r = this.flat.find(x => x.full_name === this.highlightedName) ?? (this.flat.length === 1 ? this.flat[0] : null)
      if (r) this.pick(r)
    },
  },
}
</script>
