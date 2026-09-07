<template>
  <div class="container mid">
    <div class="page-head">
      <h1 style="margin: 0">Account</h1>
    </div>

    <p v-if="!me" class="hint">Loading…</p>
    <template v-else>
      <div class="panel" style="max-width: 680px">
        <label>Username</label>
        <input :value="me.username" class="code" readonly />
        <label>Role</label>
        <input :value="me.role" class="code" readonly />
        <template v-if="me.role === 'tenant'">
          <label>Handle</label>
          <input :value="me.handle" class="code" readonly />
          <p class="hint">
            Your projects route as
            <span class="mono">&lt;subdomain&gt;.{{ me.handle }}.{{ baseDomain || '<base domain>' }}</span>
            and your shared networks are namespaced by it. Set by the admin.
          </p>
          <label>GitHub login</label>
          <input :value="me.github_login || '— not linked —'" class="code" readonly />
          <p class="hint">
            The account whose installation of the panel's GitHub App you moor repos from. Linked by
            the admin — it is what the repo picker trusts, so it is not yours to change here.
          </p>
        </template>
      </div>

      <div class="panel" style="max-width: 680px; margin-top: 16px">
        <h2 style="margin: 0 0 8px">Change password</h2>
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
      </div>
    </template>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'

// The signed-in user's own page — the one place a tenant manages anything
// about themselves. Everything identity-shaped (handle, GitHub login) is
// read-only here on purpose: the admin vouches for those.
export default {
  name: 'AccountView',
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
