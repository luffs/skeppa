// The engine room on a seeded store, no backend or sign-in — dev only
// (`bun run dev:web`, then /engine-lab.html). Vite builds only index.html.
import { createApp } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import SystemView from '../views/SystemView.vue'
import { store } from '../store.js'
import { initTheme } from '../lib/theme.js'
import '../style.css'

initTheme()

const MB = 1024 * 1024
const now = Date.now()
const ago = s => now - s * 1000
const info = (id, slug, memory_mb = 512) => ({ id, slug, name: slug, pm2_name: slug, subdomain: slug, memory_mb, owner_role: 'admin', owner_handle: '', owner_domain: '' })
const proc = (status, over = {}) => ({ status, uptime: status === 'online' ? ago(3 * 86400 + 4000) : 0, cpu: status === 'online' ? 1.2 : null, memory: status === 'online' ? 84 * MB : 0, restarts: 0, pid: status === 'online' ? 41220 : 0, ...over })
const box = (status, slug, image, over = {}) => ({
  ...proc(status), slug, image, imageId: 'sha256:a', ports: ['127.0.0.1:4101→3000'], createdAt: ago(9 * 86400), state: status === 'online' ? 'running' : 'exited', ...over,
})

store.user = { id: 1, username: 'cap', role: 'admin' }
store.connected = true
store.ready = true
store.liveUpdatedAt = now
store.live = {
  projects: {
    1: { info: info(1, 'blog') }, 2: { info: info(2, 'shop') }, 3: { info: info(3, 'api') },
    4: { info: { ...info(4, 'docs'), runtime: 'pm2' } },
  },
  groups: {},
  users: {},
  proxy: { baseDomain: 'apps.example.com' },
  images: { managedPrefix: 'localhost/skeppa/', managed: [], local: [], storeListed: false, engineError: '', defaultImage: 'docker.io/oven/bun:1' },
  system: {
    appsDir: '/home/skeppa/apps', hostBootAt: ago(40 * 86400), panelStartedAt: ago(2 * 86400), selfPm2Name: 'skeppa', proxyPm2Name: 'skeppa-proxy',
    loadavg: [0.31, 0.4, 0.38], cpuCount: 4, memory: { total: 8e9, free: 3.1e9 }, disk: { appsDirBytes: 2.4e9, free: 41e9, total: 100e9 },
    pm2Error: null,
    pm2: {
      skeppa: proc('online', { memory: 142 * MB, cpu: 3.4, restarts: 2 }),
      'skeppa-proxy': proc('online', { memory: 38 * MB, cpu: 0.2 }),
      docs: proc('online', { memory: 61 * MB, restarts: 14 }),
      'some-cron-thing': proc('stopped'),
    },
    containerSocket: '/run/user/1000/podman/podman.sock', containerError: '',
    containers: {
      'skeppa-app-blog': box('online', 'blog', 'localhost/skeppa/bun-node:latest', { memory: 120 * MB, cpu: 2.1 }),
      'skeppa-app-shop': box('online', 'shop', 'docker.io/oven/bun:1', { memory: 470 * MB, cpu: 11.7, restarts: 3 }),
      'skeppa-app-api': box('stopped', 'api', 'docker.io/oven/bun:1'),
      'skeppa-app-oldthing': box('stopped', 'oldthing', 'docker.io/library/node:22-alpine', { ports: [] }),
      postgres: box('online', '', 'docker.io/library/postgres:16', { ports: ['127.0.0.1:5432→5432'], memory: 210 * MB }),
    },
  },
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: SystemView }, { path: '/:rest(.*)', component: { render: () => null } }],
})
router.push('/')
router.isReady().then(() => createApp(SystemView).use(router).mount('#app'))
