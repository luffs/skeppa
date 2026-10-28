import { describe, test, expect } from 'vitest'
import { runsSupersededImage } from '../src/lib/images.js'

// A tag is a pointer. Pulling moves it, and a container keeps running the
// image it was created from — so "same tag" and "same image" are different
// questions, and only the ids answer the second one.
describe('a container running an image its tag has left behind', () => {
  const store = (localId, ref = 'docker.io/oven/bun:1') => ({
    local: [{ id: localId, tags: [ref] }],
  })

  test('is flagged when the tag now resolves elsewhere', () => {
    const container = { image: 'docker.io/oven/bun:1', imageId: 'sha256:old' }
    expect(runsSupersededImage(store('sha256:new'), container)).toBe(true)
  })

  test('is not flagged while the ids agree', () => {
    const container = { image: 'docker.io/oven/bun:1', imageId: 'sha256:same' }
    expect(runsSupersededImage(store('sha256:same'), container)).toBe(false)
  })

  // Podman and Docker disagree about the prefix; the digest is the fact.
  test('compares the digest, not the engine spelling of it', () => {
    const container = { image: 'docker.io/oven/bun:1', imageId: 'abc123' }
    expect(runsSupersededImage(store('sha256:abc123'), container)).toBe(false)
  })

  // Silence must never read as "up to date": an image the store does not list
  // (or an engine that listed nothing at all) is simply unknown.
  test('claims nothing without both ids', () => {
    expect(runsSupersededImage(store('sha256:new'), { image: 'docker.io/oven/bun:1', imageId: '' })).toBe(false)
    expect(runsSupersededImage(store('sha256:new'), { image: 'docker.io/library/node:22', imageId: 'sha256:old' })).toBe(false)
    expect(runsSupersededImage(null, { image: 'docker.io/oven/bun:1', imageId: 'sha256:old' })).toBe(false)
    expect(runsSupersededImage({ local: [] }, null)).toBe(false)
  })
})

// --- the same two facts, as the views actually render them -------------------
import { mount } from '@vue/test-utils'
import { store } from '../src/store.js'
import Shipyard from '../src/components/Shipyard.vue'
import SystemView from '../src/views/SystemView.vue'

const NOW = Date.now()
const HOUR = 3600e3
const stubs = { RouterLink: { props: ['to'], template: '<a><slot /></a>' }, RouterView: true }
const mocks = { $route: { path: '/', query: {}, params: {} }, $router: { push() {}, replace() {} } }

function seed(extra = {}) {
  store.user = { id: 1, username: 'cap', role: 'admin', handle: '', domain: '' }
  store.ready = true
  store.connected = true
  store.now = NOW
  store.live = {
    projects: {},
    users: {},
    proxy: {},
    system: {
      appsDir: '/home/skeppa/apps', hostBootAt: NOW - 1e7, panelStartedAt: NOW - 1e5,
      selfPm2Name: 'skeppa', proxyPm2Name: 'skeppa-proxy', loadavg: [0, 0, 0],
      memory: { total: 8e9, free: 4e9 }, disk: { appsDirBytes: 1e9, free: 5e10, total: 1e11 },
      pm2Error: null, pm2: {}, containerSocket: '/run/podman.sock', containerError: '',
      containers: {},
    },
    images: {
      managedPrefix: 'localhost/skeppa/', defaultImage: 'docker.io/oven/bun:1',
      storeListed: true, engineError: '', managed: [], local: [],
    },
    ...extra,
  }
}

describe('the Shipyard names the image behind the tag', () => {
  test('shows version, age and digest — and only what the image carries', async () => {
    seed()
    store.live.images.local = [
      { id: 'sha256:aaa', tags: ['docker.io/oven/bun:1'], size: 4e8, dangling: false, managed: false, used_by: [],
        version: '1.4.4', digest: 'sha256:abcdef0123456789', createdAt: NOW - 37 * 24 * HOUR },
      // built here: no registry digest, no label, nothing to claim
      { id: 'sha256:bbb', tags: ['localhost/skeppa/bun-node:latest'], size: 4e8, dangling: false, managed: true, used_by: [],
        version: '', digest: '', createdAt: NOW - 2 * HOUR },
    ]
    const wrapper = mount(Shipyard, { global: { stubs, mocks } })
    const rows = wrapper.findAll('tbody tr')

    expect(rows[0].find('.image-facts').text()).toContain('v1.4.4')
    expect(rows[0].find('.image-facts').text()).toContain('built 37d ago')
    expect(rows[0].find('.image-facts').text()).toContain('abcdef012345') // 12, not the whole digest
    expect(rows[1].find('.image-facts').text()).toBe('built 2h ago')
    wrapper.unmount()
  })
})

describe('the system view flags a container left behind by its tag', () => {
  test('marks only the container whose image id no longer matches', async () => {
    seed()
    const base = { status: 'online', state: 'running', ports: [], slug: '', createdAt: NOW - HOUR }
    store.live.images.local = [{ id: 'sha256:new', tags: ['docker.io/oven/bun:1'], size: 1, dangling: false, managed: false, used_by: [] }]
    store.live.system.containers = {
      'skeppa-app-stale': { ...base, image: 'docker.io/oven/bun:1', imageId: 'sha256:old' },
      'skeppa-app-fresh': { ...base, image: 'docker.io/oven/bun:1', imageId: 'sha256:new' },
    }
    const wrapper = mount(SystemView, { global: { stubs, mocks } })
    const cards = wrapper.findAll('.proc-card').filter(c => c.text().includes('skeppa-app-'))

    const stale = cards.find(c => c.text().includes('skeppa-app-stale'))
    const fresh = cards.find(c => c.text().includes('skeppa-app-fresh'))
    expect(stale.text()).toContain('superseded')
    expect(fresh.text()).not.toContain('superseded')
    wrapper.unmount()
  })
})

// --- who uses an image, and which of them a restart actually moves ----------
import { imageUsers } from '../src/lib/images.js'

describe('how each project depends on an image', () => {
  const project = (id, slug, info, status = 'online') => ({
    info: { id, slug, name: slug, build_image: '', run_image: '', deployed_runtime: '', ...info },
    pm2: { status },
  })
  const live = {
    images: {
      defaultImage: 'docker.io/oven/bun:1',
      // The tag resolves to sha256:new in the store.
      local: [{ id: 'sha256:new', tags: ['docker.io/oven/bun:1'] }],
    },
    projects: {
      1: project(1, 'inherits', { runtime: 'container', deployed_runtime: 'container' }),
      2: project(2, 'stopped', { runtime: 'container', deployed_runtime: 'container' }, 'stopped'),
      3: project(3, 'host-app', { runtime: 'pm2', deployed_runtime: 'pm2' }),
      4: project(4, 'switching', { runtime: 'container', deployed_runtime: 'static' }),
      5: project(5, 'other-run', { runtime: 'container', deployed_runtime: 'container', run_image: 'docker.io/library/node:22' }),
    },
    system: {
      containers: {
        'skeppa-app-inherits': { slug: 'inherits', image: 'docker.io/oven/bun:1', imageId: 'sha256:old' },
        'skeppa-app-stopped': { slug: 'stopped', image: 'docker.io/oven/bun:1', imageId: 'sha256:new' },
      },
    },
  }
  const of = (slug, refs = ['docker.io/oven/bun:1']) =>
    imageUsers(live, refs, [slug])[0]

  // Naming nothing means the default twice over: the sandbox builds in it and
  // resolveRunImage falls through to it.
  test('an empty field is the default, for both the build and the run', () => {
    expect(of('inherits')).toMatchObject({ id: 1, builds: true, runs: true, restartable: true })
  })

  test('a host process only ever builds in it', () => {
    expect(of('host-app')).toMatchObject({ builds: true, runs: false, restartable: false })
    expect(of('host-app').reason).toBe('needs a deploy, not a restart')
  })

  // Restart is start-if-stopped, and auto_start follows it — so offering it
  // for a stopped app would quietly undo someone's decision.
  test('a stopped container is listed but not restarted', () => {
    expect(of('stopped')).toMatchObject({ runs: true, restartable: false, reason: 'stopped' })
  })

  // runtime is what the next deploy will do, deployed_runtime what exists:
  // a project switched to `container` in the form is still a static site
  // until the deploy, so there is no container to recreate.
  test('a runtime change that has not deployed yet has nothing to recreate', () => {
    expect(of('switching')).toMatchObject({
      runs: true, restartable: false, reason: 'not deployed as a container yet',
    })
  })

  test('a run image of its own leaves only the build dependency', () => {
    expect(of('other-run')).toMatchObject({ builds: true, runs: false, restartable: false })
    expect(of('other-run', ['docker.io/library/node:22']))
      .toMatchObject({ builds: false, runs: true, restartable: true })
  })

  // One store entry can wear several tags, and used_by is the union of them.
  test('any of the entry tags counts', () => {
    expect(of('inherits', ['docker.io/library/node:22', 'docker.io/oven/bun:1']).runs).toBe(true)
  })

  // The server decides who uses an image; a slug this client cannot resolve
  // is still one of them.
  test('an unresolvable slug is listed without a claim', () => {
    expect(imageUsers(live, ['docker.io/oven/bun:1'], ['gone'])[0]).toEqual({
      slug: 'gone', id: null, name: 'gone',
      builds: false, runs: false, restartable: false, imageState: 'unknown', reason: '',
    })
  })

  // The tag moved under a running container: the one case where a restart is
  // not just allowed but the thing to do.
  test('says which container is behind the image its tag now points at', () => {
    expect(of('inherits').imageState).toBe('stale')
    expect(of('stopped').imageState).toBe('current')
  })

  // An engine with no container for the project, or none listed at all, says
  // nothing — and nothing must not render as "up to date".
  test('claims nothing about a project the engine did not list', () => {
    expect(of('other-run', ['docker.io/library/node:22']).imageState).toBe('unknown')
    expect(imageUsers({ ...live, system: {} }, ['docker.io/oven/bun:1'], ['inherits'])[0].imageState)
      .toBe('unknown')
  })

  // A project that does not run the image has no container of this image to
  // be behind on, whatever it happens to be running.
  test('says nothing about the container of a project that only builds in it', () => {
    expect(of('host-app').imageState).toBe('unknown')
  })
})

describe('the Shipyard keeps a long user list out of the row', () => {
  test('the row counts, and the list opens in a row of its own', async () => {
    seed()
    const slugs = ['a-one', 'b-two', 'c-three', 'd-four', 'e-five']
    store.live.projects = Object.fromEntries(slugs.map((slug, i) => [i + 1, {
      info: {
        id: i + 1, slug, name: slug, build_image: '', run_image: '',
        runtime: 'container', deployed_runtime: 'container',
      },
      // Only the first three are running, so only those can be recreated.
      pm2: { status: i < 3 ? 'online' : 'stopped' },
    }]))
    store.live.images.local = [{
      id: 'sha256:aaa', tags: ['docker.io/oven/bun:1'], size: 1,
      dangling: false, managed: false, used_by: slugs,
    }]

    const wrapper = mount(Shipyard, { global: { stubs, mocks } })
    const cell = wrapper.find('tbody tr td:nth-child(3)')
    expect(cell.find('button.used-by').text()).toContain('5 projects')
    // Nothing of the list itself until it is asked for.
    expect(wrapper.find('tr.users-row').exists()).toBe(false)

    await cell.find('button.used-by').trigger('click')
    const panel = wrapper.find('tr.users-row')
    expect(panel.findAll('.user')).toHaveLength(5)
    expect(panel.find('td').attributes('colspan')).toBe('4')
    // The engine listed no containers, so it cannot say which are behind —
    // and the blunt action stays on offer rather than disappearing.
    expect(panel.find('button.secondary').text()).toBe('Restart running (3)')

    await cell.find('button.used-by').trigger('click')
    expect(wrapper.find('tr.users-row').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('the Shipyard aims the restart at what is actually behind', () => {
  // Four running containers on one tag, two of them left behind by a pull.
  // The button exists to finish that pull, so it targets those two — and the
  // dimmed chips account for the names it does not touch.
  test('restarts the outdated containers, and accounts for everything it skips', async () => {
    seed()
    const slugs = ['a-stale', 'b-stale', 'c-current', 'd-stopped', 'e-host']
    store.live.projects = Object.fromEntries(slugs.map((slug, i) => [i + 1, {
      info: {
        id: i + 1, slug, name: slug, build_image: '', run_image: '',
        runtime: i === 4 ? 'pm2' : 'container',
        deployed_runtime: i === 4 ? 'pm2' : 'container',
      },
      pm2: { status: i === 3 ? 'stopped' : 'online' },
    }]))
    store.live.images.local = [{
      id: 'sha256:new', tags: ['docker.io/oven/bun:1'], size: 1,
      dangling: false, managed: false, used_by: slugs,
    }]
    store.live.system.containers = Object.fromEntries(slugs.slice(0, 4).map(slug => [
      `skeppa-app-${slug}`,
      { slug, image: 'docker.io/oven/bun:1', imageId: slug.endsWith('stale') ? 'sha256:old' : 'sha256:new' },
    ]))

    const wrapper = mount(Shipyard, { global: { stubs, mocks } })
    const cell = wrapper.find('tbody tr td:nth-child(3)')
    // The outdated count is the one thing the row says beyond how many.
    expect(cell.find('.outdated').text()).toBe('2 outdated')

    await cell.find('button.used-by').trigger('click')
    const panel = wrapper.find('tr.users-row')
    expect(panel.find('button.secondary').text()).toBe('Restart outdated (2)')

    // Only the four that run the image; the host process that merely builds
    // in it is one line at the end, not a row of its own.
    const rows = panel.findAll('.user')
    expect(rows.map(r => r.find('.name').text())).toEqual(
      ['a-stale ↗', 'b-stale ↗', 'c-current ↗', 'd-stopped ↗']
    )
    expect(rows.map(r => r.find('.state').text()))
      .toEqual(['behind the store', 'behind the store', 'up to date', 'up to date'])
    // Dim means "a restart cannot help this one". The one already on the
    // store's image stays plain: it is simply fine, which is not the same as
    // being out of reach.
    expect(rows.map(r => r.classes().includes('off'))).toEqual([false, false, false, true])
    expect(rows[3].find('.reason').text()).toBe('stopped')
    expect(panel.find('.rest').text()).toBe('1 other only builds in it')
    wrapper.unmount()
  })
})
