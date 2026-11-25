// The Shipyard on a seeded store, no backend or sign-in — dev only
// (`bun run dev:web`, then /shipyard-lab.html). Vite builds only index.html.
// Managed images in every state worth seeing (built and in use, a failed
// build, never built, outdated users), and a local store with registry
// images, managed tags and a dangling layer. No backend, so actions answer
// with errors.
import { createApp } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import ShipyardView from '../views/ShipyardView.vue'
import { store } from '../store.js'
import { initTheme } from '../lib/theme.js'
import '../style.css'

initTheme()

const MB = 1024 * 1024
const now = Date.now()
const iso = s => new Date(now - s * 1000).toISOString()
const info = (id, slug, over = {}) => ({
  id, slug, name: slug, pm2_name: slug, subdomain: slug, runtime: 'container', build_image: '', run_image: '',
  owner_role: 'admin', owner_handle: '', owner_domain: '', ...over,
})
const BUN_NODE = `FROM docker.io/oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm git \\
 && rm -rf /var/lib/apt/lists/*
`
const PG_TOOLS = `FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && apt-get install -y postgresql-client-16
`
const WORKER = `FROM docker.io/library/python:3.13-slim
RUN pip install --no-cache-dir celery redis
`

store.user = { id: 1, username: 'cap', role: 'admin' }
store.connected = true
store.ready = true
store.liveUpdatedAt = now
store.live = {
  projects: {
    1: { info: info(1, 'blog', { build_image: 'localhost/skeppa/bun-node:latest' }), pm2: { status: 'online' } },
    2: { info: info(2, 'shop', { build_image: 'localhost/skeppa/bun-node:latest' }), pm2: { status: 'online' } },
    3: { info: info(3, 'api'), pm2: { status: 'online' } },
    4: { info: info(4, 'reports', { build_image: 'localhost/skeppa/pg-tools:latest' }), pm2: { status: 'stopped' } },
    5: { info: info(5, 'docs', { runtime: 'static' }), pm2: { status: 'published' } },
  },
  groups: {},
  users: {},
  nodes: {},
  nodeStates: {},
  proxy: { baseDomain: 'apps.example.com' },
  system: {
    appsDir: '/home/skeppa/apps', containers: {
      'skeppa-app-blog': { slug: 'blog', image: 'localhost/skeppa/bun-node:latest', imageId: 'sha256:b1', status: 'online' },
      'skeppa-app-shop': { slug: 'shop', image: 'localhost/skeppa/bun-node:latest', imageId: 'sha256:b0', status: 'online' },
      'skeppa-app-api': { slug: 'api', image: 'docker.io/oven/bun:1', imageId: 'sha256:o1', status: 'online' },
    },
  },
  images: {
    managedPrefix: 'localhost/skeppa/',
    defaultImage: 'docker.io/oven/bun:1',
    storeListed: true,
    engineError: '',
    managed: [
      { id: 1, name: 'bun-node', ref: 'localhost/skeppa/bun-node:latest', containerfile: BUN_NODE, last_built_at: iso(3 * 3600), last_build_status: 'success', used_by: ['blog', 'shop'], created_at: iso(40 * 86400) },
      { id: 2, name: 'pg-tools', ref: 'localhost/skeppa/pg-tools:latest', containerfile: PG_TOOLS, last_built_at: iso(2 * 86400), last_build_status: 'failed', used_by: ['reports'], created_at: iso(12 * 86400) },
      { id: 3, name: 'worker', ref: 'localhost/skeppa/worker:latest', containerfile: WORKER, last_built_at: null, last_build_status: null, used_by: [], created_at: iso(3600) },
    ],
    local: [
      { id: 'sha256:b1', tags: ['localhost/skeppa/bun-node:latest'], size: 612 * MB, managed: true, used_by: ['blog', 'shop'], createdAt: iso(3 * 3600) },
      { id: 'sha256:p1', tags: ['localhost/skeppa/pg-tools:latest'], size: 188 * MB, managed: true, used_by: ['reports'], createdAt: iso(9 * 86400) },
      { id: 'sha256:o1', tags: ['docker.io/oven/bun:1'], size: 285 * MB, managed: false, used_by: ['api', 'docs'], version: '1.2.21', createdAt: iso(6 * 86400), digest: 'sha256:9f2c1e7ab3d4' },
      { id: 'sha256:n1', tags: ['docker.io/library/node:22-alpine'], size: 162 * MB, managed: false, used_by: [], createdAt: iso(30 * 86400), digest: 'sha256:44aa01bc77e1' },
      { id: 'sha256:pg', tags: ['docker.io/library/postgres:16'], size: 438 * MB, managed: false, used_by: [], version: '16.4', createdAt: iso(20 * 86400) },
      { id: 'sha256:d1', tags: [], size: 96 * MB, managed: false, used_by: [], createdAt: iso(5 * 86400) },
    ],
  },
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: ShipyardView }, { path: '/:rest(.*)', component: { render: () => null } }],
})
router.push('/')
router.isReady().then(() => createApp(ShipyardView).use(router).mount('#app'))
