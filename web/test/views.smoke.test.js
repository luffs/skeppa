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
import { dialogState, settleDialog } from '../src/lib/dialog.js'
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
  // every test starts on the list, whatever an earlier one chose
  try { localStorage.removeItem('skeppa.harborView') } catch { /* no storage: the list anyway */ }
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
async function expectCleanRender(component, { props = {}, steps = async () => {}, route = {}, router = {} } = {}) {
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
        mocks: { $route: { path: '/', query: {}, params: {}, ...route }, $router: { push() {}, replace() {}, ...router } },
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
// What a button says on screen: a StableLabel lays out every label it can
// show, all but one hidden, so its text() would be all of them at once.
const visibleText = b => {
  const shown = b.find('.stable-label > span:not(.stable-ghost)')
  return shown.exists() ? shown.text() : b.text()
}
// Every control a project page offers: its buttons, and what its header's ⋯ holds.
async function pageControls(wrapper) {
  await wrapper.find('.project-head .action-menu-toggle').trigger('click')
  await settle()
  const controls = wrapper.findAll('button').map(visibleText)
  await wrapper.find('.project-head .action-menu-toggle').trigger('click') // closed again
  await settle()
  return controls
}

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
      // every entry names its project as a link — a voyage straight to its log
      const links = wrapper.findAll('.feed-entry a.feed-project')
      expect(links.length).toBe(wrapper.findAll('.feed-entry').length)
      expect(new Set(links.map(a => `${a.text()} ${a.attributes('href')}`))).toEqual(new Set([
        'adm /projects/1?deployment=1', 'adm /projects/1', 'bobapp /projects/2?deployment=2', 'bobapp /projects/2',
      ]))
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
// Search and the state filter narrow the harbor: what does not match goes,
// piers with no match go, piers with one open (folded or not), the log
// follows, and both live in the URL.
// The harbor as a map: piers as jetties, projects as ships, the same states,
// the same row on hover, and the filter dimming instead of thinning out.
describe('the harbor map', () => {
  for (const role of ['admin', 'tenant']) {
    test(`renders for ${role === 'admin' ? 'an admin' : 'a tenant'}, every vessel a ship`, async () => {
      seedStore(role)
      const res = await expectCleanRender(DashboardView, {
        route: { query: { view: 'map' } },
        steps: async wrapper => {
          const ships = wrapper.findAll('.hm-ship').map(s => s.attributes('aria-label'))
          expect(ships).toEqual(role === 'admin' ? ['adm, online', 'bobapp, online'] : ['bobapp, online'])
          expect(wrapper.find('.vessel-row').exists()).toBe(false) // no list underneath
          expect(wrapper.findAll('.hm-pier-name').map(t => t.text())).toEqual(role === 'admin' ? ['Kunder', 'Tomt'] : ['Tomt'])
        },
      })
      expect(res.problems.join(' | ')).toBe('')
    })
  }

  test('List | Harbor switches, remembered and in the URL', async () => {
    seedStore('admin')
    try { localStorage.clear() } catch { /* starts as a list */ }
    const replaced = []
    const res = await expectCleanRender(DashboardView, {
      router: { replace: to => replaced.push(to.query) },
      steps: async wrapper => {
        expect(wrapper.find('.harbor-map').exists()).toBe(false)
        await wrapper.findAll('.harbor-view button').find(b => b.text() === 'Harbor').trigger('click')
        await settle()
        expect(wrapper.find('.harbor-map').exists()).toBe(true)
        expect(replaced.at(-1)).toEqual({ view: 'map' })
        expect(localStorage.getItem('skeppa.harborView')).toBe('map')
        // nothing to fold on a map
        expect(wrapper.findAll('.harbor-tools button').some(b => /Fold all/.test(visibleText(b)))).toBe(false)
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('a ship shows its state and cargo, brings up its row, and leads to its project', async () => {
    seedStore('admin')
    const pushed = []
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      router: { push: to => pushed.push(to) },
      steps: async wrapper => {
        const adm = wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith('adm'))
        expect(adm.classes()).toEqual(expect.arrayContaining(['state-ahead', 'rt-container'])) // new commits; a container ship
        expect(adm.findAll('.hm-cargo rect').length).toBe(3) // three places on deck…
        expect(adm.findAll('.hm-cargo rect.laden').length).toBe(1) // …one stack on them: 40 MB of 512
        expect(adm.find('.hm-pennant').exists()).toBe(true) // new commits waiting
        expect(adm.find('title').text()).toBe('adm — online · 40.0 MB of 512 MB memory')
        await adm.trigger('mouseenter')
        await settle()
        expect(wrapper.find('.harbor-card .vessel-name').text()).toBe('adm')
        expect(visibleText(wrapper.find('.harbor-card .vessel-actions > button'))).toBe('Deploy latest')
        await adm.trigger('click')
        expect(pushed).toEqual(['/projects/1'])
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('the filter dims what does not match, and the harbor keeps its shape', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map', q: 'bob' } },
      steps: async wrapper => {
        const ships = wrapper.findAll('.hm-ship')
        expect(ships.length).toBe(2) // nothing taken away
        expect(ships.map(s => [s.attributes('aria-label').split(',')[0], s.classes().includes('dim')])).toEqual([['adm', true], ['bobapp', false]])
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('the map takes the whole width, the log under it', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      steps: async wrapper => {
        expect(wrapper.find('.harbor-layout').classes()).not.toContain('as-map')
        await wrapper.findAll('.harbor-view button').find(b => b.text() === 'Harbor').trigger('click')
        await settle()
        expect(wrapper.find('.harbor-layout').classes()).toContain('as-map')
        expect(wrapper.find('.harbor-layout .feed-panel').exists()).toBe(true) // still there
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  // Under the map the log is a table — a line per entry, a column per
  // particular — where the window is wide enough; the list it is otherwise.
  test('under the map the log is ruled like a logbook, and a list again on a narrow window', async () => {
    seedStore('admin')
    const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
    const wide = await expectCleanRender(DashboardView, {
      steps: async wrapper => {
        expect(wrapper.find('.feed-table').exists()).toBe(false) // the list keeps its log as it was
        expect(wrapper.findAll('.feed-entry').length).toBe(4)
        await wrapper.findAll('.harbor-view button').find(b => b.text() === 'Harbor').trigger('click')
        await settle()
        expect(wrapper.findAll('.feed-entry').length).toBe(0)
        expect(wrapper.findAll('.feed-table thead th').map(h => h.text())).toEqual(['Time', 'Vessel', 'Event', 'Trigger', 'Commit', 'Took'])
        expect(wrapper.find('.feed-table .feed-day').text()).toBe('Today')
        // adm's and bobapp's voyage and unsighted commits: four lines, the same entries
        const rows = wrapper.findAll('.feed-row').map(r => r.findAll('td').slice(2).map(c => c.text().replace(/\s+/g, ' ')))
        expect(rows).toEqual(expect.arrayContaining([
          ['adm', '#1 made port', 'manual', 'aaaaaaa', '0.0s'],
          ['adm', 'new commits on main', 'push', 'bbbbbbb', ''],
          ['bob · bobapp', '#2 made port', 'manual', 'aaaaaaa', '0.0s'],
          ['bob · bobapp', 'new commits on main', 'push', 'bbbbbbb', ''],
        ]))
        expect(rows.length).toBe(4)
        expect(wrapper.findAll('.feed-row .dot').map(d => d.classes().filter(c => c !== 'dot').join(' ')).sort()).toEqual(['amber', 'amber', 'green', 'green'])
        // the vessel is the link, a voyage straight to its log
        expect(wrapper.findAll('.feed-row a.feed-project').map(a => a.attributes('href')).sort()).toEqual([
          '/projects/1', '/projects/1?deployment=1', '/projects/2', '/projects/2?deployment=2',
        ])
      },
    })
    expect(wide.problems.join(' | ')).toBe('')

    media.mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    const narrow = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        expect(wrapper.find('.feed-table').exists()).toBe(false)
        expect(wrapper.findAll('.feed-entry').length).toBe(4)
      },
    })
    media.mockRestore()
    expect(narrow.problems.join(' | ')).toBe('')
  })

  test('the legend counts every state, names the ships in the harbor, and filters', async () => {
    seedStore('admin')
    store.live.projects[2].info.runtime = 'static'
    store.live.projects[2].pm2.status = 'published'
    store.live.projects[2].headCommit.sha = 'a'.repeat(40) // nothing new: running
    const replaced = []
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      router: { replace: to => replaced.push(to.query) },
      steps: async wrapper => {
        const keys = () => wrapper.findAll('.hm-key')
        const said = k => k.text().replace(/\s+/g, ' ')
        expect(keys().map(said)).toEqual(['running1', 'new commits1', 'down or failed0', 'under way0', 'idle0'])
        expect(keys().map(k => k.attributes('disabled') != null)).toEqual([false, false, true, true, true]) // nothing to show: nothing to click
        // a container ship and a sailing boat in this harbor, no tug
        expect(wrapper.findAll('.hm-kind').map(k => k.text())).toEqual(['containera stack per third of its memory in use', 'static site'])
        expect(wrapper.findAll('.hm-kind .hm-cargo rect.laden').length).toBe(3) // the legend's ship is fully laden
        expect(wrapper.findAll('.hm-kind .hm-sail').length).toBe(2)

        await keys()[1].trigger('click') // new commits
        await settle()
        expect(replaced.at(-1)).toEqual({ view: 'map', state: 'ahead' })
        expect(keys()[1].attributes('aria-pressed')).toBe('true')
        expect(wrapper.find('.filter-chip').text()).toContain('new commits')
        expect(wrapper.findAll('.hm-ship').map(s => [s.attributes('aria-label').split(',')[0], s.classes().includes('dim')])).toEqual([['adm', false], ['bobapp', true]])

        await keys()[1].trigger('click') // and off again
        await settle()
        expect(replaced.at(-1)).toEqual({ view: 'map' })
        expect(wrapper.findAll('.hm-ship.dim').length).toBe(0)
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('a legend filter with nothing left says so in words', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map', state: 'idle' } },
      steps: async wrapper => {
        expect(wrapper.find('.harbor-none').text()).toContain('among those that are idle')
        expect(wrapper.findAll('.hm-key').at(-1).attributes('disabled')).toBeUndefined() // the one in force can be switched off
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('the cargo follows the memory in use, and restarts leave their marks', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        const adm = () => wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith('adm'))
        expect(adm().find('.hm-scuffs').exists()).toBe(false)
        store.live.projects[1].pm2.memory = 400 * 1024 * 1024
        store.live.projects[1].pm2.restarts = 4
        await settle()
        expect(adm().findAll('.hm-cargo rect.laden').length).toBe(3)
        expect(adm().find('.hm-scuffs').exists()).toBe(true)
        expect(adm().find('title').text()).toBe('adm — online · 400.0 MB of 512 MB memory · restarted 4 times since its last deploy')
        // stopped: nothing on deck
        store.live.projects[1].pm2.status = 'stopped'
        await settle()
        expect(adm().findAll('.hm-cargo rect.laden').length).toBe(0)
        expect(adm().findAll('.hm-cargo rect').length).toBe(3)
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  // Dragging: a press on a ship, the pointer moved over the map (happy-dom
  // lays nothing out, so the pointer's place is the map's own units), a release.
  const pointer = (type, x, y) => Object.assign(new Event(type, { bubbles: true }), { clientX: x, clientY: y, button: 0, pointerType: 'mouse' })
  const dragging = wrapper => {
    const ship = name => wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label')?.startsWith(name))
    const pier = name => {
      const g = wrapper.findAll('.hm-jetty-g').find(j => j.find('.hm-pier-name').text() === name)
      return { g, x: Number(g.find('.hm-jetty').attributes('x')) + 8, y: Number(g.find('.hm-jetty').attributes('y')) + 3 }
    }
    const lies = name => {
      const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(ship(name).attributes('style'))
      return { x: Number(x), y: Number(y) }
    }
    const press = name => ship(name).element.dispatchEvent(pointer('pointerdown', lies(name).x + 20, lies(name).y + 10))
    const move = async (x, y) => { window.dispatchEvent(pointer('pointermove', x, y)); await settle() }
    // the release, and the click a browser sends the ship after it
    const release = async name => {
      window.dispatchEvent(pointer('pointerup', 0, 0))
      await ship(name).trigger('click')
      await settle()
    }
    return { ship, pier, lies, press, move, release }
  }

  test('a ship dragged to another of its fleet’s piers moors there, and the release is no visit', async () => {
    seedStore('admin')
    const patch = vi.spyOn(api, 'patch')
    const pushed = []
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      router: { push: to => pushed.push(to) },
      steps: async wrapper => {
        const { ship, pier, lies, press, move, release } = dragging(wrapper)
        expect(wrapper.find('.hm-drag-tip').exists()).toBe(true)
        const from = lies('bobapp') // bob's, at anchor
        press('bobapp')
        await move(from.x + 22, from.y + 11) // a nudge is still a click
        expect(wrapper.find('.hm-ghost').exists()).toBe(false)

        await move(pier('Tomt').x - 30, pier('Tomt').y + 20) // over bob's own pier
        expect(wrapper.find('.hm-ghost .hm-name').text()).toBe('bobapp')
        expect(wrapper.find('.hm-ghost .hm-lift').exists()).toBe(true) // its shadow drawn below it, no filter
        expect(wrapper.find('.hm-drop-hint').text()).toBe('Moor at Tomt')
        expect(pier('Tomt').g.classes()).toEqual(expect.arrayContaining(['can-drop', 'drop-on']))
        expect(pier('Kunder').g.classes()).not.toContain('can-drop') // the admin's: not this ship's to moor at
        expect(wrapper.find('.hm-slot').exists()).toBe(true)
        expect(ship('bobapp').classes()).toContain('lifted')
        expect(wrapper.find('.harbor-card').exists()).toBe(false)

        await release('bobapp')
        expect(patch).toHaveBeenLastCalledWith('/api/projects/2', { group_id: 8 })
        expect(pushed).toEqual([])
        expect(wrapper.find('.hm-ghost').exists()).toBe(false)
        expect(ship('bobapp').classes()).not.toContain('lifted')

        // and a plain click is a visit again
        await ship('bobapp').trigger('click')
        expect(pushed).toEqual(['/projects/2'])
      },
    })
    patch.mockRestore()
    expect(res.problems.join(' | ')).toBe('')
  })

  test('let go over its fleet’s open water a ship leaves its pier; another fleet’s pier refuses it; Escape puts it back', async () => {
    seedStore('admin')
    const patch = vi.spyOn(api, 'patch')
    const pushed = []
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      router: { push: to => pushed.push(to) },
      steps: async wrapper => {
        const { pier, press, move, release } = dragging(wrapper)
        const kunder = pier('Kunder') // adm lies here, the admin's only pier

        // out into the water beside its pier
        press('adm')
        await move(kunder.x + 300, kunder.y + 40)
        expect(wrapper.find('.hm-drop-hint').text()).toBe('Leave at anchor')
        expect(wrapper.find('.hm-anchor-here').classes()).toContain('drop-on') // no anchorage in this fleet yet: the water says what it is
        expect(wrapper.find('.hm-slot').exists()).toBe(false)
        await release('adm')
        expect(patch).toHaveBeenLastCalledWith('/api/projects/1', { group_id: null })
        expect(patch).toHaveBeenCalledTimes(1)

        // onto bob's pier: refused, and nothing is asked of the server
        press('adm')
        await move(pier('Tomt').x, pier('Tomt').y + 20)
        expect(wrapper.find('.hm-ghost').classes()).toContain('refused')
        expect(wrapper.find('.hm-drop-hint').text()).toContain('only its own piers')
        expect(pier('Tomt').g.classes()).not.toContain('can-drop')
        await release('adm')
        expect(patch).toHaveBeenCalledTimes(1)

        // back onto its own pier: nothing to do
        press('adm')
        await move(kunder.x + 300, kunder.y + 40)
        await move(kunder.x + 40, kunder.y + 30)
        expect(wrapper.find('.hm-drop-hint').exists()).toBe(false)
        await release('adm')
        expect(patch).toHaveBeenCalledTimes(1)

        // Escape mid-drag
        press('adm')
        await move(kunder.x + 300, kunder.y + 40)
        window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
        await settle()
        expect(wrapper.find('.hm-ghost').exists()).toBe(false)
        await release('adm')
        expect(patch).toHaveBeenCalledTimes(1)
        expect(pushed).toEqual([])
      },
    })
    patch.mockRestore()
    expect(res.problems.join(' | ')).toBe('')
  })

  test('what happens while the map is open shows on the water', async () => {
    seedStore('admin')
    const A = 'a'.repeat(40)
    store.live.projects[1].currentDeployment = { id: 9, status: 'running' }
    store.live.projects[2].lastDeployment.status = 'failed' // failed before the map was opened
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        const ship = name => wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith(name))
        // how things already were is no event
        expect(wrapper.find('.hm-event').exists()).toBe(false)
        expect(ship('adm').find('.hm-berth').attributes('style')).toContain('translateX(-7px)') // cast off, bow first

        // the voyage ends well: back at its berth, rings on the water
        Object.assign(store.live.projects[1], { currentDeployment: null, deployedSha: A, headCommit: { sha: A }, lastDeployment: { id: 9, status: 'success' } })
        await settle()
        expect(ship('adm').classes()).toContain('state-running')
        expect(ship('adm').find('.hm-berth').attributes('style')).toContain('translateX(0px)')
        expect(ship('adm').find('.hm-event').classes()).toContain('arrived')
        expect(ship('adm').find('.hm-flare').exists()).toBe(false)

        // new commits come in: a pennant, and amber rings
        store.live.projects[1].headCommit = { sha: 'c'.repeat(40) }
        await settle()
        expect(ship('adm').find('.hm-pennant').exists()).toBe(true)
        expect(ship('adm').find('.hm-event').classes()).toContain('hail')

        // the next voyage fails: a flare
        store.live.projects[1].currentDeployment = { id: 10, status: 'running' }
        await settle()
        Object.assign(store.live.projects[1], { currentDeployment: null, lastDeployment: { id: 10, status: 'failed' } })
        await settle()
        expect(ship('adm').find('.hm-event').classes()).toContain('flare')
        expect(ship('adm').find('.hm-flare').exists()).toBe(true)
        expect(ship('bobapp').find('.hm-event').exists()).toBe(false) // only the ship it happened to
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('a voyage under way casts off with a wake', async () => {
    seedStore('admin')
    store.live.projects[1].currentDeployment = { id: 9, status: 'running' }
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        const adm = wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith('adm'))
        expect(adm.classes()).toContain('state-underway')
        expect(adm.find('.hm-wake').exists()).toBe(true)
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('the ships are one tab stop: the arrow keys go between them, Escape puts the card away', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        const ship = name => wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith(name))
        expect(ship('adm').attributes('tabindex')).toBe('0')
        expect(ship('bobapp').attributes('tabindex')).toBe('-1')
        await ship('adm').trigger('focus')
        await ship('adm').trigger('keydown', { key: 'ArrowDown' }) // bob's fleet lies below
        await settle()
        expect(ship('bobapp').attributes('tabindex')).toBe('0')
        expect(ship('adm').attributes('tabindex')).toBe('-1')
        await ship('bobapp').trigger('focus')
        await settle()
        expect(wrapper.find('.harbor-card .vessel-name').text()).toBe('bobapp')
        await wrapper.find('.harbor-card').trigger('keydown', { key: 'Escape' })
        await settle()
        expect(ship('bobapp').attributes('tabindex')).toBe('0')
        await ship('bobapp').trigger('keydown', { key: 'Escape' })
        await settle()
        expect(wrapper.find('.harbor-card').exists()).toBe(false)
        await ship('bobapp').trigger('keydown', { key: 'Home' })
        await settle()
        expect(ship('adm').attributes('tabindex')).toBe('0')
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('a finger: the first tap brings up the card, the second opens the project', async () => {
    seedStore('admin')
    const pushed = []
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      router: { push: to => pushed.push(to) },
      steps: async wrapper => {
        const adm = wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith('adm'))
        const tap = async () => {
          await adm.trigger('pointerdown', { pointerType: 'touch', button: 0 })
          window.dispatchEvent(new Event('pointerup'))
          await adm.trigger('click')
          await settle()
        }
        await tap()
        expect(pushed).toEqual([])
        expect(wrapper.find('.harbor-card .vessel-name').text()).toBe('adm')
        await tap()
        expect(pushed).toEqual(['/projects/1'])
        // a mouse opens at once
        await wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith('bobapp')).trigger('click')
        expect(pushed).toEqual(['/projects/1', '/projects/2'])
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('an admin folds a fleet to its quay, remembered; a search opens it again', async () => {
    seedStore('admin')
    try { localStorage.removeItem('skeppa.foldedFleets') } catch { /* nothing folded */ }
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        const folds = wrapper.findAll('.hm-fold')
        expect(folds.map(b => b.attributes('aria-label'))).toEqual(['Fold Your fleet', 'Fold bob'])
        await folds[1].trigger('click')
        await settle()
        expect(wrapper.findAll('.hm-ship').map(s => s.attributes('aria-label'))).toEqual(['adm, online'])
        expect(wrapper.findAll('.hm-fold')[1].attributes('aria-expanded')).toBe('false')
        expect(wrapper.findAll('.hm-fleet-summary').map(t => t.text())).toEqual(['1 ship', '· 1 need attention']) // bobapp has new commits
        expect(JSON.parse(localStorage.getItem('skeppa.foldedFleets'))).toEqual(['2'])
      },
    })
    expect(res.problems.join(' | ')).toBe('')

    // still folded next time; a search that finds bob's ship opens the fleet
    seedStore('admin')
    const again = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map', q: 'bobapp' } },
      steps: async wrapper => {
        expect(wrapper.findAll('.hm-ship').map(s => s.attributes('aria-label'))).toContain('bobapp, online')
        expect(wrapper.findAll('.hm-fold')[1].attributes('title')).toMatch(/Opened for the search/)
      },
    })
    expect(again.problems.join(' | ')).toBe('')
    try { localStorage.removeItem('skeppa.foldedFleets') } catch { /* clean */ }
  })

  test('a tenant has one fleet: nothing to fold', async () => {
    seedStore('tenant')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => { expect(wrapper.find('.hm-fold').exists()).toBe(false) },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('out of sight, the map stands still', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { view: 'map' } },
      steps: async wrapper => {
        expect(wrapper.find('.harbor-map').classes()).not.toContain('asleep')
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await settle()
        expect(wrapper.find('.harbor-map').classes()).toContain('asleep')
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await settle()
        expect(wrapper.find('.harbor-map').classes()).not.toContain('asleep')
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  // The swell, the swing at anchor and the pennant are SMIL (a composited CSS
  // transform animation leaves the ships soft): out of sight the SVG's own
  // clock stops, and asked for less motion there is none to stop.
  test('the ships ride the swell in SMIL, its clock stopped out of sight and gone with reduced motion', async () => {
    seedStore('admin')
    const proto = window.SVGSVGElement.prototype
    const calls = []
    const saved = { pause: proto.pauseAnimations, unpause: proto.unpauseAnimations }
    proto.pauseAnimations = () => calls.push('pause')
    proto.unpauseAnimations = () => calls.push('unpause')
    try {
      const res = await expectCleanRender(DashboardView, {
        route: { query: { view: 'map' } },
        steps: async wrapper => {
          const ship = name => wrapper.findAll('.hm-ship').find(s => s.attributes('aria-label').startsWith(`${name},`))
          expect(ship('adm').findAll('.hm-bob > animateTransform').map(a => a.attributes('type'))).toEqual(['translate', 'rotate'])
          expect(ship('adm').find('.hm-flag animateTransform').attributes('type')).toBe('skewY')
          expect(ship('bobapp').find('.hm-sway > animateTransform').attributes('type')).toBe('rotate') // at anchor
          expect(ship('adm').find('.hm-sway > animateTransform').exists()).toBe(false) // moored
          // the waves drift as their pattern moves; the lighthouse's beam goes round
          expect(wrapper.find('#hm-waves > animateTransform').attributes('attributeName')).toBe('patternTransform')
          expect(wrapper.find('.hm-beam > animateTransform').attributes('type')).toBe('rotate')
          expect(calls.at(-1)).toBe('unpause')
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
          document.dispatchEvent(new Event('visibilitychange'))
          await settle()
          expect(calls.at(-1)).toBe('pause')
          Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
          document.dispatchEvent(new Event('visibilitychange'))
          await settle()
          expect(calls.at(-1)).toBe('unpause')
        },
      })
      expect(res.problems.join(' | ')).toBe('')

      const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} }))
      const calm = await expectCleanRender(DashboardView, {
        route: { query: { view: 'map' } },
        steps: async wrapper => {
          expect(wrapper.find('.hm-ship').exists()).toBe(true)
          expect(wrapper.find('.hm-svg animateTransform').exists()).toBe(false)
        },
      })
      media.mockRestore()
      expect(calm.problems.join(' | ')).toBe('')
    } finally {
      proto.pauseAnimations = saved.pause
      proto.unpauseAnimations = saved.unpause
    }
  })
})

describe('filtering the harbor', () => {
  const names = w => w.findAll('.vessel-row .vessel-name').map(n => n.text())

  test('search narrows rows, piers and the log, and opens a folded pier with a match', async () => {
    seedStore('admin')
    try { localStorage.setItem('skeppa.collapsedPiers', '[7]') } catch { /* folded or not, it opens */ }
    const replaced = []
    const res = await expectCleanRender(DashboardView, {
      router: { replace: to => replaced.push(to.query) },
      steps: async wrapper => {
        expect(names(wrapper)).toEqual(['bobapp']) // Kunder (adm's pier) is folded
        await wrapper.find('.harbor-search input').setValue('kund')
        await settle()
        expect(names(wrapper)).toEqual(['adm']) // matched by its pier's name, the fold set aside
        expect(wrapper.findAll('.pier .pier-name').map(n => n.text())).toEqual(['Kunder']) // Tomt has no match
        expect(wrapper.find('.harbor-count').text()).toBe('1 of 2')
        expect(wrapper.find('.feed-head').text()).toContain('1 project')
        expect(wrapper.findAll('.feed-entry .feed-project').every(a => a.text() === 'adm')).toBe(true)
        expect(replaced.at(-1)).toEqual({ q: 'kund' })
        // no fold-all while filtering: every pier with a match is open anyway
        expect(wrapper.findAll('.harbor-tools button').some(b => /Fold all|Unfold all/.test(visibleText(b)))).toBe(false)

        await wrapper.find('.harbor-search input').setValue('nothing-like-it')
        await settle()
        expect(wrapper.find('.harbor-none').text()).toContain('No vessel matches “nothing-like-it”')
        await wrapper.find('.harbor-none .link-button').trigger('click')
        await settle()
        expect(names(wrapper)).toEqual(['bobapp']) // the remembered fold is back
        expect(replaced.at(-1)).toEqual({})
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('the summary\'s counts are filters, with a chip to clear them', async () => {
    seedStore('admin')
    store.live.projects[2].headCommit = { sha: 'a'.repeat(40), message: 'x', pushedAt: ISO } // bobapp in step
    try { localStorage.clear() } catch { /* all open */ }
    const res = await expectCleanRender(DashboardView, {
      steps: async wrapper => {
        const [running, attention] = wrapper.findAll('.summary-filter')
        expect(running.text()).toBe('1 running')
        expect(attention.text()).toBe('1 needs attention')
        await attention.trigger('click')
        await settle()
        expect(names(wrapper)).toEqual(['adm'])
        expect(wrapper.find('.filter-chip').text()).toContain('need attention')
        await running.trigger('click') // another count switches the filter
        await settle()
        expect(names(wrapper)).toEqual(['bobapp'])
        await wrapper.find('.filter-chip-clear').trigger('click')
        await settle()
        expect(names(wrapper).sort()).toEqual(['adm', 'bobapp'])
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('the URL starts the harbor filtered', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      route: { query: { q: 'bob', state: 'attention' } },
      steps: async wrapper => {
        expect(wrapper.find('.harbor-search input').element.value).toBe('bob')
        expect(names(wrapper)).toEqual(['bobapp'])
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('Fold all and Unfold all, remembered like a pier\'s own fold', async () => {
    seedStore('admin')
    try { localStorage.clear() } catch { /* all open */ }
    const res = await expectCleanRender(DashboardView, {
      steps: async wrapper => {
        const toggle = () => wrapper.findAll('.harbor-tools button').find(b => /Fold all|Unfold all/.test(visibleText(b)))
        expect(visibleText(toggle())).toBe('Fold all')
        await toggle().trigger('click')
        await settle()
        expect(wrapper.findAll('.pier-toggle').every(t => t.attributes('aria-expanded') === 'false')).toBe(true)
        expect(visibleText(toggle())).toBe('Unfold all')
        expect(JSON.parse(localStorage.getItem('skeppa.collapsedPiers')).sort()).toEqual([7, 8])
        await toggle().trigger('click')
        await settle()
        expect(wrapper.findAll('.pier-toggle').every(t => t.attributes('aria-expanded') === 'true')).toBe(true)
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })

  test('/ jumps to the search, unless one is typing', async () => {
    seedStore('admin')
    const res = await expectCleanRender(DashboardView, {
      steps: async wrapper => {
        const focus = vi.spyOn(wrapper.find('.harbor-search input').element, 'focus')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))
        expect(focus).toHaveBeenCalledTimes(1)
        // typed into a field, / is just a character
        const typing = document.createElement('input')
        document.body.appendChild(typing)
        typing.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
        expect(focus).toHaveBeenCalledTimes(1)
        typing.remove()
      },
    })
    expect(res.problems.join(' | ')).toBe('')
  })
})

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
      // a word, not the rows' ⋯: this menu is about every vessel at the pier
      expect(toggle.text().replace(/\s+/g, '')).toBe('Orders▾')
      expect(wrapper.find('.vessel-row .action-menu-toggle').classes()).toContain('kebab')
      expect(wrapper.find('.vessel-row .action-menu-toggle').findAll('svg circle').length).toBe(3)

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
  const rowOf = async (setup, check, { router = {} } = {}) => {
    seedStore('admin')
    try { localStorage.clear() } catch { /* everything open */ }
    setup(store.live.projects[1])
    const res = await expectCleanRender(DashboardView, {
      router,
      steps: async wrapper => check(wrapper.findAll('.vessel-row').find(r => r.find('.vessel-name').text() === 'adm')),
    })
    expect(res.problems.join(' | ')).toBe('')
  }
  const button = row => row.find('.vessel-actions > button')

  test('new commits: amber, the head commit underneath, Deploy latest', () => rowOf(() => {}, row => {
    expect(row.classes()).toContain('state-ahead')
    expect(row.find('.vessel-status').text()).toBe('new commits')
    expect(row.find('.vessel-l2').text()).toBe('bbbbbbb feat: something')
    expect(row.find('.vessel-l2 code').text()).toBe('bbbbbbb') // the commit id set as code, the rest a sentence
    expect(row.find('.vessel-branch').exists()).toBe(false) // main: nothing to say
    expect(button(row).text()).toBe('Deploy latest')
    expect(row.find('.vessel-row-addr').text()).toContain('app.apps.example.com')
  }))

  test('in step: running, uptime and what is deployed, no button', () => rowOf(live => {
    live.headCommit = { sha: 'a'.repeat(40), message: 'x', pushedAt: ISO }
  }, row => {
    expect(row.classes()).toContain('state-running')
    expect(row.find('.vessel-status').text()).toBe('online')
    expect(row.find('.vessel-l2').text()).toMatch(/^Up .+ · deployed aaaaaaa \d+[smhd] ago$/)
    expect(button(row).exists()).toBe(false)
  }))

  test('a failed voyage: Retry, and whether the old build still serves', () => rowOf(live => {
    live.lastDeployment = { ...live.lastDeployment, status: 'failed' }
  }, row => {
    expect(row.classes()).toContain('state-failed')
    expect(row.find('.vessel-status').text()).toBe('voyage failed')
    expect(row.find('.vessel-l2').text()).toMatch(/^Failed on aaaaaaa \d+[smhd] ago — the previous build is still serving$/)
    expect(button(row).text()).toBe('Retry deploy')
  }))

  test('another branch than main is marked; an unknown status says so', () => rowOf(live => {
    live.info.branch = 'release/2'
    live.pm2 = { ...live.pm2, status: 'unknown' }
  }, row => {
    expect(row.find('.vessel-branch').text()).toBe('release/2')
    expect(row.find('.vessel-status').text()).not.toBe('')
  }))

  test('down: Start', () => rowOf(live => {
    live.pm2 = { ...live.pm2, status: 'stopped' }
  }, row => {
    expect(row.find('.vessel-status').text()).toBe('stopped')
    expect(button(row).text()).toBe('Start')
  }))

  // The menu in groups: no Deploy next to Deploy latest, no Open app next to
  // the address; Go to; the piers with the current one ticked; Stop apart at
  // the end. adm is at its owner's only pier, and moving sends the pier alone.
  test('the ⋯ menu: what the row does not show, in groups, Stop set apart', () => rowOf(() => {}, async row => {
    await row.find('.action-menu-toggle').trigger('click')
    await settle()
    const menu = row.find('.action-menu-list')
    const items = menu.findAll('[role="menuitem"]')
    expect(items.map(i => i.text())).toEqual(
      ['Restart', 'Last voyage', 'Logbook', 'Rigging', '✓ Kunder', 'At anchor (no pier)', 'Stop…']
    )
    expect(menu.findAll('.action-menu-heading').map(h => h.text())).toEqual(['Go to', 'Move to pier'])
    expect(items.find(i => i.text() === '✓ Kunder').attributes('disabled')).toBeDefined()
    expect(menu.find('.action-menu-sep').exists()).toBe(true)
    expect(items.at(-1).classes()).toContain('danger')

    const patch = vi.spyOn(api, 'patch')
    await items.find(i => i.text() === 'At anchor (no pier)').trigger('click')
    await settle()
    expect(patch).toHaveBeenCalledWith('/api/projects/1', { group_id: null })
    patch.mockRestore()
  }))

  test('Go to opens the last voyage, the Logbook and Rigging', async () => {
    const pushed = []
    for (const label of ['Last voyage', 'Logbook', 'Rigging']) {
      await rowOf(() => {}, async row => {
        await row.find('.action-menu-toggle').trigger('click')
        await settle()
        await row.findAll('[role="menuitem"]').find(i => i.text() === label).trigger('click')
        await settle()
      }, { router: { push: to => pushed.push(to) } })
    }
    expect(pushed).toEqual([
      { path: '/projects/1', query: { deployment: '1' } },
      { path: '/projects/1', query: { tab: 'logs' } },
      { path: '/projects/1', query: { tab: 'settings' } },
    ])
  })

  // In step there is no button on the row, so Deploy is the menu's first.
  test('a vessel in step keeps Deploy in its menu', () => rowOf(live => {
    live.headCommit = { sha: 'a'.repeat(40), message: 'x', pushedAt: ISO }
  }, async row => {
    await row.find('.action-menu-toggle').trigger('click')
    await settle()
    expect(row.findAll('[role="menuitem"]')[0].text()).toBe('Deploy')
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

// Before the code is on the server the first button gets it there without a
// deploy; after, it checks the remote. It is one button either way, laid out
// for all its labels, so a busy state never moves its neighbours.
test('Clone until the code is checked out, Check remote after — one button, one size', async () => {
  seedStore('admin')
  store.live.projects[1].checkedOut = false
  const post = vi.spyOn(api, 'post').mockResolvedValue({ sha: 'c'.repeat(40), message: 'first commit' })
  const page = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      const head = wrapper.findAll('button').find(b => /Clone|Check/.test(visibleText(b)))
      expect(visibleText(head)).toBe('⤓ Clone')
      expect(head.findAll('.stable-label > span').map(s => s.text())).toEqual(['⤓ Clone', 'Cloning…', '↻ Check GitHub', 'Checking…'])
      await head.trigger('click')
      await settle()
      expect(post).toHaveBeenCalledWith('/api/projects/1/clone')
      expect(wrapper.text()).toContain('Cloned ccccccc — first commit. Nothing is deployed')
      store.live.projects[1].checkedOut = true
      await settle()
      expect(visibleText(head)).toBe('↻ Check GitHub')
    },
  })
  post.mockRestore()
  expect(page.problems.join(' | ')).toBe('')
})

describe('the project page', () => {
  const rows = [
    { id: 13, status: 'success', trigger: 'manual', commit_sha: 'a'.repeat(40), commit_message: 'now', started_at: ISO, finished_at: ISO, created_at: ISO },
    { id: 12, status: 'success', trigger: 'manual', commit_sha: 'c'.repeat(40), commit_message: 'fix: the good one', started_at: ISO, finished_at: ISO, created_at: ISO },
    { id: 11, status: 'failed', trigger: 'manual', commit_sha: 'd'.repeat(40), commit_message: 'broke', started_at: ISO, finished_at: ISO, created_at: ISO },
  ]
  const withVoyages = () => vi.spyOn(api, 'get').mockImplementation(async url => (/\/deployments$/.test(url) ? rows : {}))

  // ?deployment= from a ship's log link opens that voyage; picking another
  // replaces it; a tab click is its own history entry.
  test('the tab and the voyage live in the URL', async () => {
    seedStore('admin')
    const get = withVoyages()
    const calls = []
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: { deployment: '12' } },
      router: { push: to => calls.push(['push', to.query]), replace: to => calls.push(['replace', to.query]) },
      steps: async wrapper => {
        expect(wrapper.vm.selectedId).toBe(12)
        wrapper.vm.selectedId = 11
        await settle()
        expect(calls.at(-1)).toEqual(['replace', { deployment: '11' }])
        await wrapper.findAll('.tabs button').find(b => b.text().startsWith('Freight')).trigger('click')
        await settle()
        expect(wrapper.vm.tab).toBe('files')
        expect(calls.at(-1)).toEqual(['push', { tab: 'files' }])
      },
    })
    get.mockRestore()
    expect(page.problems.join(' | ')).toBe('')
  })

  test('a ?deployment= that is not this project\'s falls back to the latest', async () => {
    seedStore('admin')
    const get = withVoyages()
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: { deployment: '999' } },
      steps: async wrapper => expect(wrapper.vm.selectedId).toBe(13),
    })
    get.mockRestore()
    expect(page.problems.join(' | ')).toBe('')
  })

  // Back to a commit that worked: offered on successful voyages that are not
  // what runs now, sent as { sha } once confirmed.
  test('Redeploy on an earlier good voyage, after a confirmation', async () => {
    seedStore('admin')
    const get = withVoyages()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 4 })
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      steps: async wrapper => {
        const cells = wrapper.findAll('tr.deploy-row').map(r => r.find('.voyage-actions').text())
        expect(cells).toEqual(['deployed', 'Redeploy', '']) // aaaa is deployed; dddd failed
        await wrapper.findAll('tr.deploy-row')[1].find('.voyage-actions button').trigger('click')
        await settle()
        expect(dialogState.open).toBe(true)
        expect(dialogState.message).toContain('Redeploy ccccccc — fix: the good one?')
        settleDialog(true)
        await settle()
        expect(post).toHaveBeenCalledWith('/api/projects/1/deploy', { sha: 'c'.repeat(40) })
        expect(wrapper.vm.selectedId).toBe(4)
      },
    })
    get.mockRestore()
    post.mockRestore()
    expect(page.problems.join(' | ')).toBe('')
  })

  // An edit in Rigging shows a save bar and a dot on the tab; leaving asks,
  // and staying keeps the edit.
  test('unsaved Rigging: a save bar, a dot on the tab, and a question before leaving', async () => {
    seedStore('admin')
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: { tab: 'settings' } },
      steps: async wrapper => {
        expect(wrapper.find('.save-bar').exists()).toBe(false)
        const name = wrapper.findAll('.rigging label').find(l => l.text() === 'Name').element.nextElementSibling
        name.value = 'adm-renamed'
        name.dispatchEvent(new Event('input'))
        await settle()
        expect(wrapper.find('.save-bar').text()).toContain('1 unsaved change')
        expect(wrapper.find('.tab-dirty').exists()).toBe(true)

        const voyages = wrapper.findAll('.tabs button')[0]
        await voyages.trigger('click')
        await settle()
        expect(dialogState.open).toBe(true)
        settleDialog(false) // stay
        await settle()
        expect(wrapper.vm.tab).toBe('settings')
        expect(wrapper.vm.edit.name).toBe('adm-renamed')

        await voyages.trigger('click')
        await settle()
        settleDialog(true) // leave them behind
        await settle()
        expect(wrapper.vm.tab).toBe('deploys')
        expect(wrapper.vm.edit.name).toBe('adm')
        expect(wrapper.vm.dirtyFields).toEqual([])
      },
    })
    expect(page.problems.join(' | ')).toBe('')
  })

  test('Discard puts the form back as it was', async () => {
    seedStore('admin')
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: { tab: 'settings' } },
      steps: async wrapper => {
        await wrapper.find('.rigging textarea').setValue('make')
        await settle()
        await wrapper.findAll('.save-bar button').find(b => b.text() === 'Discard').trigger('click')
        await settle()
        expect(wrapper.vm.edit.deploy_script).toBe('bun install')
        expect(wrapper.find('.save-bar').exists()).toBe(false)
      },
    })
    expect(page.problems.join(' | ')).toBe('')
  })

  test('Rigging comes in sections, folding away and back', async () => {
    seedStore('admin')
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: { tab: 'settings' } },
      steps: async wrapper => {
        expect(wrapper.findAll('.collapse-title').map(t => t.text())).toEqual(['Source', 'Runtime', 'Build', 'Routing', 'Advanced'])
        // Runtime in its groups (a container's), Advanced in its parts
        expect(wrapper.findAll('.section-part-title').map(t => t.text())).toEqual(['What runs', 'Resources', 'Network', 'Storage', 'Slug', 'Scuttle'])
        // the deploy script's image with the script, the gate's files with the routing
        const section = title => wrapper.findAll('.collapse-section').find(s => s.find('.collapse-title').text() === title)
        const labels = title => section(title).findAll('label').map(l => l.text())
        expect(labels('Build')[0]).toBe('Build image')
        expect(labels('Runtime')).not.toContain('Build image')
        expect(labels('Routing').some(l => l.includes("serve the build's files"))).toBe(true)
        expect(labels('Runtime').some(l => l.includes("serve the build's files"))).toBe(false)
        // shared networks name this project's own container
        expect(section('Runtime').text()).toContain('this one is skeppa-app-adm')
      },
    })
    expect(page.problems.join(' | ')).toBe('')
  })

  // A new slug moves the directory after a confirm; the server's refusal shows
  // under the field. The panel's own project has no Slug part at all.
  test('Slug changes the slug, says why not, and is not offered for the panel itself', async () => {
    seedStore('admin')
    const post = vi.spyOn(api, 'post')
      .mockRejectedValueOnce(Object.assign(new Error('validation failed'), { fields: { slug: 'slug already used by another project' } }))
      .mockResolvedValueOnce({ slug: 'blog', warning: '' })
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      route: { query: { tab: 'settings' } },
      steps: async wrapper => {
        const move = () => wrapper.findAll('button').find(b => /Change slug/.test(visibleText(b)))
        expect(move().attributes('disabled')).toBeDefined() // nothing typed yet
        wrapper.vm.slugInput = 'blog'
        await settle()
        for (const answer of ['refused', 'moved']) {
          await move().trigger('click')
          await settle()
          expect(dialogState.message).toContain('to blog?')
          settleDialog(true)
          await settle()
          if (answer === 'refused') expect(wrapper.find('.error').text()).toBe('slug already used by another project')
        }
        expect(post).toHaveBeenCalledWith('/api/projects/1/slug', { slug: 'blog' })
        expect(wrapper.text()).toContain('Moved to blog.')

        Object.assign(store.live.projects[1].info, { runtime: 'pm2', pm2_name: 'skeppa' })
        await settle()
        const advanced = wrapper.findAll('.collapse-section').find(s => s.find('.collapse-title').text() === 'Advanced')
        expect(advanced.findAll('.section-part-title').map(t => t.text())).toEqual(['Scuttle'])
      },
    })
    post.mockRestore()
    expect(page.problems.join(' | ')).toBe('')
  })

  // Where it comes from and where it is served, one line, both links.
  test('the header links the branch and the address', async () => {
    seedStore('admin')
    const page = await expectCleanRender(ProjectView, {
      props: { id: '1' },
      steps: async wrapper => {
        expect(wrapper.find('a.repo-link').attributes('href')).toBe('https://github.com/o/adm/tree/main')
        expect(wrapper.find('a.repo-link').text()).toBe('o/adm @ main')
        expect(wrapper.find('.project-where a.vessel-addr').attributes('href')).toBe('https://app.apps.example.com')
      },
    })
    expect(page.problems.join(' | ')).toBe('')
  })
})

// An admin's own repos come first, under a "yours" mark, or alone with
// Mine — remembered; with only one kind there is nothing to choose.
test('the repository picker lists yours first, or only yours', async () => {
  seedStore('admin')
  const repo = (owner, name, mine) => ({ full_name: `${owner}/${name}`, owner, name, private: false, default_branch: 'main', pushed_at: ISO, created_at: ISO, description: '', language: '', archived: false, fork: false, mine })
  const repos = [repo('amy', 'a1', false), repo('cap', 'c1', true), repo('zed', 'z1', false), repo('cap', 'c2', true)]
  const get = vi.spyOn(api, 'get').mockImplementation(async url => (url.startsWith('/api/github/repos') ? repos : {}))
  try { localStorage.clear() } catch { /* all, by name */ }
  const page = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      const rows = () => wrapper.findAll('.repo-option').map(r => r.find('.repo-name').text())
      const groups = () => wrapper.findAll('.repo-group').map(g => g.text().replace(/\s+/g, ' '))
      expect(groups()).toEqual(['cap yours 2', 'amy 1', 'zed 1'])
      expect(rows()).toEqual(['c1', 'c2', 'a1', 'z1'])
      const scope = label => wrapper.findAll('.repo-scope button').find(b => b.text() === label)
      expect(scope('All').attributes('aria-pressed')).toBe('true')
      await scope('Mine').trigger('click')
      await settle()
      expect(rows()).toEqual(['c1', 'c2'])
      expect(wrapper.find('.repo-meta').text()).toContain('2 of yours — 4 repos across 3 accounts')
      expect(localStorage.getItem('skeppa.repoScope')).toBe('mine')
    },
  })
  expect(page.problems.join(' | ')).toBe('')

  // nothing of yours (or nothing but): no choice offered, everything listed
  get.mockImplementation(async url => (url.startsWith('/api/github/repos') ? repos.map(r => ({ ...r, mine: false })) : {}))
  const none = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.find('.repo-scope').exists()).toBe(false)
      expect(wrapper.findAll('.repo-option').length).toBe(4) // Mine remembered, but it means nothing here
    },
  })
  expect(none.problems.join(' | ')).toBe('')
  get.mockRestore()
  try { localStorage.clear() } catch { /* clean */ }
})

// Mooring: the repository is picked from a searchable, sortable list, with
// repos a project already uses marked, archived ones tucked away, and the
// pick filling in the branch and the name — then the list folds into the
// choice, until Change.
test('the repository picker searches, sorts, marks what is moored, and folds into the choice', async () => {
  seedStore('admin')
  const repos = [
    { full_name: 'o/zeta', owner: 'o', name: 'zeta', private: false, default_branch: 'main', pushed_at: ISO, created_at: '2020-01-01T00:00:00Z', description: '', language: 'Go', archived: false, fork: false },
    { full_name: 'o/adm', owner: 'o', name: 'adm', private: true, default_branch: 'trunk', pushed_at: '2026-01-01T00:00:00Z', created_at: '2025-01-01T00:00:00Z', description: 'The admin app', language: 'JavaScript', archived: false, fork: false },
    { full_name: 'o/old', owner: 'o', name: 'old', private: false, default_branch: 'main', pushed_at: '', created_at: '', description: '', language: '', archived: true, fork: false },
  ]
  const get = vi.spyOn(api, 'get').mockImplementation(async url => {
    if (url.startsWith('/api/github/repos')) return url.endsWith('?fresh=1') ? [...repos, { ...repos[0], full_name: 'o/new', name: 'new' }] : repos
    return {}
  })
  try { localStorage.clear() } catch { /* sorts by name */ }
  const page = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      const rows = () => wrapper.findAll('.repo-option').map(r => r.find('.repo-name').text())
      expect(rows()).toEqual(['adm', 'zeta']) // A–Z, the archived one tucked away
      expect(wrapper.find('.repo-option .chip.blue').text()).toContain('moored as adm')

      // Refresh asks past the server's cache, and the list follows
      // under the frame: the count and Refresh, which asks past the server's cache
      const refresh = () => wrapper.findAll('.repo-meta .link-button').find(b => b.text().includes('Refresh'))
      expect(wrapper.find('.repo-picker .repo-meta').exists()).toBe(false)
      await refresh().trigger('click')
      await settle()
      expect(get).toHaveBeenCalledWith('/api/github/repos?fresh=1')
      expect(rows()).toEqual(['adm', 'new', 'zeta'])
      expect(wrapper.find('.repo-meta').text()).toContain('4 repos')
      expect(wrapper.text()).not.toContain('Missing one?')

      await wrapper.findAll('.repo-sort button').find(b => b.text() === 'Last push').trigger('click')
      await settle()
      expect(rows()).toEqual(['new', 'zeta', 'adm'])

      await wrapper.find('.repo-archived .link-button').trigger('click')
      await settle()
      expect(rows()).toContain('old')

      await wrapper.find('.repo-search').setValue('admin app')
      await settle()
      expect(rows()).toEqual(['adm'])
      await wrapper.find('.repo-search').trigger('keydown', { key: 'Enter' })
      await settle()
      expect(wrapper.vm.form.repo_full_name).toBe('o/adm')
      expect(wrapper.vm.form.branch).toBe('trunk')
      expect(wrapper.vm.form.name).toBe('adm')

      // picked: one card, no search, no list, no Refresh
      expect(wrapper.find('.repo-picked .repo-name').text()).toBe('adm')
      expect(wrapper.find('.repo-picked .chip.blue').text()).toContain('moored as adm')
      for (const gone of ['.repo-search', '.repo-option', '.repo-meta']) expect(wrapper.find(gone).exists()).toBe(false)

      // Change brings the list back at the picked one; Escape keeps it
      await wrapper.findAll('.repo-picked button').find(b => b.text() === 'Change').trigger('click')
      await settle()
      expect(wrapper.find('.repo-option.selected .repo-check').exists()).toBe(true)
      await wrapper.find('.repo-search').trigger('keydown', { key: 'Escape' })
      await settle()
      expect(wrapper.find('.repo-picked').exists()).toBe(true)
      expect(wrapper.vm.form.repo_full_name).toBe('o/adm')
    },
  })
  get.mockRestore()
  expect(page.problems.join(' | ')).toBe('')
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

// Host mounts: an admin writes them where MOUNT_ROOTS allows any, is told
// how to allow them where it does not; a tenant reads what they were given.
test('Rigging lets an admin write host mounts, and shows a tenant the ones they have', async () => {
  const paths = wrapper => wrapper.findAll('.container-paths > div').map(row => row.findAll('dt, dd').map(c => (c.find('.container-path-text').exists() ? c.find('.container-path-text') : c).text().replace(/\s+/g, ' ')))
  seedStore('admin')
  store.live.system.mountRoots = ['/mnt/nas']
  const admin = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      wrapper.vm.tab = 'settings'
      await settle()
      const box = wrapper.find('textarea[placeholder="/mnt/nas/media:/media:ro"]')
      expect(box.exists()).toBe(true)
      expect(wrapper.text()).toContain('Only from under /mnt/nas')
      await box.setValue('/mnt/nas/media:/media:ro')
      await settle()
      expect(wrapper.vm.edit.mounts).toBe('/mnt/nas/media:/media:ro')
      expect(wrapper.vm.deployFields).toContain('mounts')
      // a row per path in the container, with where it is on the server
      expect(paths(wrapper)).toEqual([
        ['/app', 'the source, read-only — replaced on every deploy', 'apps/adm/source'],
        ['/data', 'writable, kept between deploys', 'apps/adm/shared'],
        ['/media', 'server directory, read-only', '/mnt/nas/media'],
      ])
      // from the apps directory's name down; the whole path on hover
      expect(wrapper.find('.container-path-host').attributes('title')).toBe('/home/skeppa/apps/adm/source')
      // and copied whole, however much of it shows
      const writeText = vi.fn(async () => {})
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      await wrapper.find('.container-path-host .copy-button').trigger('click')
      await settle()
      expect(writeText).toHaveBeenCalledWith('/home/skeppa/apps/adm/source')
      expect(wrapper.find('.copy-button').classes()).toContain('copied')
      wrapper.vm.edit.write_env_file = true
      await settle()
      expect(paths(wrapper)[1][1]).toBe('writable, kept between deploys, holds .env')
    },
  })
  expect(admin.problems.join(' | ')).toBe('')

  store.live.system.mountRoots = []
  const none = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    steps: async wrapper => {
      wrapper.vm.tab = 'settings'
      await settle()
      expect(wrapper.find('textarea[placeholder="/mnt/nas/media:/media:ro"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('MOUNT_ROOTS=/mnt/nas in the panel config')
      // headed like the field it stands in for, without the format of a field that is not there
      expect(wrapper.findAll('label').map(l => l.text())).toContain('Host mounts')
    },
  })
  expect(none.problems.join(' | ')).toBe('')

  seedStore('tenant')
  store.live.projects[2].info.mounts = '/mnt/nas/media:/media:ro'
  const tenant = await expectCleanRender(ProjectView, {
    props: { id: '2' },
    steps: async wrapper => {
      wrapper.vm.tab = 'settings'
      await settle()
      // no server paths of the panel's own for a tenant; the mount says where it comes from
      expect(paths(wrapper)).toEqual([
        ['/app', 'the source, read-only — replaced on every deploy'],
        ['/data', 'writable, kept between deploys'],
        ['/media', 'server directory, read-only', '/mnt/nas/media'],
      ])
      expect(wrapper.text()).toContain('given to this project by an admin')
      expect(wrapper.text()).not.toContain('MOUNT_ROOTS')
    },
  })
  expect(tenant.problems.join(' | ')).toBe('')
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
      const buttons = await pageControls(wrapper)
      for (const gone of ['Start', 'Stop…', 'Restart', 'Logbook']) expect(buttons).not.toContain(gone)
      expect(buttons).toContain('Deploy latest') // it has unsighted commits
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
      const buttons = await pageControls(wrapper)
      for (const kept of ['Stop…', 'Restart', 'Logbook']) expect(buttons).toContain(kept) // the container still runs
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
// Mooring and Rigging are one set of sections (ProjectFields), in one order.
test('mooring and Rigging show the same sections, in the same order', async () => {
  seedStore('admin')
  const titles = async (View, opts) => {
    let out = []
    const res = await expectCleanRender(View, { ...opts, steps: async w => { out = w.findAll('.project-fields .collapse-title').map(t => t.text()) } })
    expect(res.problems.join(' | ')).toBe('')
    return out
  }
  const moor = await titles(ProjectNewView)
  const rigging = await titles(ProjectView, { props: { id: '1' }, route: { query: { tab: 'settings' } } })
  expect(moor).toEqual(['Source', 'Runtime', 'Build', 'Routing'])
  expect(rigging).toEqual(moor)
})

// A refused save marks each field it is about, opens a folded section that
// holds one, and lets a message go once its field is edited.
test('the server\'s field errors show under their fields, and go when the field changes', async () => {
  seedStore('admin')
  const patch = vi.spyOn(api, 'patch').mockRejectedValue(Object.assign(new Error('validation failed'), {
    fields: { subdomain: 'subdomain already routed', deploy_script: 'too long', something_new: 'odd' },
  }))
  const page = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    route: { query: { tab: 'settings' } },
    steps: async wrapper => {
      // fold Routing away first: the error must open it again
      const routing = wrapper.findAll('.collapse-section').find(s => s.find('.collapse-title').text() === 'Routing')
      await routing.find('.collapse-head').trigger('click')
      await wrapper.find('.rigging textarea').setValue('make')
      await settle()
      await wrapper.findAll('.save-bar button').find(b => b.text().startsWith('Save') && !b.text().includes('deploy')).trigger('click')
      await settle()
      const errors = () => wrapper.findAll('.field-error').map(e => e.text())
      expect(errors()).toEqual(['too long', 'subdomain already routed', 'something_new: odd'])
      expect(routing.classes()).toContain('open')
      expect(wrapper.text()).toContain('Some fields need a look')
      await wrapper.find('.rigging textarea').setValue('make again')
      await settle()
      expect(errors()).toEqual(['subdomain already routed', 'something_new: odd'])
    },
  })
  patch.mockRestore()
  expect(page.problems.join(' | ')).toBe('')
})

// Most settings wait for the next deploy: the bar says so, and offers to do both.
test('Save and deploy, when what changed waits for the next deploy', async () => {
  seedStore('admin')
  const patch = vi.spyOn(api, 'patch').mockImplementation(async (url, body) => ({ ...store.live.projects[1].info, ...body }))
  const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 9 })
  const page = await expectCleanRender(ProjectView, {
    props: { id: '1' },
    route: { query: { tab: 'settings' } },
    steps: async wrapper => {
      // a name alone applies on save: no deploy offered
      const name = wrapper.findAll('.rigging label').find(l => l.text() === 'Name').element.nextElementSibling
      name.value = 'renamed'
      name.dispatchEvent(new Event('input'))
      await settle()
      expect(wrapper.find('.save-bar').text()).not.toContain('next deploy')
      expect(wrapper.findAll('.save-bar button').map(visibleText)).toEqual(['Discard', 'Save'])

      await wrapper.find('.rigging textarea').setValue('make')
      await settle()
      expect(wrapper.find('.save-bar').text()).toContain('1 take effect on the next deploy')
      await wrapper.findAll('.save-bar button').find(b => visibleText(b) === 'Save and deploy').trigger('click')
      await settle()
      expect(patch).toHaveBeenCalled()
      expect(post).toHaveBeenCalledWith('/api/projects/1/deploy')
      expect(wrapper.vm.tab).toBe('deploys')
      expect(wrapper.vm.selectedId).toBe(9)
    },
  })
  patch.mockRestore()
  post.mockRestore()
  expect(page.problems.join(' | ')).toBe('')
})

// Picking a repository reads its package.json: the offers become its own
// commands, and a site builder without a start script is offered as static.
test('the picked repository\'s package.json decides the offers', async () => {
  seedStore('admin')
  const repos = [{ full_name: 'o/site', owner: 'o', name: 'site', private: false, default_branch: 'main', pushed_at: ISO, created_at: ISO, description: '', language: '', archived: false, fork: false }]
  const get = vi.spyOn(api, 'get').mockImplementation(async url => {
    if (url.startsWith('/api/github/repos/suggest')) {
      return { found: true, deploy: 'bun install && bun run build', start: '', runtime: 'static', publish_dir: 'dist', notes: ['a build script', 'no start script', 'Vite'] }
    }
    if (url.startsWith('/api/github/repos')) return repos
    return {}
  })
  const page = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.find('.moor-bar').text()).toContain('Pick a repository and give it a name.')
      await wrapper.find('.repo-option').trigger('click')
      await settle()
      expect(get).toHaveBeenCalledWith('/api/github/repos/suggest?repo=o%2Fsite&branch=main')
      expect(wrapper.find('.repo-read').text()).toBe('Read from the repository: a build script · no start script · Vite')
      const offer = wrapper.findAll('p.suggest button').find(b => b.text().startsWith('Looks like a static site'))
      await offer.trigger('click')
      await settle()
      expect(wrapper.vm.form.runtime).toBe('static')
      expect(wrapper.vm.form.publish_dir).toBe('dist')
      expect(wrapper.find('.moor-bar').text()).toContain('Ready')
    },
  })
  get.mockRestore()
  expect(page.problems.join(' | ')).toBe('')
})

test('the new-project form offers its suggestions as one-click values', async () => {
  seedStore('admin')
  const { problems } = await expectCleanRender(ProjectNewView, {
    steps: async wrapper => {
      expect(wrapper.vm.form.deploy_script).toBe('')
      expect(wrapper.vm.form.start_command).toBe('')
      const offers = () => wrapper.findAll('p.suggest button')
      // in section order: the start command is the Runtime's, the script the Build's
      expect(offers().map(b => b.text().replace(/\s+/g, ' '))).toEqual(['Use bun run start', 'Use bun install && bun run build'])
      expect(wrapper.find('textarea').attributes('placeholder')).toBe('bun install && bun run build')

      await offers()[1].trigger('click')
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
      expect(offers().map(b => b.text().replace(/\s+/g, ' '))).toEqual(['Use web/dist', 'Use client/dist', 'Use bun install && bun run build'])
      await offers()[0].trigger('click')
      expect(wrapper.vm.form.publish_dir).toBe('web/dist')
      expect(offers().map(b => b.text().replace(/\s+/g, ' ')).slice(0, 2)).toEqual(['Use dist', 'Use client/dist'])
    },
  })
  expect(problems.join(' | ')).toBe('')
})

// An admin's own account is the last section of Rigging — the password only,
// the username in its head — and /account is a tenant's page.
test("Rigging ends with the admin's own account", async () => {
  seedStore('admin')
  const { problems } = await expectCleanRender(SettingsView, {
    steps: async wrapper => {
      const titles = wrapper.findAll('.collapse-title').map(t => t.text())
      expect(titles.at(-1)).toBe('Your account')
      const section = wrapper.findAll('.collapse-section').at(-1)
      expect(section.find('.collapse-meta').text()).toBe(store.user.username)
      await section.find('.collapse-head').trigger('click')
      await settle()
      expect(section.findAll('.section-part-title').map(t => t.text())).toEqual(['Change password'])
      expect(section.text()).not.toContain('Role')
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
