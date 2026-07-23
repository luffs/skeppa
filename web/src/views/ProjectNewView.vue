<template>
  <div class="container" style="max-width: 640px">
    <h1>New project</h1>
    <div class="panel">
      <p v-if="repoError" class="error">
        {{ repoError }} — check the <router-link to="/settings">GitHub App settings</router-link>.
      </p>

      <label>Repository</label>
      <select v-model="form.repo_full_name" @change="onRepoPicked">
        <option disabled value="">{{ reposLoading ? 'Loading repos…' : 'Pick a repository' }}</option>
        <option v-for="r in repos" :key="r.full_name" :value="r.full_name">
          {{ r.full_name }}{{ r.private ? ' 🔒' : '' }}
        </option>
      </select>

      <label>Branch</label>
      <input v-model="form.branch" class="code" placeholder="main" />

      <label class="check-label" style="margin-top: 12px">
        <input type="checkbox" v-model="form.auto_deploy" />
        Auto deploy on push
      </label>
      <p class="hint">When off, pushes only show up as "undeployed commits" — deploy manually.</p>

      <label>Name</label>
      <input v-model="form.name" placeholder="My app" @input="syncPm2Name" />

      <label>pm2 process name</label>
      <input v-model="form.pm2_name" class="code" />

      <label>Deploy script</label>
      <textarea v-model="form.deploy_script" class="code" rows="4" placeholder="bun install && bun run build"></textarea>
      <p class="hint">
        ⚠ This runs as a shell script on the server with the project's ENV — that is the point of a
        deploy panel, so only put trusted commands here.
      </p>

      <label>Start command (optional — leave empty for build-only projects)</label>
      <input v-model="form.start_command" class="code" placeholder="bun run start" />

      <label>Working subdirectory (optional, relative to repo root)</label>
      <input v-model="form.cwd" class="code" placeholder="apps/api" />

      <p v-if="error" class="error">{{ error }}</p>
      <p style="margin-bottom: 0">
        <button :disabled="busy || !form.repo_full_name || !form.name" @click="submit">
          {{ busy ? 'Creating…' : 'Create project' }}
        </button>
      </p>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'

export default {
  name: 'ProjectNewView',
  data() {
    return {
      repos: [],
      reposLoading: true,
      repoError: '',
      error: '',
      busy: false,
      pm2NameTouched: false,
      form: {
        repo_full_name: '',
        branch: 'main',
        name: '',
        pm2_name: '',
        deploy_script: '',
        start_command: '',
        cwd: '',
        auto_deploy: true,
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
        const created = await api.post('/api/projects', { ...this.form, cwd: this.form.cwd || null })
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
