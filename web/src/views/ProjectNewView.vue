<template>
  <div class="container narrow">
    <h1 style="margin-bottom: 0">Moor a new project</h1>
    <p class="hint" style="font-size: 14px; margin: 6px 0 22px">
      Pick a repository, tell Skeppa how to build and start it.
    </p>
    <!-- The same sections, in the same order, as the project's Rigging tab (ProjectFields). -->
    <ProjectFields
      ref="fields"
      :form="form"
      :external="externalRepo"
      :tenant="isTenant"
      :owner-id="myId"
      :handle="isTenant ? myHandle : ''"
      :domain="isTenant ? myDomain : ''"
      :route-label="form.subdomain"
      :errors="fieldErrors"
      :suggested="suggested"
      :suggestion="suggestion"
      @set="(key, value) => (form[key] = value)"
      @runtime="runtimeTouched = true"
      @name-input="syncPm2Name"
    >
      <template #source>
        <p v-if="repoError" class="error">
          {{ repoError }} — check the <router-link to="/settings">GitHub App settings</router-link>.
        </p>
        <label class="check-label" style="margin-top: 0">
          <input type="checkbox" v-model="externalRepo" />
          External repository — a public git URL outside the GitHub App
        </label>
        <template v-if="externalRepo">
          <label>Git URL</label>
          <input v-model="form.git_url" class="code" placeholder="https://github.com/user/repo.git" />
          <FieldError :errors="fieldErrors" name="git_url" />
          <p class="hint">
            Any public https host (GitHub, GitLab, Codeberg…). No webhook reaches these —
            check for updates from the project page instead.
          </p>
        </template>
        <template v-else>
          <label>Repository</label>
          <RepoPicker
            v-model="form.repo_full_name"
            :repos="repos"
            :loading="reposLoading"
            :refreshing="reposRefreshing"
            @picked="onRepoPicked"
            @refresh="loadRepos({ fresh: true })"
          />
          <FieldError :errors="fieldErrors" name="repo_full_name" />
        </template>
      </template>
    </ProjectFields>

    <!-- Mooring is the one thing this page is for: the button stays in reach. -->
    <div class="save-bar moor-bar">
      <span v-if="error" class="error" style="margin: 0">{{ error }}</span>
      <span v-else class="hint" style="margin: 0">{{ missing || 'Ready — nothing is deployed until you set sail.' }}</span>
      <span class="spacer"></span>
      <button :disabled="busy || Boolean(missing)" @click="submit">
        <StableLabel :text="busy ? 'Mooring…' : 'Moor project'" :variants="['Mooring…', 'Moor project']" />
      </button>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import ProjectFields from '../components/ProjectFields.vue'
import FieldError from '../components/FieldError.vue'
import RepoPicker from '../components/RepoPicker.vue'
import StableLabel from '../components/StableLabel.vue'

const GENERIC_SUGGESTED = { deploy: 'bun install && bun run build', start: 'bun run start' }

export default {
  name: 'ProjectNewView',
  components: { ProjectFields, FieldError, RepoPicker, StableLabel },
  data() {
    return {
      repos: [],
      reposLoading: true,
      reposRefreshing: false,
      repoError: '',
      error: '',
      fieldErrors: {}, // the server's `fields` map, shown under each field
      busy: false,
      pm2NameTouched: false,
      runtimeTouched: false,
      externalRepo: false,
      isTenant: store.user?.role === 'tenant',
      myId: store.user?.id ?? null, // a new project is the mooring user's, and so is its pier
      myHandle: store.user?.handle ?? '',
      // Shown as placeholders and offered as one-click values — one source, so
      // the hint and what the button fills in can never drift apart. Replaced
      // by what the picked repository's package.json says (loadSuggestion).
      suggested: { ...GENERIC_SUGGESTED },
      suggestion: null, // { notes, runtime?, publish_dir? } read from the repository
      myDomain: store.user?.domain ?? '',
      form: {
        repo_full_name: '',
        git_url: '',
        branch: 'main',
        name: '',
        pm2_name: '',
        deploy_script: '',
        // tenants' dependencies are the untrusted ones — their builds start blind
        build_env: store.user?.role !== 'tenant',
        start_command: '',
        cwd: '',
        auto_deploy: true,
        write_env_file: false,
        // Set here rather than in Rigging afterwards: these decide what the
        // very first deploy does. The .env-file toggle has a working default
        // and stays in the project settings.
        // A container, unless this panel has no engine at all (noEngine).
        runtime: 'container',
        build_image: '',
        run_image: '',
        memory_mb: '',
        network_profile: 'open',
        host_access: false,
        networks: '',
        publish_dir: 'dist',
        spa_fallback: false,
        gate_files: false,
        group_id: '',
        subdomain: '',
        port: '',
      },
    }
  },
  async created() {
    await this.loadRepos()
  },
  computed: {
    // Why Moor is not ready yet, or '' when it is.
    missing() {
      const repo = this.externalRepo ? this.form.git_url.trim() : this.form.repo_full_name
      if (!repo && !this.form.name.trim()) return this.externalRepo ? 'Give it a git URL and a name.' : 'Pick a repository and give it a name.'
      if (!repo) return this.externalRepo ? 'Give it a git URL.' : 'Pick a repository.'
      if (!this.form.name.trim()) return 'Give it a name.'
      return ''
    },
    // An admin's panel started without a container socket: a container
    // default would only fail the first deploy, so pm2 is the default there.
    noEngine() {
      const system = store.live?.system
      return !this.isTenant && Boolean(system?.appsDir) && !system.containerSocket
    },
  },
  methods: {
    // The server answers from its cache (fast after the first time); `fresh`
    // is the picker's Refresh, straight to GitHub, keeping the list meanwhile.
    async loadRepos({ fresh = false } = {}) {
      if (fresh) this.reposRefreshing = true
      this.repoError = ''
      try {
        this.repos = await api.get(fresh ? '/api/github/repos?fresh=1' : '/api/github/repos')
      } catch (err) {
        this.repoError = err.message
      } finally {
        this.reposLoading = false
        this.reposRefreshing = false
      }
    },
    pickRuntime(runtime) {
      this.form.runtime = runtime
      this.runtimeTouched = true
    },
    onRepoPicked() {
      const repo = this.repos.find(r => r.full_name === this.form.repo_full_name)
      if (repo) {
        this.form.branch = repo.default_branch || 'main'
        if (!this.form.name) {
          this.form.name = repo.full_name.split('/')[1]
          this.syncPm2Name()
        }
        this.loadSuggestion(repo.full_name, this.form.branch)
      }
    },
    // What the repository's package.json suggests for its commands — read
    // by the server, offered as one-click values, never filled in by itself.
    // A late answer for a repository or branch no longer picked is dropped,
    // and the one already read is not read again.
    async loadSuggestion(repo, branch) {
      const key = `${repo}@${branch}`
      if (key === this.suggestionFor) return
      this.suggestionFor = key
      this.suggestion = null
      this.suggested = { ...GENERIC_SUGGESTED }
      try {
        const q = new URLSearchParams({ repo, branch })
        const found = await api.get(`/api/github/repos/suggest?${q}`)
        if (this.suggestionFor !== key || !found) return
        this.suggestion = found
        if (found.found) this.suggested = { deploy: found.deploy, start: found.start }
      } catch {
        // nothing read: the generic suggestions stay
      }
    },
    syncPm2Name() {
      if (!this.pm2NameTouched) {
        this.form.pm2_name = this.form.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      }
    },
    async submit() {
      this.busy = true
      this.error = ''
      this.fieldErrors = {}
      try {
        const created = await api.post('/api/projects', {
          ...this.form,
          cwd: this.form.cwd || null,
          build_image: this.form.build_image || null,
          run_image: this.form.run_image || null,
          memory_mb: String(this.form.memory_mb ?? '').trim() || null,
          repo_full_name: this.externalRepo ? null : this.form.repo_full_name,
          git_url: this.externalRepo ? this.form.git_url.trim() : null,
          subdomain: this.form.subdomain || null,
          port: String(this.form.port ?? '').trim() || null,
        })
        this.$router.push(`/projects/${created.id}`)
      } catch (err) {
        this.fieldErrors = err.fields ?? {}
        this.error = err.fields ? 'Some fields need a look — they are marked above.' : err.message
        if (err.fields) this.$refs.fields?.revealErrors()
      } finally {
        this.busy = false
      }
    },
  },
  watch: {
    // The system facts may arrive after the form opened; follow them until
    // someone has picked a runtime themselves.
    noEngine: {
      immediate: true,
      handler(none) {
        if (!this.runtimeTouched) this.form.runtime = none ? 'pm2' : 'container'
      },
    },
    // Another branch may build differently: read its package.json too.
    'form.branch'(branch) {
      const repo = this.form.repo_full_name
      if (!this.externalRepo && branch && this.repos.some(r => r.full_name === repo)) this.loadSuggestion(repo, branch)
    },
    'form.pm2_name'(val) {
      // Consider the field "touched" once it diverges from the auto-generated value.
      const auto = this.form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      this.pm2NameTouched = val !== auto
    },
  },
}
</script>
