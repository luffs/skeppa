<template>
  <div class="login-wrap">
    <form class="login-box" @submit.prevent="submit">
      <div class="sail">⛵</div>
      <h1>Skeppa</h1>
      <div class="tagline">deploy panel · come aboard</div>
      <div class="waves">
        <div>～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～</div>
      </div>
      <label>Username</label>
      <input v-model="username" autocomplete="username" autofocus />
      <label style="margin-top: 14px">Password</label>
      <input v-model="password" type="password" autocomplete="current-password" />
      <p v-if="error" class="error">{{ error }}</p>
      <p style="margin: 20px 0 0">
        <button :disabled="busy || !username || !password" style="width: 100%; padding: 12px; font-size: 14px; letter-spacing: 0.04em">
          {{ busy ? 'Boarding…' : 'Come aboard' }}
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
