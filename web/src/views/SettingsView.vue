<template>
  <div class="container narrow">
    <h1 style="margin-bottom: 22px">Rigging</h1>

    <CollapseSection title="Crew">
      <template #meta>
        <span class="chip">{{ users.length }} aboard</span>
      </template>

      <p class="hint" style="font-size: 13.5px">
        Every crew member has full access to the panel. Changing a password signs that user out
        everywhere else; removing a member ends their sessions immediately.
      </p>

      <div class="crew-rows">
        <div v-for="u in users" :key="u.id" class="crew-member">
          <div class="crew-row">
            <span class="crew-name">{{ u.username }}</span>
            <span v-if="isSelf(u)" class="chip blue">you</span>
            <span class="crew-since">aboard since {{ shortDate(u.created_at) }}</span>
            <span class="spacer"></span>
            <button class="secondary small" :disabled="crewBusy" @click="togglePassword(u)">
              {{ passwordFor === u.id ? 'Cancel' : 'Password' }}
            </button>
            <button v-if="!isSelf(u)" class="danger small" :disabled="crewBusy" @click="removeUser(u)">Remove</button>
          </div>
          <div v-if="passwordFor === u.id" class="row crew-pass">
            <input
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              placeholder="new password (min 8 characters)"
              style="flex: 1 1 200px; width: auto"
              @keyup.enter="savePassword(u)"
            />
            <button class="small" :disabled="crewBusy" @click="savePassword(u)">Set password</button>
          </div>
        </div>
      </div>

      <form @submit.prevent="addUser">
        <label style="margin-top: 20px">Add crew member</label>
        <div class="row">
          <input
            v-model="newUser.username"
            placeholder="username"
            autocomplete="off"
            style="flex: 1 1 140px; width: auto"
          />
          <input
            v-model="newUser.password"
            type="password"
            autocomplete="new-password"
            placeholder="password (min 8 characters)"
            style="flex: 1 1 200px; width: auto"
          />
          <button :disabled="crewBusy">{{ crewBusy ? 'Working…' : 'Add' }}</button>
        </div>
      </form>

      <p v-if="crewError" class="error">{{ crewError }}</p>
      <p v-if="crewMessage" class="hint">{{ crewMessage }}</p>
    </CollapseSection>

    <CollapseSection title="GitHub App">
      <template #meta>
        <span v-if="status.has_private_key && status.has_webhook_secret" class="chip green">configured</span>
      </template>

      <p class="hint" style="font-size: 13.5px">
        Create a GitHub App (Settings → Developer settings → GitHub Apps) with
        <strong>Contents: read</strong> and <strong>Metadata: read</strong> permissions and the
        <strong>push</strong> event subscribed, install it on your account, then paste its
        credentials here. Set the webhook URL to
        <span class="mono" style="font-size: 12.5px">{{ webhookUrl }}</span>
      </p>

      <label>App ID</label>
      <input v-model="form.github_app_id" class="code" placeholder="123456" />

      <label style="display: flex; align-items: center; gap: 8px">
        Private key (PEM)
        <span v-if="status.has_private_key" class="chip green" style="font-size: 10px; padding: 2px 9px">configured</span>
      </label>
      <textarea
          v-model="form.github_private_key"
          class="code"
          rows="5"
          :placeholder="status.has_private_key ? '(unchanged — paste to replace)' : '-----BEGIN RSA PRIVATE KEY-----'"
      ></textarea>

      <label style="display: flex; align-items: center; gap: 8px">
        Webhook secret
        <span v-if="status.has_webhook_secret" class="chip green" style="font-size: 10px; padding: 2px 9px">configured</span>
      </label>
      <input
          v-model="form.github_webhook_secret"
          class="code"
          type="password"
          :placeholder="status.has_webhook_secret ? '(unchanged — enter to replace)' : 'a long random string'"
      />

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="message" class="hint">{{ message }}</p>
      <div class="row" style="margin-top: 20px">
        <button :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }}</button>
        <button class="secondary" :disabled="busy" @click="test">Test connection</button>
      </div>
    </CollapseSection>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import CollapseSection from '../components/CollapseSection.vue'

export default {
  name: 'SettingsView',
  components: { CollapseSection },
  data() {
    return {
      status: { github_app_id: null, has_private_key: false, has_webhook_secret: false },
      form: { github_app_id: '', github_private_key: '', github_webhook_secret: '' },
      busy: false,
      error: '',
      message: '',
      newUser: { username: '', password: '' },
      passwordFor: null,
      newPassword: '',
      crewBusy: false,
      crewError: '',
      crewMessage: '',
    }
  },
  computed: {
    webhookUrl() {
      return `${location.origin}/api/webhooks/github`
    },
    // Mirrored from the server's LiveState over the WebSocket, so adds and
    // removals from any session show up without refetching.
    users() {
      return Object.values(store.live.users ?? {}).sort((a, b) => a.username.localeCompare(b.username))
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

    isSelf(user) {
      return user.username === store.user?.username
    },
    shortDate(iso) {
      return String(iso ?? '').slice(0, 10)
    },
    describeError(err) {
      if (!err.fields) return err.message
      return Object.entries(err.fields)
        .map(([field, msg]) => `${field}: ${msg}`)
        .join(' — ')
    },
    async addUser() {
      this.crewBusy = true
      this.crewError = ''
      this.crewMessage = ''
      try {
        const user = await api.post('/api/users', this.newUser)
        this.newUser = { username: '', password: '' }
        this.crewMessage = `Welcome aboard, ${user.username} ✔`
      } catch (err) {
        this.crewError = this.describeError(err)
      } finally {
        this.crewBusy = false
      }
    },
    togglePassword(user) {
      this.passwordFor = this.passwordFor === user.id ? null : user.id
      this.newPassword = ''
      this.crewError = ''
      this.crewMessage = ''
    },
    async savePassword(user) {
      this.crewBusy = true
      this.crewError = ''
      this.crewMessage = ''
      try {
        await api.put(`/api/users/${user.id}/password`, { password: this.newPassword })
        this.passwordFor = null
        this.newPassword = ''
        this.crewMessage = `Password changed for ${user.username} ✔`
      } catch (err) {
        this.crewError = this.describeError(err)
      } finally {
        this.crewBusy = false
      }
    },
    async removeUser(user) {
      if (!confirm(`Remove ${user.username} from the crew? Their sessions end immediately.`)) return
      this.crewBusy = true
      this.crewError = ''
      this.crewMessage = ''
      try {
        await api.del(`/api/users/${user.id}`)
        this.crewMessage = `${user.username} has gone ashore.`
      } catch (err) {
        this.crewError = this.describeError(err)
      } finally {
        this.crewBusy = false
      }
    },
  },
}
</script>
