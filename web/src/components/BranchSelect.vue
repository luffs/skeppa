<template>
  <div class="branch-select">
    <label :for="id">Branch</label>
    <!-- the repository's branches, once they are read -->
    <div v-if="useList" class="row">
      <select :id="id" :value="modelValue" class="code" @change="$emit('update:modelValue', $event.target.value)">
        <option v-if="!known" :value="modelValue">{{ modelValue || '—' }} — not on GitHub</option>
        <option v-for="b in list.branches" :key="b" :value="b">{{ b }}{{ b === list.default_branch ? ' (default)' : '' }}</option>
      </select>
      <button type="button" class="small secondary" title="Type a branch name instead" @click="typing = true">Type a name</button>
    </div>
    <!-- before they are, when they cannot be, or when a name is typed -->
    <div v-else class="row">
      <input :id="id" :value="modelValue" class="code" placeholder="main" @input="$emit('update:modelValue', $event.target.value)" />
      <button v-if="list && typing" type="button" class="small secondary" @click="typing = false">Pick from the list</button>
    </div>
    <p v-if="loading" class="hint">Reading the branches…</p>
    <p v-else-if="error" class="hint">Couldn't read the branches ({{ error }}) — type the name.</p>
    <p v-else-if="list && list.more && useList" class="hint">Only the first {{ list.branches.length }} are listed — type another if it is not among them.</p>
  </div>
</template>

<script>
import { api } from '../api.js'

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const WAIT_MS = 300 // a repository typed by hand: asked about once the typing stops
// Read once per repository and visit: { <repo>: { default_branch, branches, more } }
const lists = new Map()
let ids = 0

// The branch a project deploys, picked from its GitHub repository's
// branches (GET /api/github/repos/branches) — or typed: before they are
// read, when they cannot be, for a repository that is no GitHub one
// (`repo` empty), or for a branch that is not there yet. A branch the list
// does not hold stays offered, marked, so opening Rigging never changes it.
// v-model is the branch name; an empty one becomes the default branch.
export default {
  name: 'BranchSelect',
  props: {
    modelValue: { type: String, default: '' },
    // owner/repo, '' for none
    repo: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  data() {
    return { id: `branch-${++ids}`, list: null, loading: false, error: '', typing: false }
  },
  computed: {
    useList() {
      return Boolean(this.list?.branches.length) && !this.typing
    },
    known() {
      return this.list?.branches.includes(this.modelValue) ?? false
    },
  },
  watch: {
    repo: { handler: 'queue', immediate: true },
  },
  unmounted() {
    clearTimeout(this.timer)
  },
  methods: {
    queue(repo, before) {
      clearTimeout(this.timer)
      this.list = null
      this.error = ''
      this.loading = false
      this.typing = false
      if (!REPO_RE.test(repo ?? '')) return
      if (lists.has(repo)) return this.use(lists.get(repo))
      // a repository picked (or opened) is asked about at once; one being typed when the typing stops
      if (!before) this.load(repo)
      else this.timer = setTimeout(() => this.load(repo), WAIT_MS)
    },
    async load(repo) {
      this.loading = true
      try {
        const q = new URLSearchParams({ repo })
        const got = await api.get(`/api/github/repos/branches?${q}`)
        const found = {
          default_branch: typeof got?.default_branch === 'string' ? got.default_branch : '',
          branches: Array.isArray(got?.branches) ? got.branches.filter(b => typeof b === 'string') : [],
          more: Boolean(got?.more),
        }
        lists.set(repo, found)
        if (repo === this.repo) this.use(found)
      } catch (err) {
        if (repo === this.repo) this.error = err.message
      } finally {
        if (repo === this.repo) this.loading = false
      }
    },
    use(found) {
      this.list = found
      if (!this.modelValue && found.default_branch) this.$emit('update:modelValue', found.default_branch)
    },
  },
}
</script>
