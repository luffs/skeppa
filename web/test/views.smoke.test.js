import { describe, test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Every view, mounted for both roles against a seeded store and a stubbed
// API, failing on any Vue render warning. This exists because of a bug class
// the server suite cannot see: a template referencing something the
// instance never exposed (`store.user` in a component that only imported
// `store`) renders as a warning plus a TypeError — and twice it was only a
// browser session that found one. Vue reports exactly that as
// "was accessed during render but is not defined", so that is what fails here.

vi.mock('../src/api.js', () => {
  // Shapes the views read from on load; anything unlisted gets an empty object.
  const answer = url => {
    if (url.startsWith('/api/settings')) {
      return { github_app_id: null, has_private_key: false, has_webhook_secret: false, firebase_config: null, has_notify_url: false, notify_url_host: '' }
    }
    if (url.startsWith('/api/proxy')) {
      return { base_domain: '', http_port: 8100, admin_port: 2020, routes: [], caddy_available: false, process_status: '', last_error: null }
    }
    if (url.startsWith('/api/github/setup')) return { configured: false, app: null, install_url: null, installed: false, repos: null, error: null }
    if (url.startsWith('/api/github/')) return [] // repos, webhook deliveries
    if (/\/api\/projects\/\d+\/deployments/.test(url)) return []
    if (/\/api\/projects\/\d+\/env/.test(url)) return []
    if (/\/api\/projects\/\d+\/logs/.test(url)) {
      const stream = { path: null, text: '', truncated: false, missing: true }
      return { name: 'x', lines: 200, out: stream, err: stream, prev: stream }
    }
    if (/\/api\/deployments\/\d+/.test(url)) return { id: 1, status: 'success', log: '' }
    if (url.startsWith('/api/account')) return { id: 1, username: 'cap', role: 'admin', handle: '', domain: '', github_login: '', created_at: '2026-01-01' }
    if (url.startsWith('/api/auth/firebase-config')) return null
    return {}
  }
  return {
    api: {
      onUnauthorized: null,
      get: async url => answer(url),
      post: async () => ({}),
      put: async () => ({}),
      patch: async () => ({}),
      del: async () => ({}),
    },
  }
})
// live.js would replace store.live with the store-backed composition; the
// harness seeds store.live itself.
vi.mock('../src/live.js', () => ({ connectLive() {}, disconnectLive() {}, subscribeLogs() { return () => {} } }))

import { store } from '../src/store.js'
import DashboardView from '../src/views/DashboardView.vue'
import ProjectNewView from '../src/views/ProjectNewView.vue'
import ProjectView from '../src/views/ProjectView.vue'
import SettingsView from '../src/views/SettingsView.vue'
import SystemView from '../src/views/SystemView.vue'
import ShipyardView from '../src/views/ShipyardView.vue'
import AccountView from '../src/views/AccountView.vue'
import LoginView from '../src/views/LoginView.vue'

// --- a LiveState the way the server would send it ----------------------------
const NOW = Date.now()
const ISO = new Date(NOW - 60_000).toISOString()

const info = (id, slug, owner) => ({
  id, slug, name: slug, owner_id: owner.id, repo_full_name: `o/${slug}`, git_url: '', branch: 'main',
  deploy_script: 'bun install', build_image: '', run_image: '', runtime: 'container', pm2_name: slug,
  start_command: 'bun start', cwd: null, auto_deploy: 1, write_env_file: 0, build_env: 1,
  subdomain: 'app', port: 4100 + id, memory_mb: 512, network_profile: 'open', host_access: 0, networks: '',
  created_at: '2026-01-01 00:00:00', owner_role: owner.role, owner_handle: owner.handle, owner_domain: owner.domain ?? '',
})
const stats = { status: 'online', uptime: NOW - 5_000, memory: 40 * 1024 * 1024, cpu: 2, restarts: 0, pid: 100 }
const project = (id, slug, owner) => ({
  info: info(id, slug, owner),
  pm2: { ...stats },
  currentDeployment: null,
  lastDeployment: { id, status: 'success', finishedAt: ISO, commitSha: 'a'.repeat(40) },
  recentDeployments: [{ id, status: 'success', trigger: 'manual', commitSha: 'a'.repeat(40), startedAt: ISO, finishedAt: ISO, createdAt: ISO }],
  deployedSha: 'a'.repeat(40),
  headCommit: { sha: 'b'.repeat(40), message: 'feat: something', pushedAt: ISO },
})
const ADMIN = { id: 1, username: 'cap', role: 'admin', handle: '', domain: '' }
const TENANT = { id: 2, username: 'bob', role: 'tenant', handle: 'bob', domain: '' }

function seedStore(role) {
  store.user = role === 'admin' ? ADMIN : TENANT
  store.connected = true
  store.ready = true
  store.liveUpdatedAt = NOW
  store.live = {
    projects: { 1: project(1, 'adm', ADMIN), 2: project(2, 'bobapp', TENANT) },
    system: {
      appsDir: '/home/skeppa/apps', hostBootAt: NOW - 1e7, panelStartedAt: NOW - 1e5,
      selfPm2Name: 'skeppa', proxyPm2Name: 'skeppa-proxy', loadavg: [0.1, 0.2, 0.3],
      memory: { total: 8e9, free: 4e9 }, disk: { appsDirBytes: 1e9, free: 5e10, total: 1e11 },
      pm2Error: null, pm2: { skeppa: { ...stats }, 'skeppa-proxy': { ...stats } },
      containerSocket: '/run/user/1000/podman/podman.sock', containerError: '',
      containers: {
        'skeppa-app-adm': { ...stats, image: 'docker.io/oven/bun:1', ports: [], slug: 'adm', createdAt: ISO, state: 'running' },
        postgres: { ...stats, image: 'docker.io/postgres:16', ports: [], slug: '', createdAt: ISO, state: 'running' },
      },
    },
    users: { 1: { ...ADMIN, created_at: ISO }, 2: { ...TENANT, created_at: ISO } },
    proxy: { baseDomain: 'apps.example.com' },
    images: { managedPrefix: 'localhost/skeppa/', managed: [], local: [], storeListed: false, engineError: '', defaultImage: 'docker.io/oven/bun:1' },
  }
}

// --- mount with every warning channel captured -------------------------------
const RENDER_PROBLEM = /accessed during render|Unhandled error|Failed to resolve component|Property .* was accessed/

// Mounts, lets the view settle, runs `steps` against it, and always tears
// down — a view that fails must not leave a broken component behind to throw
// into the next test's spies (one bug, one red test).
async function expectCleanRender(component, { props = {}, steps = async () => {} } = {}) {
  const problems = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    const message = args.map(String).join(' ')
    if (RENDER_PROBLEM.test(message)) problems.push(message)
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...args) => problems.push(args.map(String).join(' ')))
  let wrapper = null
  try {
    wrapper = mount(component, {
      props,
      global: {
        mocks: { $route: { path: '/', query: {}, params: {} }, $router: { push() {}, replace() {} } },
        stubs: { RouterLink: { props: ['to'], template: '<a><slot /></a>' }, RouterView: true },
        config: { errorHandler: err => problems.push(`errorHandler: ${err.message}`) },
      },
    })
    await settle()
    await steps(wrapper)
    await settle()
  } catch (err) {
    problems.push(`threw: ${err.message}`)
  } finally {
    try { wrapper?.unmount() } catch { /* a broken tree may throw again on teardown */ }
    warn.mockRestore()
    error.mockRestore()
  }
  return { problems, html: wrapper?.html() ?? '' }
}

const settle = async () => { await flushPromises(); await flushPromises() }

const VIEWS = [
  ['DashboardView', DashboardView],
  ['ProjectNewView', ProjectNewView],
  ['SettingsView', SettingsView],
  ['SystemView', SystemView],
  ['ShipyardView', ShipyardView],
  ['AccountView', AccountView],
  ['LoginView', LoginView],
]

for (const role of ['admin', 'tenant']) {
  describe(`as ${role}`, () => {
    for (const [name, View] of VIEWS) {
      test(`${name} renders without template errors`, async () => {
        seedStore(role)
        const { problems, html } = await expectCleanRender(View)
        expect(problems).toEqual([])
        expect(html.length).toBeGreaterThan(0)
      })
    }

    // The Rigging tab is where both real-world crashes lived — every tab gets
    // rendered, for the project this role owns.
    test('ProjectView renders every tab', async () => {
      seedStore(role)
      const { problems } = await expectCleanRender(ProjectView, {
        props: { id: role === 'admin' ? '1' : '2' },
        steps: async wrapper => {
          for (const tab of ['deploys', 'logs', 'env', 'settings']) {
            wrapper.vm.tab = tab
            await settle()
          }
        },
      })
      expect(problems).toEqual([])
    })
  })
}

// The harness must actually catch the bug class it exists for.
test('the harness fails on an identifier the template uses but the instance never exposed', async () => {
  const Broken = { name: 'Broken', template: '<div>{{ store.user.username }}</div>' }
  const { problems } = await expectCleanRender(Broken)
  expect(problems.some(p => /store|accessed during render|threw/.test(p))).toBe(true)
})
