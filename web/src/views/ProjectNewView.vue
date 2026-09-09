<template>
  <div class="container narrow">
    <h1 style="margin-bottom: 0">Moor a new project</h1>
    <p class="hint" style="font-size: 14px; margin: 6px 0 22px">
      Pick a repository, tell Skeppa how to build and start it.
    </p>
    <div class="panel">
      <p v-if="repoError" class="error">
        {{ repoError }} — check the <router-link to="/settings">GitHub App settings</router-link>.
      </p>

      <label class="check-label">
        <input type="checkbox" v-model="externalRepo" />
        External repository — a public git URL outside the GitHub App
      </label>

      <template v-if="externalRepo">
        <label>Git URL</label>
        <input v-model="form.git_url" class="code" placeholder="https://github.com/user/repo.git" />
        <p class="hint">
          Any public https host (GitHub, GitLab, Codeberg…). No webhook reaches these —
          check for updates from the project page instead.
        </p>
      </template>
      <template v-else>
        <label>Repository</label>
        <select v-model="form.repo_full_name" @change="onRepoPicked">
          <option disabled value="">{{ reposLoading ? 'Loading repos…' : 'Pick a repository' }}</option>
          <option v-for="r in repos" :key="r.full_name" :value="r.full_name">
            {{ r.full_name }}{{ r.private ? ' 🔒' : '' }}
          </option>
        </select>
      </template>

      <label>Branch</label>
      <input v-model="form.branch" class="code" placeholder="main" />

      <template v-if="!externalRepo">
        <label class="check-label">
          <input type="checkbox" v-model="form.auto_deploy" />
          Auto deploy on push
        </label>
        <p class="hint">When off, pushes only show up as "commits ahead" — deploy manually.</p>
      </template>

      <label>Name</label>
      <input v-model="form.name" placeholder="My app" @input="syncPm2Name" />

      <label>Deploy script</label>
      <textarea v-model="form.deploy_script" class="code" rows="4" placeholder="bun install && bun run build"></textarea>
      <p class="hint">
        ⚠ This runs as a shell script on the server with the project's ENV — that is the point of a
        deploy panel, so only put trusted commands here.
      </p>
      <label class="check-label">
        <input type="checkbox" v-model="form.build_env" />
        Inject ENV into the deploy script
      </label>
      <p class="hint">
        Off, the build gets only a minimal environment and no <span class="mono">.env</span> —
        the setting for repos whose dependencies you don't fully trust. The running app gets
        its ENV either way.
      </p>

      <label>Start command <span class="soft">(optional — empty for build-only)</span></label>
      <input v-model="form.start_command" class="code" placeholder="bun run start" />

      <label>Working subdirectory <span class="soft">(optional, relative to repo root)</span></label>
      <input v-model="form.cwd" class="code" placeholder="apps/api" />

      <RuntimeFields
        v-model:runtime="form.runtime"
        v-model:build-image="form.build_image"
        v-model:run-image="form.run_image"
        v-model:pm2-name="form.pm2_name"
        v-model:memory-mb="form.memory_mb"
        v-model:network-profile="form.network_profile"
        v-model:host-access="form.host_access"
        v-model:networks="form.networks"
        :tenant="isTenant"
      />

      <RoutingFields
        v-model:subdomain="form.subdomain"
        v-model:port="form.port"
        :handle="isTenant ? myHandle : ''"
        :domain="isTenant ? myDomain : ''"
      />

      <p v-if="error" class="error">{{ error }}</p>
      <p style="margin: 22px 0 0">
        <button :disabled="busy || !form.name || (externalRepo ? !form.git_url.trim() : !form.repo_full_name)" @click="submit">
          {{ busy ? 'Mooring…' : 'Moor project' }}
        </button>
      </p>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import RuntimeFields from '../components/RuntimeFields.vue'
import RoutingFields from '../components/RoutingFields.vue'

export default {
  name: 'ProjectNewView',
  components: { RuntimeFields, RoutingFields },
  data() {
    return {
      repos: [],
      reposLoading: true,
      repoError: '',
      error: '',
      busy: false,
      pm2NameTouched: false,
      externalRepo: false,
      isTenant: store.user?.role === 'tenant',
      myHandle: store.user?.handle ?? '',
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
        // Set here rather than in Rigging afterwards: these decide what the
        // very first deploy does. The .env-file toggle has a working default
        // and stays in the project settings.
        // tenants deploy in containers only; the server enforces it too
        runtime: store.user?.role === 'tenant' ? 'container' : 'pm2',
        build_image: '',
        run_image: '',
        memory_mb: '',
        network_profile: 'open',
        host_access: false,
        networks: '',
        subdomain: '',
        port: '',
      },
    }
  },
  async created() {
    try {
      this.repos = await api.get('/api/github/repos')
    } catch (err) {
      this.repoError = err.message
    } finally {
      this.reposLoading = false
    }
  },
  methods: {
    onRepoPicked() {
      const repo = this.repos.find(r => r.full_name === this.form.repo_full_name)
      if (repo) {
        this.form.branch = repo.default_branch || 'main'
        if (!this.form.name) {
          this.form.name = repo.full_name.split('/')[1]
          this.syncPm2Name()
        }
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
        const fields = err.fields ? ' — ' + Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join(', ') : ''
        this.error = err.message + fields
      } finally {
        this.busy = false
      }
    },
  },
  watch: {
    'form.pm2_name'(val) {
      // Consider the field "touched" once it diverges from the auto-generated value.
      const auto = this.form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      this.pm2NameTouched = val !== auto
    },
  },
}
</script>
