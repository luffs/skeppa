<template>
  <div class="login-wrap">
    <form class="panel login-box" @submit.prevent="submit">
      <h1>⛵ Skeppa</h1>
      <label>Username</label>
      <input v-model="username" autocomplete="username" autofocus />
      <label>Password</label>
      <input v-model="password" type="password" autocomplete="current-password" />
      <p v-if="error" class="error">{{ error }}</p>
      <p style="margin-bottom: 0">
        <button :disabled="busy || !username || !password" style="width: 100%">
          {{ busy ? 'Logging in…' : 'Log in' }}
        </button>
      </p>
    </form>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import { connectWs } from '../ws.js'

export default {
  name: 'LoginView',
  data() {
    return { username: '', password: '', error: '', busy: false }
  },
  methods: {
    async submit() {
      this.busy = true
      this.error = ''
      try {
        store.user = await api.post('/api/auth/login', {
          username: this.username,
          password: this.password,
        })
        connectWs()
        this.$router.push('/')
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
