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
        Skeppa needs a GitHub App for repo access, clone tokens and push webhooks. Let Skeppa
        create it: GitHub shows the app pre-filled — webhook URL, permissions and events already
        set — and once you confirm, the credentials land here by themselves. Finish by installing
        the app on the repos you want to deploy when GitHub offers it.
      </p>

      <div class="row">
        <input
          v-model="manifestOrg"
          class="code"
          placeholder="organization (blank = your account)"
          style="flex: 1 1 220px; width: auto"
        />
        <button :disabled="creating" @click="createGithubApp">
          {{ creating ? 'Off to GitHub…' : 'Create GitHub App →' }}
        </button>
      </div>
      <p v-if="installUrl" class="hint">
        App created ✔ — <a :href="installUrl" style="color: var(--accent)">install it on GitHub</a>,
        picking the repos to deploy, and you land back here.
      </p>

      <p class="hint" style="font-size: 13.5px; margin-top: 18px">
        Or create the app yourself (GitHub → Settings → Developer settings → GitHub Apps:
        <strong>Contents: read</strong>, <strong>Metadata: read</strong>, the <strong>push</strong>
        event, webhook URL <span class="mono" style="font-size: 12.5px">{{ webhookUrl }}</span>)
        and paste its credentials:
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

      <template v-if="status.has_private_key">
        <label style="margin-top: 26px">Recent webhook deliveries</label>
        <p class="hint" style="font-size: 13.5px">
          GitHub's log of what it sent to the webhook URL — the first place to look when a push
          does not start a voyage. Redeliver resends one after you fix the cause.
        </p>
        <p v-if="deliveriesError" class="error">{{ deliveriesError }}</p>
        <p v-else-if="!deliveries.length" class="hint">
          {{ deliveriesBusy ? 'Loading…' : 'No deliveries yet — GitHub sends one for every push to a repo the app is installed on.' }}
        </p>
        <div v-else class="crew-rows" style="margin-top: 0">
          <div v-for="d in deliveries" :key="d.id" class="crew-row">
            <span class="dot" :class="deliveryOk(d) ? 'green' : 'red'"></span>
            <span class="mono" style="font-size: 13px">{{ d.event }}{{ d.action ? ':' + d.action : '' }}</span>
            <span class="hint">{{ d.status_code }} · {{ d.status }}</span>
            <span v-if="d.redelivery" class="chip">redelivery</span>
            <span class="spacer"></span>
            <span class="hint">{{ timeAgo(d.delivered_at) }}</span>
            <button class="secondary small" :disabled="redelivering === d.id" @click="redeliver(d)">
              {{ redelivering === d.id ? 'Sending…' : 'Redeliver' }}
            </button>
          </div>
        </div>
        <div class="row" style="margin-top: 10px">
          <button class="secondary small" :disabled="deliveriesBusy" @click="loadDeliveries">
            {{ deliveriesBusy ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </template>
    </CollapseSection>

    <CollapseSection title="Google sign-in">
      <template #meta>
        <span v-if="status.firebase_config" class="chip green">configured</span>
      </template>

      <p class="hint" style="font-size: 13.5px">
        Lets crew members board with their Google account via Firebase. Create a Firebase project
        with the <strong>Google</strong> sign-in provider enabled, add a web app, and paste its
        <span class="mono" style="font-size: 12.5px">firebaseConfig</span> snippet below. A signed-in
        Google account is matched by email: the crew member's <strong>username must be their Google
        email address</strong>. The config is public by design — it contains no secrets.
      </p>

      <label>Firebase web config</label>
      <textarea
        v-model="fbText"
        class="code"
        rows="8"
        placeholder='{
  "apiKey": "AIza…",
  "authDomain": "my-project.firebaseapp.com",
  "projectId": "my-project",
  "appId": "1:1234567890:web:abc123"
}'
      ></textarea>

      <p v-if="fbError" class="error">{{ fbError }}</p>
      <p v-if="fbMessage" class="hint">{{ fbMessage }}</p>
      <div class="row" style="margin-top: 20px">
        <button :disabled="fbBusy" @click="saveFirebase">{{ fbBusy ? 'Saving…' : 'Save' }}</button>
        <button v-if="status.firebase_config" class="danger" :disabled="fbBusy" @click="removeFirebase">Disable</button>
      </div>
    </CollapseSection>

    <CollapseSection title="Harbor gate">
      <template #meta>
        <span v-if="gate && gate.last_error" class="chip red">error</span>
        <span v-else-if="gate && gate.base_domain && gate.process_status === 'online'" class="chip green">
          routing {{ gate.routes.length }}
        </span>
        <span v-else-if="gate && gate.base_domain" class="chip amber">not running</span>
      </template>

      <p class="hint" style="font-size: 13.5px">
        Routes each project's subdomain to its port through a panel-owned Caddy instance
        (<span class="mono" style="font-size: 12.5px">skeppa-proxy</span> in the Engine room).
        Set a subdomain and port per project under its Rigging tab; the routed port is injected
        into the app as <span class="mono" style="font-size: 12.5px">PORT</span>. Requires the
        <span class="mono" style="font-size: 12.5px">caddy</span> binary on the panel user's PATH.
      </p>

      <label>Base domain</label>
      <input v-model="gateForm.base_domain" class="code" placeholder="apps.example.com" />

      <div class="row">
        <div style="flex: 1 1 140px">
          <label>Listen port</label>
          <input v-model="gateForm.http_port" class="code" placeholder="8100" />
        </div>
        <div style="flex: 1 1 140px">
          <label>Admin port</label>
          <input v-model="gateForm.admin_port" class="code" placeholder="2020" />
        </div>
      </div>
      <p class="hint">
        The admin port must differ from 2019 — the system Caddy already uses it.
      </p>

      <template v-if="gate && gate.base_domain">
        <label style="margin-top: 20px">One-time setup for the system Caddy (ask the server admin)</label>
        <textarea class="code" readonly rows="3" :value="adminSnippet" @focus="$event.target.select()"></textarea>
        <p class="hint">
          The wildcard needs a certificate: either a DNS-01 wildcard cert, or add
          <span class="mono" style="font-size: 12.5px">tls { on_demand }</span> to the block.
        </p>

        <label style="margin-top: 20px">Routes</label>
        <p v-if="!gate.routes.length" class="hint">
          None yet — set a subdomain and port on a project's Rigging tab.
        </p>
        <div v-else class="crew-rows" style="margin-top: 0">
          <div v-for="r in gate.routes" :key="r.project_id" class="crew-row">
            <span class="mono" style="font-size: 13px">{{ r.host }}</span>
            <span class="hint">→ localhost:{{ r.port }}</span>
            <span class="spacer"></span>
            <span class="hint">{{ r.name }}</span>
          </div>
        </div>

        <p class="hint" style="margin-top: 12px">
          <template v-if="!gate.caddy_available">⚠ caddy binary not found on PATH.</template>
          <template v-else-if="gate.process_status">proxy process: {{ gate.process_status }}</template>
          <template v-else>proxy process not started yet — Apply will start it.</template>
        </p>
      </template>

      <p v-if="gate && gate.last_error" class="error">{{ gate.last_error }}</p>
      <p v-if="gateError" class="error">{{ gateError }}</p>
      <p v-if="gateMessage" class="hint">{{ gateMessage }}</p>
      <div class="row" style="margin-top: 20px">
        <button :disabled="gateBusy" @click="saveGate">{{ gateBusy ? 'Working…' : 'Save & apply' }}</button>
        <button v-if="gate && gate.base_domain" class="secondary" :disabled="gateBusy" @click="applyGate">
          Apply now
        </button>
      </div>
    </CollapseSection>
  </div>
</template>

<script>
import { api } from '../api.js'
import { confirmDialog } from '../lib/dialog.js'
import { store } from '../store.js'
import { timeAgo } from '../lib/format.js'
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
      manifestOrg: '',
      creating: false,
      installUrl: '',
      deliveries: [],
      deliveriesBusy: false,
      deliveriesError: '',
      redelivering: null,
      newUser: { username: '', password: '' },
      passwordFor: null,
      newPassword: '',
      crewBusy: false,
      crewError: '',
      crewMessage: '',
      fbText: '',
      fbBusy: false,
      fbError: '',
      fbMessage: '',
      gate: null,
      gateForm: { base_domain: '', http_port: '8100', admin_port: '2020' },
      gateBusy: false,
      gateError: '',
      gateMessage: '',
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
    adminSnippet() {
      return `*.${this.gateForm.base_domain || 'apps.example.com'} {\n    reverse_proxy localhost:${this.gateForm.http_port || 8100}\n}`
    },
  },
  async created() {
    // Returning from GitHub: app created (?code=&state=) or app installed
    // (?setup_action=). Strip the query first so a refresh can't replay it.
    const { code, state, setup_action: setupAction } = this.$route.query
    if (code || setupAction) this.$router.replace({ path: '/settings' })
    if (code && state) await this.completeManifest(String(code), String(state))
    await Promise.all([this.load(), this.loadGate()])
    if (this.status.has_private_key) this.loadDeliveries()
    if (setupAction) await this.test()
  },
  methods: {
    async load() {
      this.status = await api.get('/api/settings')
      this.form.github_app_id = this.status.github_app_id ?? ''
      this.fbText = this.status.firebase_config ? JSON.stringify(this.status.firebase_config, null, 2) : ''
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

    async createGithubApp() {
      if (
        this.status.has_private_key &&
        !(await confirmDialog('A GitHub App is already configured — creating a new one replaces its credentials here. Continue?', { confirmLabel: 'Replace' }))
      ) {
        return
      }
      this.creating = true
      this.error = ''
      this.message = ''
      try {
        const { action, manifest } = await api.post('/api/github/manifest', {
          origin: location.origin,
          organization: this.manifestOrg.trim() || undefined,
        })
        // GitHub's manifest flow expects a top-level form POST, so build one
        // and leave the page; GitHub redirects back here with ?code=&state=.
        const form = document.createElement('form')
        form.method = 'post'
        form.action = action
        const field = document.createElement('input')
        field.type = 'hidden'
        field.name = 'manifest'
        field.value = JSON.stringify(manifest)
        form.appendChild(field)
        document.body.appendChild(form)
        form.submit()
      } catch (err) {
        this.error = err.message
        this.creating = false
      }
    },
    async completeManifest(code, state) {
      this.busy = true
      this.error = ''
      this.message = ''
      try {
        const res = await api.post('/api/github/manifest/convert', { code, state })
        this.installUrl = res.install_url
        this.message = `GitHub App created and credentials saved ✔ (app id ${res.app_id})`
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },

    timeAgo,
    deliveryOk(d) {
      return d.status === 'OK' || (d.status_code >= 200 && d.status_code < 300)
    },
    async loadDeliveries() {
      this.deliveriesBusy = true
      this.deliveriesError = ''
      try {
        this.deliveries = await api.get('/api/github/webhook-deliveries')
      } catch (err) {
        this.deliveries = []
        this.deliveriesError = err.message
      } finally {
        this.deliveriesBusy = false
      }
    },
    async redeliver(d) {
      this.redelivering = d.id
      this.deliveriesError = ''
      try {
        await api.post(`/api/github/webhook-deliveries/${d.id}/redeliver`)
        this.message = 'Redelivery requested ✔ — give GitHub a few seconds, then refresh the list.'
        await this.loadDeliveries()
      } catch (err) {
        this.deliveriesError = err.message
      } finally {
        this.redelivering = null
      }
    },

    async loadGate() {
      this.gate = await api.get('/api/proxy')
      this.gateForm = {
        base_domain: this.gate.base_domain ?? '',
        http_port: String(this.gate.http_port),
        admin_port: String(this.gate.admin_port),
      }
    },
    async saveGate() {
      this.gateBusy = true
      this.gateError = ''
      this.gateMessage = ''
      try {
        this.gate = await api.put('/api/proxy', {
          base_domain: this.gateForm.base_domain,
          http_port: Number(this.gateForm.http_port),
          admin_port: Number(this.gateForm.admin_port),
        })
        // The base domain also lives in LiveState — the server pushes that
        // change, so app links elsewhere update on their own.
        this.gateMessage = this.gate.base_domain
          ? (this.gate.last_error ? 'Saved — but applying failed, see the error above.' : 'Saved & applied ✔')
          : 'Harbor gate disabled.'
      } catch (err) {
        this.gateError = this.describeError(err)
      } finally {
        this.gateBusy = false
      }
    },
    async applyGate() {
      this.gateBusy = true
      this.gateError = ''
      this.gateMessage = ''
      try {
        this.gate = await api.post('/api/proxy/apply')
        this.gateMessage = 'Applied ✔'
      } catch (err) {
        this.gateError = err.message
        await this.loadGate().catch(() => {})
      } finally {
        this.gateBusy = false
      }
    },

    // The Firebase console hands out a JS object literal, not JSON — accept
    // both by quoting bare keys and dropping trailing commas before parsing.
    parseFirebaseConfig(text) {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start === -1 || end <= start) throw new Error('paste the firebaseConfig object from the Firebase console')
      const objText = text.slice(start, end + 1)
      try {
        return JSON.parse(objText)
      } catch {
        const jsonish = objText
          .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
          .replace(/,\s*}/g, '}')
        try {
          return JSON.parse(jsonish)
        } catch {
          throw new Error('could not parse the config — paste the firebaseConfig object as shown in the Firebase console')
        }
      }
    },
    async saveFirebase() {
      this.fbBusy = true
      this.fbError = ''
      this.fbMessage = ''
      try {
        const firebase_config = this.parseFirebaseConfig(this.fbText)
        await api.put('/api/settings', { firebase_config })
        await this.load()
        this.fbMessage = 'Saved ✔ — Google sign-in is available on the login page.'
      } catch (err) {
        this.fbError = err.message
      } finally {
        this.fbBusy = false
      }
    },
    async removeFirebase() {
      this.fbBusy = true
      this.fbError = ''
      this.fbMessage = ''
      try {
        await api.put('/api/settings', { firebase_config: null })
        await this.load()
        this.fbMessage = 'Google sign-in disabled.'
      } catch (err) {
        this.fbError = err.message
      } finally {
        this.fbBusy = false
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
      if (!(await confirmDialog(`Remove ${user.username} from the crew? Their sessions end immediately.`, { confirmLabel: 'Remove', danger: true }))) return
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
