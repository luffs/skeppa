import { createRouter, createWebHistory } from 'vue-router'
import { api } from './api.js'
import { store } from './store.js'
import { connectLive } from './live.js'
import LoginView from './views/LoginView.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectNewView from './views/ProjectNewView.vue'
import ProjectView from './views/ProjectView.vue'
import SettingsView from './views/SettingsView.vue'
import SystemView from './views/SystemView.vue'
import ShipyardView from './views/ShipyardView.vue'
import AccountView from './views/AccountView.vue'
import FleetView from './views/FleetView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/', component: DashboardView },
    { path: '/projects/new', component: ProjectNewView },
    { path: '/projects/:id', component: ProjectView, props: true, meta: { project: true } },
    // Another server's project, run through the fleet (lib/ship.js).
    { path: '/fleet/:node/projects/new', component: ProjectNewView, props: true, meta: { nodePage: true } },
    { path: '/fleet/:node/projects/:id', component: ProjectView, props: true, meta: { project: true } },
    // …and its admin pages: the same views, about that server.
    { path: '/fleet/:node/system', component: SystemView, props: true, meta: { nodePage: true } },
    { path: '/fleet/:node/shipyard', component: ShipyardView, props: true, meta: { nodePage: true } },
    { path: '/fleet/:node/settings', component: SettingsView, props: true, meta: { nodePage: true } },
    { path: '/settings', component: SettingsView },
    { path: '/system', component: SystemView },
    { path: '/shipyard', component: ShipyardView },
    { path: '/fleet', component: FleetView },
    { path: '/account', component: AccountView },
  ],
})

// An admin's account lives under Rigging; an old /account link still lands.
// The fleet is the admin's; a tenant following an old link lands in the harbor.
const accountHome = to => {
  if (to.path.startsWith('/fleet') && store.user?.role === 'tenant') return '/'
  return to.path === '/account' && store.user?.role !== 'tenant' ? '/settings' : true
}

router.beforeEach(async to => {
  if (to.path === '/login') return true
  if (store.user) return accountHome(to)
  try {
    store.user = await api.get('/api/auth/me')
    connectLive()
    return accountHome(to)
  } catch {
    return '/login'
  }
})
