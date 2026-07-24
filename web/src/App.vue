<template>
  <div style="min-height: 100vh; display: flex; flex-direction: column">
    <nav v-if="store.user" class="masthead">
      <router-link to="/" class="brand">
        <span class="sail">⛵</span>
        <span class="name">Skeppa</span>
      </router-link>
      <div class="links">
        <router-link to="/" class="nav-link" :class="{ active: harborActive }">Harbor</router-link>
        <router-link to="/system" class="nav-link" :class="{ active: $route.path === '/system' }">Engine room</router-link>
        <router-link to="/settings" class="nav-link" :class="{ active: $route.path === '/settings' }">Rigging</router-link>
      </div>
      <span class="spacer"></span>
      <span class="conn" :title="store.connected ? 'live' : 'disconnected'">
        <span class="conn-dot" :class="{ on: store.connected }"></span>
        {{ store.connected ? 'live' : 'offline' }} · {{ store.user.username }}
      </span>
      <button
        class="secondary small"
        :title="theme === 'dark' ? 'Switch to day watch' : 'Switch to night watch'"
        @click="flipTheme"
      >{{ theme === 'dark' ? '☀' : '☾' }}</button>
      <button class="secondary small" @click="logout">Log out</button>
    </nav>
    <router-view />
  </div>
</template>

<script>
import { store } from './store.js'
import { api } from './api.js'
import { disconnectWs } from './ws.js'
import { currentTheme, toggleTheme } from './lib/theme.js'

export default {
  name: 'App',
  data() {
    return { store, theme: currentTheme() }
  },
  computed: {
    // Harbor covers the dashboard and everything project-related.
    harborActive() {
      return this.$route.path === '/' || this.$route.path.startsWith('/projects')
    },
  },
  methods: {
    flipTheme() {
      this.theme = toggleTheme()
    },
    async logout() {
      await api.post('/api/auth/logout').catch(() => {})
      store.user = null
      disconnectWs()
      this.$router.push('/login')
    },
  },
}
</script>
