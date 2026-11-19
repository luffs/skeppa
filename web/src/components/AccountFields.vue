<template>
  <p v-if="!me" class="hint">Loading…</p>
  <template v-else>
    <section v-if="identity" class="section-part">
      <label>Username</label>
      <input :value="me.username" class="code" readonly />
      <label>Role</label>
      <input :value="me.role" class="code" readonly />
      <template v-if="me.role === 'tenant'">
        <label>Handle</label>
        <input :value="me.handle" class="code" readonly />
        <p class="hint">
          Your shared networks are namespaced by it<template v-if="!me.domain">, and your projects route as
          <span class="mono">&lt;subdomain&gt;.{{ me.handle }}.{{ baseDomain || '<base domain>' }}</span></template>.
          Set by the admin.
        </p>
        <label>Domain</label>
        <input :value="me.domain || '— none —'" class="code" readonly />
        <p class="hint" v-if="me.domain">
          A domain of your own: your projects route as
          <span class="mono">&lt;subdomain&gt;.{{ me.domain }}</span>, and the project whose subdomain is
          <span class="mono">@</span> sits at <span class="mono">{{ me.domain }}</span> itself. Point its DNS
          (the domain and a wildcard) at this server. Set by the admin.
        </p>
        <p class="hint" v-else>
          The admin can route your projects under a domain of your own instead of the handle.
        </p>
        <label>GitHub login</label>
        <input :value="me.github_login || '— not linked —'" class="code" readonly />
        <p class="hint">
          The account whose installation of the panel's GitHub App you moor repos from. Linked by
          the admin — it is what the repo picker trusts, so it is not yours to change here.
        </p>
      </template>
    </section>

    <section class="section-part">
      <h3 class="section-part-title">Change password</h3>
      <form @submit.prevent="changePassword">
        <label>Current password</label>
        <input v-model="pw.current" type="password" autocomplete="current-password" />
        <label>New password</label>
        <input v-model="pw.password" type="password" autocomplete="new-password" placeholder="min 8 characters" />
        <label>Repeat new password</label>
        <input v-model="pw.repeat" type="password" autocomplete="new-password" />
        <p v-if="pwError" class="error">{{ pwError }}</p>
        <p v-if="pwMessage" class="hint">{{ pwMessage }}</p>
        <p style="margin-top: 12px">
          <button :disabled="pwBusy || !canSubmit">{{ pwBusy ? 'Working…' : 'Change password' }}</button>
        </p>
      </form>
      <p class="hint">Changing it signs you out everywhere else; this session stays.</p>
    </section>
  </template>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'

// The signed-in user's own account: who they are, and their password. A
// tenant's Account page and an admin's Rigging both show it. Everything
// identity-shaped (handle, GitHub login) is read-only on purpose: the admin
// vouches for those. `identity: false` leaves out the read-only half — on
// Rigging the section's head already names the admin.
export default {
  name: 'AccountFields',
  props: {
    identity: { type: Boolean, default: true },
  },
  data() {
    return {
      me: null,
      pw: { current: '', password: '', repeat: '' },
      pwBusy: false,
      pwError: '',
      pwMessage: '',
    }
  },
  computed: {
    baseDomain() {
      return store.live.proxy?.baseDomain ?? ''
    },
    canSubmit() {
      return this.pw.current && this.pw.password.length >= 8 && this.pw.password === this.pw.repeat
    },
  },
  async created() {
    this.me = await api.get('/api/account')
  },
  methods: {
    async changePassword() {
      this.pwBusy = true
      this.pwError = ''
      this.pwMessage = ''
      try {
        await api.put('/api/account/password', { current: this.pw.current, password: this.pw.password })
        this.pw = { current: '', password: '', repeat: '' }
        this.pwMessage = 'Password changed ✔'
      } catch (err) {
        this.pwError = err.fields ? Object.values(err.fields).join(', ') : err.message
      } finally {
        this.pwBusy = false
      }
    },
  },
}
</script>
