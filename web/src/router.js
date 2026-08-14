import { createRouter, createWebHistory } from 'vue-router'
import { api } from './api.js'
import { store } from './store.js'
import { connectWs } from './ws.js'
import LoginView from './views/LoginView.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectNewView from './views/ProjectNewView.vue'
import ProjectView from './views/ProjectView.vue'
import SettingsView from './views/SettingsView.vue'
import SystemView from './views/SystemView.vue'
import ShipyardView from './views/ShipyardView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/', component: DashboardView },
    { path: '/projects/new', component: ProjectNewView },
    { path: '/projects/:id', component: ProjectView, props: true },
    { path: '/settings', component: SettingsView },
    { path: '/system', component: SystemView },
    { path: '/shipyard', component: ShipyardView },
  ],
})

router.beforeEach(async to => {
  if (to.path === '/login') return true
  if (store.user) return true
  try {
    store.user = await api.get('/api/auth/me')
    connectWs()
    return true
  } catch {
    return '/login'
  }
})
