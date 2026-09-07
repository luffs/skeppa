import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router.js'
import { api } from './api.js'
import { store } from './store.js'
import { disconnectLive } from './live.js'
import { initTheme } from './lib/theme.js'
import './style.css'

initTheme()

api.onUnauthorized = () => {
  store.user = null
  disconnectLive()
  router.push('/login')
}

createApp(App).use(router).mount('#app')
