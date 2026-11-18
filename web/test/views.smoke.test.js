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
    if (/\/api\/projects\/\d+\/files\?path=README\.md/.test(url)) {
      return { type: 'file', path: 'README.md', name: 'README.md', size: 30, binary: false, tooLarge: false, text: '# App\n\nSee [the api](docs/api.md).\n' }
    }
    if (/\/api\/projects\/\d+\/files/.test(url)) {
      return {
        type: 'dir', path: '', truncated: false,
        entries: [{ name: 'docs', type: 'dir', size: null }, { name: '.env', type: 'file', size: 12, locked: true }, { name: 'README.md', type: 'file', size: 30 }],
      }
    }
    if (/\/api\/deployments\/\d+/.test(url)) return { id: 1, status: 'success', log: '' }
    if (/\/api\/users\/\d+\/reassign/.test(url)) {
      return {
        projects: [{ id: 2, name: 'bobapp' }], blockers: [],
        changes: [{ project: 'bobapp', kind: 'address', before: 'https://app.bob.apps.example.com', after: 'https://app.apps.example.com' }],
      }
    }
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
import { api } from '../src/api.js'
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
  // The admin's project sits at a pier; bob has an empty one and his project
  // at none — so every view renders a grouped, an empty and an ungrouped case.
  const adm = project(1, 'adm', ADMIN)
  adm.info.group_id = 7
  store.live = {
    projects: { 1: adm, 2: project(2, 'bobapp', TENANT) },
    groups: {
      7: { id: 7, owner_id: ADMIN.id, name: 'Kunder', created_at: ISO },
      8: { id: 8, owner_id: TENANT.id, name: 'Tomt', created_at: ISO },
    },
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
async function expectCleanRender(component, { props = {}, steps = async () => {}, route = {} } = {}) {
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
        mocks: { $route: { path: '/', query: {}, params: {}, ...route }, $router: { push() {}, replace() {} } },
        stubs: { RouterLink: { props: ['to'], template: `<a :href="typeof to === 'string' ? to : to.path"><slot /></a>` }, RouterView: true },
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
          for (const tab of ['deploys', 'logs', 'env', 'files', 'settings']) {
            wrapper.vm.tab = tab
            await settle()
            // the freight tab lists the folder and renders its README underneath
            if (tab === 'files') {
              expect(wrapper.find('.source-files table').text()).toContain('kept in the Manifest')
              expect(wrapper.find('.markdown a[data-path="docs/api.md"]').exists()).toBe(true)
            }
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

// The harbor is split by owner for an admin (their own fleet first, then
// each tenant's, headed with where it routes) and the ship's log tags other
// people's entries; a tenant has one fleet, so no headings and no tags.
// The log opens on the latest eight under day headings; Show more reveals
// what LiveState already holds, and Show less folds it back.
test("the ship's log heads its entries by day, and shows more of what it holds", async () => {
  seedStore('admin')
  const ago = h => new Date(NOW - h * 3_600_000).toISOString()
  store.live.projects[1].recentDeployments = Array.from({ length: 15 }, (_, i) => ({
    id: 100 - i, status: 'success', trigger: 'manual', commitSha: null, startedAt: ago(i * 3), finishedAt: ago(i * 3), createdAt: ago(i * 3),
  }))
  const res = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      expect(wrapper.findAll('.feed-entry').length).toBe(8)
      expect(wrapper.find('.feed-day').text()).toBe('Today')
      const more = wrapper.findAll('.feed-more button').find(b => b.text().startsWith('Show'))
      // 15 voyages of adm, bob's one, and two "new commits sighted"
      expect(more.text()).toBe('Show 10 more')
      await more.trigger('click')
      await settle()
      expect(wrapper.findAll('.feed-entry').length).toBe(18)
      expect(wrapper.findAll('.feed-more button').map(b => b.text())).toEqual(['Show less'])
      expect(wrapper.find('.feed-cut').exists()).toBe(false) // no tail was cut off
      await wrapper.find('.feed-more button').trigger('click')
      await settle()
      expect(wrapper.findAll('.feed-entry').length).toBe(8)
    },
  })
  expect(res.problems.join(' | ')).toBe('')
})

test('the harbor groups projects by owner for an admin, and not for a tenant', async () => {
  seedStore('admin')
  store.live.users[2].domain = 'bob.dev'
  store.live.projects[2].info.owner_domain = 'bob.dev'
  const admin = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      const heads = wrapper.findAll('.fleet-head').map(h => h.findAll('span').map(x => x.text()).filter(Boolean).join(' '))
      expect(heads).toEqual(['Your fleet 1 vessel', 'bob bob.dev 1 vessel'])
      // bob's project has a finished voyage and unsighted commits: both are his
      expect(wrapper.findAll('.feed-owner').map(o => o.text())).toEqual(['bob ·', 'bob ·'])
      // every entry names its project as a link to it
      const links = wrapper.findAll('.feed-entry a.feed-project')
      expect(links.length).toBe(wrapper.findAll('.feed-entry').length)
      expect(new Set(links.map(a => `${a.text()} ${a.attributes('href')}`))).toEqual(new Set(['adm /projects/1', 'bobapp /projects/2']))
    },
  })
  expect(admin.problems.join(' | ')).toBe('')

  seedStore('tenant')
  const tenant = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      expect(wrapper.findAll('.fleet-head').length).toBe(0)
      expect(wrapper.findAll('.feed-owner').length).toBe(0)
    },
  })
  expect(tenant.problems.join(' | ')).toBe('')
})

// Piers sort each fleet: its piers by name (an empty one too), then the
// projects at no pier under "At anchor" — headed only when there are piers.
// Nobody is shown someone else's pier, and a folded pier hides its vessels.
test('the harbor lists each fleet by pier, an empty pier too, and folds one away', async () => {
  seedStore('admin')
  try { localStorage.clear() } catch { /* no storage: everything starts open */ }
  const admin = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      const piers = wrapper.findAll('.pier').map(p => [p.find('.pier-name').text(), p.findAll('.vessel-row').length])
      expect(piers).toEqual([['Kunder', 1], ['Tomt', 0]])
      expect(wrapper.find('.pier-empty').exists()).toBe(true)
      // bob's fleet has a pier, so his loose project is headed
      expect(wrapper.find('.anchor-head').text()).toContain('At anchor')

      // open, the cards speak for themselves
      expect(wrapper.find('.pier-summary').exists()).toBe(false)
      await wrapper.find('.pier-toggle').trigger('click')
      await settle()
      expect(wrapper.findAll('.pier')[0].findAll('.vessel-row').length).toBe(0)
      expect(wrapper.find('.pier-toggle').attributes('aria-expanded')).toBe('false')
      // folded, the heading says what they would: adm has unsighted commits
      expect(wrapper.find('.pier-summary').text()).toBe('1 with new commits')
      expect(wrapper.find('.pier-state .dot').classes()).toContain('amber')
    },
  })
  expect(admin.problems.join(' | ')).toBe('')

  seedStore('tenant')
  delete store.live.groups[8]
  try { localStorage.clear() } catch { /* as above */ }
  const tenant = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      // no pier of their own: the list is flat, as before piers existed
      expect(wrapper.findAll('.pier').length).toBe(0)
      expect(wrapper.find('.anchor-head').exists()).toBe(false)
      expect(wrapper.findAll('.vessel-row').length).toBe(1)
    },
  })
  expect(tenant.problems.join(' | ')).toBe('')
})

// The pier's actions live behind one "⋯" button: it opens a menu, Escape
// closes it and hands focus back, and an item does its thing.
test("a pier's actions are a menu: open, close with Escape, rename from it", async () => {
  seedStore('admin')
  try { localStorage.clear() } catch { /* everything open */ }
  const res = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      const head = wrapper.findAll('.pier-head')[0]
      expect(head.find('.action-menu-list').exists()).toBe(false)
      const toggle = head.find('.action-menu-toggle')
      expect(toggle.attributes('aria-haspopup')).toBe('menu')

      await toggle.trigger('click')
      await settle()
      const items = head.findAll('[role="menuitem"]')
      expect(items.map(i => i.text())).toEqual(['Deploy all 1', 'Rename…', 'Remove pier…'])
      expect(toggle.attributes('aria-expanded')).toBe('true')

      await head.find('.action-menu-list').trigger('keydown', { key: 'Escape' })
      await settle()
      expect(head.find('.action-menu-list').exists()).toBe(false)

      await toggle.trigger('click')
      await settle()
      await head.findAll('[role="menuitem"]')[1].trigger('click')
      await settle()
      expect(wrapper.findAll('.pier-head')[0].find('.pier-rename input').element.value).toBe('Kunder')
    },
  })
  expect(res.problems.join(' | ')).toBe('')
})

// The panel's own project is never part of a pier deploy: the menu counts
// without it, so the confirmation promises what will actually happen.
test("Deploy all counts the vessels it will deploy, leaving out the panel's own", async () => {
  seedStore('admin')
  Object.assign(store.live.projects[1].info, { runtime: 'pm2', pm2_name: 'skeppa' })
  try { localStorage.clear() } catch { /* everything open */ }
  const res = await expectCleanRender(DashboardView, {
    steps: async wrapper => {
      const head = wrapper.findAll('.pier-head')[0]
      await head.find('.action-menu-toggle').trigger('click')
      await settle()
      const deploy = head.find('[role="menuitem"]')
      expect(deploy.text()).toBe('Deploy all')
      expect(deploy.attributes('disabled')).toBeDefined()
    },
  })
  expect(res.problems.join(' | ')).toBe('')
})

// A row says what the vessel is doing and offers one button only when
// something wants doing; the same states as a folded pier's summary.
describe('a harbor row', () => {
  const rowOf = async (setup, check) => {
    seedStore('admin')
    try { localStorage.clear() } catch { /* everything open */ }
    setup(store.live.projects[1])
    const res = await expectCleanRender(DashboardView, {
      steps: async wrapper => check(wrapper.findAll('.vessel-row').find(r => r.find('.vessel-name').text() === 'adm')),
    })
    expect(res.problems.join(' | ')).toBe('')
  }
  const button = row => row.find('.vessel-actions > button')

  test('new commits: amber, the head commit underneath, Deploy latest', () => rowOf(() => {}, row => {
    expect(row.classes()).toContain('state-ahead')
    expect(row.find('.vessel-status').text()).toBe('new commits')
    expect(row.find('.vessel-l2').text()).toBe('main · bbbbbbb feat: something')
    expect(button(row).text()).toBe('Deploy latest')
    expect(row.find('.vessel-addr').text()).toContain('app.apps.example.com')
  }))

  test('in step: running, uptime and what is deployed, no button', () => rowOf(live => {
    live.headCommit = { sha: 'a'.repeat(40), message: 'x', pushedAt: ISO }
  }, row => {
    expect(row.classes()).toContain('state-running')
    expect(row.find('.vessel-status').text()).toBe('online')
    expect(row.find('.vessel-l2').text()).toMatch(/^main · up .+ · deployed aaaaaaa · /)
    expect(button(row).exists()).toBe(false)
  }))

  test('a failed voyage: Retry, and whether the old build still serves', () => rowOf(live => {
    live.lastDeployment = { ...live.lastDeployment, status: 'failed' }
  }, row => {
    expect(row.classes()).toContain('state-failed')
    expect(row.find('.vessel-l2').text()).toContain('previous build still serving')
    expect(button(row).text()).toBe('Retry deploy')
  }))

  test('down: Start', () => rowOf(live => {
    live.pm2 = { ...live.pm2, status: 'stopped' }
  }, row => {
    expect(row.find('.vessel-status').text()).toBe('stopped')
    expect(button(row).text()).toBe('Start')
  }))

  // adm is at its owner's only pier: the menu offers to leave it, nothing
  // of anyone else's, and moving sends the pier alone.
  test('the ⋯ menu holds the rest, and moves a vessel between piers', () => rowOf(() => {}, async row => {
    await row.find('.action-menu-toggle').trigger('click')
    await settle()
    const menu = row.find('.action-menu-list')
    expect(menu.findAll('[role="menuitem"]').map(i => i.text())).toEqual(
      ['Deploy', 'Open app ↗', 'Restart', 'Stop…', 'Rigging', 'At anchor (no pier)']
    )
    expect(menu.find('.action-menu-heading').text()).toBe('Move to pier')
    const patch = vi.spyOn(api, 'patch')
    await menu.findAll('[role="menuitem"]').at(-1).trigger('click')
    await settle()
    expect(patch).toHaveBeenCalledWith('/api/projects/1', { group_id: null })
    patch.mockRestore()
  }))
})

test('?tab= opens the project page on that tab, and only on a real one', async () => {
  for (const [tab, opens] of [['settings', 'settings'], ['nonsense', 'deploys'], [undefined, 'deploys']]) {
    seedStore('admin')
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: tab ? { tab } : {} },
      steps: async wrapper => expect(wrapper.vm.tab).toBe(opens),
    })
    expect(page.problems.join(' | ')).toBe('')
  }
})

test('the project page names its pier, and the chip leads to Rigging; no pier, no chip', async () => {
  seedStore('admin')
  const grouped = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      const chip = wrapper.find('.pier-chip')
      expect(chip.text()).toBe('pierKunder')
      await chip.trigger('click')
      await settle()
      expect(wrapper.vm.tab).toBe('settings')
    },
  })
  expect(grouped.problems.join(' | ')).toBe('')

  const loose = await expectCleanRender(ProjectView, {
    props: { id: '2' },
    steps: async wrapper => expect(wrapper.find('.pier-chip').exists()).toBe(false),
  })
  expect(loose.problems.join(' | ')).toBe('')
})

test("Rigging offers only the owner's piers, and New pier… asks for a name", async () => {
  seedStore('admin')
  const page = await expectCleanRender(ProjectView, {
    props: { id: '2' }, // bob's project, edited by the admin
    steps: async wrapper => {
      wrapper.vm.tab = 'settings'
      await settle()
      const options = wrapper.findAll('.pier-picker option').map(o => o.text())
      expect(options).toEqual(['No pier — at anchor', 'Tomt', 'New pier…'])
      await wrapper.find('.pier-picker select').setValue('new')
      await settle()
      expect(wrapper.find('.pier-picker input').exists()).toBe(true)
    },
  })
  expect(page.problems.join(' | ')).toBe('')
})

// A static site has no process: the project page drops the process controls
// and the log tab, and Rigging swaps start command and port for the publish
// directory. A tenant picks between a container and a static site.
test('a static project shows no process controls, and its Rigging asks for a publish directory', async () => {
  seedStore('admin')
  Object.assign(store.live.projects[1].info, { runtime: 'static', publish_dir: 'dist', spa_fallback: 1 })
  store.live.projects[1].pm2 = { status: 'published', uptime: null, memory: null, cpu: null, restarts: null, pid: null }
  const page = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      const buttons = wrapper.findAll('button').map(b => b.text())
      for (const gone of ['Start', 'Stop', 'Restart', 'Logbook']) expect(buttons).not.toContain(gone)
      expect(buttons).toContain('Set sail — deploy')
      expect(wrapper.find('.chip.green').text()).toContain('published')

      wrapper.vm.tab = 'settings'
      await settle()
      const labels = wrapper.findAll('label').map(l => l.text())
      expect(labels.some(l => l.startsWith('Publish directory'))).toBe(true)
      expect(labels.some(l => l.startsWith('Single-page app'))).toBe(true)
      expect(labels).not.toContain('Start command')
      expect(labels.some(l => l.startsWith('App port'))).toBe(false)
      expect(labels.some(l => l.startsWith('Memory limit'))).toBe(false)
    },
  })
  expect(page.problems.join(' | ')).toBe('')

  seedStore('tenant')
  const form = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      const runtimes = wrapper.findAll('.segmented button').map(b => b.text())
      expect(runtimes).toEqual(['Container app', 'Static site']) // never a host process
      expect(wrapper.find('.text-link').exists()).toBe(false)
    },
  })
  expect(form.problems.join(' | ')).toBe('')
})

// A runtime saved but not deployed yet changes nothing that is live: the page
// keeps the controls of what is running and says the change is waiting.
test('a pending runtime change keeps the live controls and says so', async () => {
  seedStore('admin')
  Object.assign(store.live.projects[1].info, { runtime: 'static', deployed_runtime: 'container' })
  const pending = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      const buttons = wrapper.findAll('button').map(b => b.text())
      for (const kept of ['Start', 'Stop', 'Restart', 'Logbook']) expect(buttons).toContain(kept) // the container still runs
      const note = wrapper.findAll('p.hint').map(p => p.text().replace(/\s+/g, ' ')).find(t => t.startsWith('Runtime change pending'))
      expect(note).toContain('still served as a container')
      expect(note).toContain('becomes a static site on the next successful deploy')
    },
  })
  expect(pending.problems.join(' | ')).toBe('')

  seedStore('admin')
  Object.assign(store.live.projects[1].info, { runtime: 'container', deployed_runtime: 'container' })
  const settled = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      expect(wrapper.findAll('p.hint').some(p => p.text().startsWith('Runtime change pending'))).toBe(false)
    },
  })
  expect(settled.problems.join(' | ')).toBe('')
})

// The deploy script and start command start empty — nothing runs that was
// not chosen — with the suggestion one click away.
test('the new-project form offers its suggestions as one-click values', async () => {
  seedStore('admin')
  const { problems } = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.vm.form.deploy_script).toBe('')
      expect(wrapper.vm.form.start_command).toBe('')
      const offers = () => wrapper.findAll('p.suggest button')
      expect(offers().map(b => b.text().replace(/\s+/g, ' '))).toEqual(['Use bun install && bun run build', 'Use bun run start'])
      expect(wrapper.find('textarea').attributes('placeholder')).toBe('bun install && bun run build')

      await offers()[0].trigger('click')
      expect(wrapper.vm.form.deploy_script).toBe('bun install && bun run build')
      expect(offers().map(b => b.text())).toEqual(['Use bun run start']) // a filled field needs no offer
      await offers()[0].trigger('click')
      expect(wrapper.vm.form.start_command).toBe('bun run start')
      expect(offers().length).toBe(0)

      // clearing a field brings its offer back; a static site has no start command
      // to offer, but offers where builds usually put a site instead of dist
      await wrapper.find('textarea').setValue('')
      wrapper.vm.form.runtime = 'static'
      await settle()
      expect(offers().map(b => b.text().replace(/\s+/g, ' '))).toEqual(['Use bun install && bun run build', 'Use web/dist', 'Use client/dist'])
      await offers()[1].trigger('click')
      expect(wrapper.vm.form.publish_dir).toBe('web/dist')
      expect(offers().map(b => b.text().replace(/\s+/g, ' ')).slice(1)).toEqual(['Use dist', 'Use client/dist'])
    },
  })
  expect(problems.join(' | ')).toBe('')
})

// Removing someone who still owns projects opens the move: their projects go
// to you unless you pick someone else, and the plan is on screen first.
test('removing a crew member who owns projects offers to move them, showing what changes', async () => {
  seedStore('admin')
  const { problems } = await expectCleanRender(SettingsView, {
    steps: async wrapper => {
      const bobRow = wrapper.findAll('.crew-member').find(m => m.find('.crew-name').text() === 'bob')
      await bobRow.find('button.danger').trigger('click')
      await settle()
      const move = bobRow.find('.crew-move')
      expect(move.exists()).toBe(true)
      expect(move.text()).toContain('bob owns 1 project (bobapp)')
      expect(move.find('select').element.value).toBe('1') // you, by default
      expect(move.text().replace(/\s+/g, ' ')).toContain('bobapp moves from https://app.bob.apps.example.com to https://app.apps.example.com')
      const go = move.findAll('button').find(b => b.text().startsWith('Move it and remove bob'))
      expect(go.attributes('disabled')).toBeUndefined()
      await bobRow.find('button.danger').trigger('click') // Cancel
      expect(bobRow.find('.crew-move').exists()).toBe(false)
    },
  })
  expect(problems.join(' | ')).toBe('')
})

// A new project is a container by default; pm2 waits behind a link for an
// admin and does not exist for a tenant. A panel with no engine at all
// defaults an admin to pm2 instead of a deploy that cannot work.
test('the new-project form defaults to a container and keeps pm2 behind a link', async () => {
  const labels = wrapper => wrapper.findAll('.segmented button').map(b => b.text())

  seedStore('admin')
  const admin = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.vm.form.runtime).toBe('container')
      expect(labels(wrapper)).toEqual(['Container app', 'Static site'])
      await wrapper.find('.text-link').trigger('click')
      expect(labels(wrapper)).toEqual(['Container app', 'Static site', 'Host process (pm2)'])
      await wrapper.findAll('.segmented button')[1].trigger('click')
      expect(wrapper.vm.form.runtime).toBe('static')
    },
  })
  expect(admin.problems).toEqual([])

  seedStore('admin')
  store.live.system.containerSocket = ''
  const bare = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.vm.form.runtime).toBe('pm2')
      expect(labels(wrapper)).toContain('Host process (pm2)')
    },
  })
  expect(bare.problems).toEqual([])

  seedStore('tenant')
  const tenant = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.vm.form.runtime).toBe('container')
      expect(labels(wrapper)).toEqual(['Container app', 'Static site'])
      expect(wrapper.find('.text-link').exists()).toBe(false)
    },
  })
  expect(tenant.problems).toEqual([])
})

// An app can have the gate serve its build output: the checkbox brings the
// publish directory with it, and the routing preview says files come first.
test('a container app can let the gate serve its build, which asks for a publish directory', async () => {
  seedStore('admin')
  store.live.proxy.baseDomain = 'apps.example.com'
  const { problems } = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      const publishField = () => wrapper.findAll('label').some(l => l.text().startsWith('Publish directory'))
      expect(wrapper.vm.form.runtime).toBe('container')
      expect(publishField()).toBe(false)
      const box = wrapper.findAll('label.check-label').find(l => l.text().includes("serve the build's files"))
      await box.find('input').setValue(true)
      expect(wrapper.vm.form.gate_files).toBe(true)
      expect(publishField()).toBe(true)
      wrapper.vm.form.subdomain = 'shop'
      wrapper.vm.form.port = '4321'
      await settle()
      expect(wrapper.text()).toContain("→ the build's files, then localhost:4321")
      // a static site has no such option — it is files only
      wrapper.vm.form.runtime = 'static'
      await settle()
      expect(wrapper.text()).not.toContain("serve the build's files")
    },
  })
  expect(problems.join(' | ')).toBe('')
})
