<template>
  <div class="container" style="max-width: 640px">
    <h1>Settings</h1>
    <div class="panel">
      <h2 style="margin-top: 0">GitHub App</h2>
      <p class="hint">
        Create a GitHub App (Settings → Developer settings → GitHub Apps) with
        <strong>Contents: read</strong> and <strong>Metadata: read</strong> permissions and the
        <strong>push</strong> event subscribed, install it on your account, then paste its
        credentials here. Set the webhook URL to
        <span class="mono">{{ webhookUrl }}</span>
      </p>

      <label>App ID</label>
      <input v-model="form.github_app_id" class="code" placeholder="123456" />

      <label>
        Private key (PEM)
        <span v-if="status.has_private_key" class="badge green" style="margin-left: 6px">configured</span>
      </label>
      <textarea
        v-model="form.github_private_key"
        class="code"
        rows="5"
        :placeholder="status.has_private_key ? '(unchanged — paste to replace)' : '-----BEGIN RSA PRIVATE KEY-----'"
      ></textarea>

      <label>
        Webhook secret
        <span v-if="status.has_webhook_secret" class="badge green" style="margin-left: 6px">configured</span>
      </label>
      <input
        v-model="form.github_webhook_secret"
        class="code"
        type="password"
        :placeholder="status.has_webhook_secret ? '(unchanged — enter to replace)' : 'a long random string'"
      />

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="message" class="hint">{{ message }}</p>
      <div class="row" style="margin-top: 12px">
        <button :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }}</button>
        <button class="secondary" :disabled="busy" @click="test">Test connection</button>
      </div>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'

export default {
  name: 'SettingsView',
  data() {
    return {
      status: { github_app_id: null, has_private_key: false, has_webhook_secret: false },
      form: { github_app_id: '', github_private_key: '', github_webhook_secret: '' },
      busy: false,
      error: '',
      message: '',
    }
  },
  computed: {
    webhookUrl() {
      return `${location.origin}/api/webhooks/github`
    },
  },
  async created() {
    await this.load()
  },
  methods: {
    async load() {
      this.status = await api.get('/api/settings')
      this.form.github_app_id = this.status.github_app_id ?? ''
    },
    async save() {
      this.busy = true
      this.error = ''
      this.message = ''
      try {
        const payload = { github_app_id: this.form.github_app_id }
        if (this.form.github_private_key.trim()) payload.github_private_key = this.form.github_private_key
        if (this.form.github_webhook_secret.trim()) payload.github_webhook_secret = this.form.github_webhook_secret
        await api.put('/api/settings', payload)
        this.form.github_private_key = ''
        this.form.github_webhook_secret = ''
        await this.load()
        this.message = 'Saved ✔'
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },
    async test() {
      this.busy = true
      this.error = ''
      this.message = ''
      try {
        const repos = await api.get('/api/github/repos')
        this.message = `Connection OK — the app can access ${repos.length} repositori${repos.length === 1 ? 'y' : 'es'}.`
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
