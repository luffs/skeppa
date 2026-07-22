<template>
  <div>
    <nav v-if="store.user" class="topnav">
      <router-link to="/" class="brand">⛵ Skeppa</router-link>
      <router-link to="/" class="nav-link">Dashboard</router-link>
      <router-link to="/system" class="nav-link">System</router-link>
      <router-link to="/settings" class="nav-link">Settings</router-link>
      <span class="spacer"></span>
      <span class="conn-dot" :class="{ on: store.connected }" :title="store.connected ? 'live' : 'disconnected'"></span>
      <span class="hint">{{ store.user.username }}</span>
      <button class="secondary small" @click="logout">Log out</button>
    </nav>
    <router-view />
  </div>
</template>

<script>
import { store } from './store.js'
import { api } from './api.js'
import { disconnectWs } from './ws.js'

export default {
  name: 'App',
  data() {
    return { store }
  },
  methods: {
    async logout() {
      await api.post('/api/auth/logout').catch(() => {})
      store.user = null
      disconnectWs()
      this.$router.push('/login')
    },
  },
}
</script>
