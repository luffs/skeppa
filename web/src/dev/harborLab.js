// The harbor lab: the harbor map on a seeded store, no backend or sign-in,
// for looking at the map in a real browser. Dev only — `bun run dev:web`,
// then /harbor-lab.html?s=<scenario> (&fleet=1 for a fleet server too,
// &view=list for the list); Vite builds only index.html, so none of
// this ships. A bar on top switches scenarios and makes things happen (a ship
// moored or scuttled, a voyage started, landed or failed, new commits) and
// counts frames, for a feel of what the map costs. The same is at hand from
// the console as `window.lab`; `lab.hover(id)` brings up a ship's card.
import { createApp } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import DashboardView from '../views/DashboardView.vue'
import { store } from '../store.js'
import { initTheme } from '../lib/theme.js'
import '../style.css'

initTheme()

const MB = 1024 * 1024
const at = s => new Date(Date.now() + s * 1000).toISOString()
const sha = c => c.repeat(40)

const ADMIN = { id: 1, username: 'cap', role: 'admin', handle: '', domain: '' }
const BOB = { id: 2, username: 'bob', role: 'tenant', handle: 'bob', domain: '' }
const AMY = { id: 3, username: 'amy', role: 'tenant', handle: 'amy', domain: 'amy.example.org' }

// Good voyages that took `secs` each, the newest first.
const history = (secs = 90, n = 3) => Array.from({ length: n }, (_, i) => ({
  id: n - i, status: 'success', trigger: 'push', commitSha: sha('a'),
  startedAt: at(-1000 * (i + 1)), finishedAt: at(-1000 * (i + 1) + secs), createdAt: at(-1000 * (i + 1)),
}))

let nextId = 1
// A project's LiveState entry. `voyage`: null (none), 'queued', or how many
// seconds ago one set out; `took`: how long its good voyages took (0: none).
function project(owner, slug, {
  group = null, runtime = 'container', voyage = null, took = 90, memory = 120, limit = 512, cpu = 3,
  restarts = 0, status = null, ahead = false, failed = false,
} = {}) {
  const id = nextId++
  const isStatic = runtime === 'static'
  return {
    info: {
      id, slug, name: slug, owner_id: owner.id, repo_full_name: `${owner.username}/${slug}`, git_url: '', branch: 'main',
      deploy_script: 'bun install', build_image: '', run_image: '', runtime, deployed_runtime: runtime, pm2_name: slug,
      start_command: 'bun start', cwd: null, auto_deploy: 1, write_env_file: 0, build_env: 1,
      subdomain: slug, port: 4100 + id, memory_mb: isStatic ? null : limit, network_profile: 'open', host_access: 0, networks: '',
      created_at: '2026-01-01 00:00:00', owner_role: owner.role, owner_handle: owner.handle, owner_domain: owner.domain,
      ...(group ? { group_id: group } : {}),
    },
    pm2: { status: status ?? (isStatic ? 'published' : 'online'), uptime: Date.now() - 3 * 3600_000, memory: isStatic ? 0 : memory * MB, cpu, restarts, pid: 100 + id },
    currentDeployment: voyage === null ? null
      : voyage === 'queued' ? { id: 1000 + id, status: 'queued' }
        : { id: 1000 + id, status: 'running', startedAt: at(-voyage) },
    lastDeployment: { id: 1, status: failed ? 'failed' : 'success', finishedAt: at(-910), commitSha: sha('a') },
    recentDeployments: took ? history(took) : [],
    deployedSha: sha('a'),
    headCommit: { sha: ahead ? sha('b') : sha('a'), message: ahead ? 'feat: something new' : 'feat', pushedAt: at(-120) },
  }
}

const pier = (id, owner, name) => ({ id, owner_id: owner.id, name, created_at: at(-99999) })

// Each scenario: who is looking, and the harbor they see.
const SCENARIOS = {
  mixed: {
    label: 'Mixed',
    user: ADMIN,
    build: () => ({
      groups: [pier(7, ADMIN, 'Kunder'), pier(8, ADMIN, 'Tjänster'), pier(9, BOB, 'Sajter'), pier(10, BOB, 'Tomt')],
      projects: [
        project(ADMIN, 'calm', { group: 7 }),
        project(ADMIN, 'underway', { group: 7, voyage: 30 }),
        project(ADMIN, 'ahead', { group: 7, ahead: true }),
        project(ADMIN, 'worn', { group: 8, memory: 490, restarts: 6 }),
        project(ADMIN, 'tug', { group: 8, runtime: 'pm2', memory: 80 }),
        project(ADMIN, 'drifter'),
        project(BOB, 'site', { group: 9, runtime: 'static' }),
        project(BOB, 'failed', { group: 9, failed: true }),
        project(BOB, 'down', { status: 'stopped' }),
        project(BOB, 'idle-one'),
      ],
    }),
  },
  voyages: {
    label: 'Voyages',
    user: ADMIN,
    build: () => ({
      groups: [pier(7, ADMIN, 'Kunder'), pier(8, ADMIN, 'Tjänster')],
      projects: [
        project(ADMIN, 'queued', { group: 7, voyage: 'queued' }),
        project(ADMIN, 'just-left', { group: 7, voyage: 3 }),
        project(ADMIN, 'halfway', { group: 7, voyage: 45 }),
        project(ADMIN, 'nearly', { group: 8, voyage: 85 }),
        project(ADMIN, 'overdue', { group: 8, voyage: 200, memory: 380, cpu: 81 }),
        project(ADMIN, 'blind', { group: 8, voyage: 40, took: 0 }),
        project(ADMIN, 'anchored', { voyage: 20 }),
      ],
    }),
  },
  crowd: {
    label: 'Crowd (48)',
    user: ADMIN,
    build: () => {
      const groups = []
      const projects = []
      for (const [owner, piers, per, loose] of [[ADMIN, 4, 7, 4], [BOB, 3, 5, 3], [AMY, 1, 3, 1]]) {
        for (let p = 0; p < piers; p++) {
          const id = 100 + groups.length
          groups.push(pier(id, owner, `${owner.username}-${p + 1}`))
          for (let i = 0; i < per; i++) {
            const n = projects.length
            projects.push(project(owner, `${owner.username}-${p + 1}-${i + 1}`, {
              group: id, voyage: n % 9 === 0 ? 20 + n : null, ahead: n % 7 === 3, memory: 40 + (n * 37) % 450, cpu: (n * 13) % 90,
            }))
          }
        }
        for (let i = 0; i < loose; i++) projects.push(project(owner, `${owner.username}-loose-${i + 1}`))
      }
      return { groups, projects }
    },
  },
  tenant: {
    label: 'Tenant',
    user: BOB,
    build: () => ({
      groups: [pier(9, BOB, 'Sajter'), pier(10, BOB, 'Tomt')],
      projects: [
        project(BOB, 'site', { group: 9, runtime: 'static' }),
        project(BOB, 'app', { group: 9, voyage: 50 }),
        project(BOB, 'api', { group: 9, memory: 300 }),
        project(BOB, 'drifter'),
      ],
    }),
  },
}

const params = new URLSearchParams(location.search)
const name = params.get('s')
const scenario = SCENARIOS[name] ?? SCENARIOS.mixed
const harbor = scenario.build()

store.user = scenario.user
store.connected = true
store.ready = true
store.liveUpdatedAt = Date.now()
store.live = {
  projects: Object.fromEntries(harbor.projects.map(p => [p.info.id, p])),
  groups: Object.fromEntries(harbor.groups.map(g => [g.id, g])),
  system: {
    appsDir: '/home/skeppa/apps', hostBootAt: Date.now() - 1e7, panelStartedAt: Date.now() - 1e5,
    selfPm2Name: 'skeppa', proxyPm2Name: 'skeppa-proxy', loadavg: [0.1, 0.2, 0.3],
    memory: { total: 8e9, free: 4e9 }, disk: { appsDirBytes: 1e9, free: 5e10, total: 1e11 },
    pm2Error: null, pm2: {}, containerSocket: '', containerError: '', containers: {}, mountRoots: [],
  },
  users: Object.fromEntries([ADMIN, BOB, AMY].map(u => [u.id, { ...u, created_at: at(-99999) }])),
  proxy: { baseDomain: 'apps.example.com' },
  images: { managedPrefix: 'localhost/skeppa/', managed: [], local: [], storeListed: false, engineError: '', defaultImage: '' },
}
// &fleet=1: a fleet server reporting here too (an admin's harbor only), with
// a pier and a few vessels of its own — its ids are another database's.
if (params.get('fleet') && scenario.user.role === 'admin') {
  const theirs = [
    project(ADMIN, 'wiki', { group: 1 }),
    project(ADMIN, 'ci-runner', { group: 1, ahead: true }),
    project(ADMIN, 'backup-sync', { status: 'stopped' }),
  ]
  store.live.nodes = { 1: { id: 1, name: 'jobb-1', paired: true, online: true, lastSeenAt: at(0), adminId: 1, version: 'abc1234' } }
  store.live.nodeStates = {
    1: {
      projects: Object.fromEntries(theirs.map(p => [p.info.id, p])),
      groups: { 1: pier(1, ADMIN, 'Jobb') },
      proxy: { baseDomain: 'jobb.example.com' },
      system: { loadavg: [0.4, 0.3, 0.2], cpuCount: 2, memory: { total: 4e9, free: 2e9 } },
      images: null,
    },
  }
}
try {
  localStorage.setItem('skeppa.harborView', params.get('view') === 'list' ? 'list' : 'map')
  localStorage.removeItem('skeppa.foldedFleets')
} catch { /* the route says map too */ }

// --- making things happen ----------------------------------------------------
const projects = () => Object.values(store.live.projects)
const pick = list => list[Math.floor(Math.random() * list.length)]
const lab = {
  store,
  scenarios: Object.keys(SCENARIOS),
  // a new ship at a random pier of the viewer's own (or at anchor)
  moor() {
    const own = Object.values(store.live.groups).filter(g => g.owner_id === store.user.id)
    const p = project(store.user, `new-${nextId}`, { group: own.length ? pick(own).id : null })
    store.live.projects[p.info.id] = p
    return p.info.id
  },
  scuttle(id = projects().at(-1)?.info.id) {
    delete store.live.projects[id]
  },
  setSail(id = pick(projects().filter(p => !p.currentDeployment && p.info.runtime !== 'static'))?.info.id) {
    const p = store.live.projects[id]
    if (p) p.currentDeployment = { id: 5000 + nextId++, status: 'running', startedAt: at(0) }
    return id
  },
  // every voyage under way makes port (or, with `failed`, one of them fails)
  land({ failed = false } = {}) {
    const out = projects().filter(p => p.currentDeployment?.status === 'running')
    for (const p of failed ? out.slice(0, 1) : out) {
      const d = { id: p.currentDeployment.id, status: failed ? 'failed' : 'success', trigger: 'manual', commitSha: p.headCommit.sha, startedAt: p.currentDeployment.startedAt, finishedAt: at(0), createdAt: p.currentDeployment.startedAt }
      p.recentDeployments = [d, ...p.recentDeployments].slice(0, 5)
      p.lastDeployment = { id: d.id, status: d.status, finishedAt: d.finishedAt, commitSha: d.commitSha }
      if (!failed) p.deployedSha = p.headCommit.sha
      p.currentDeployment = null
    }
  },
  hail(id = pick(projects())?.info.id) {
    const p = store.live.projects[id]
    if (p) p.headCommit = { sha: sha(String.fromCharCode(99 + (nextId++ % 3))), message: 'feat: new', pushedAt: at(0) }
  },
  async hover(id) {
    document.querySelector(`[data-ship="${id}"]`)?.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise(r => setTimeout(r, 300))
    return document.querySelector('.harbor-card .vessel-name')?.textContent ?? null
  },
  // frames per second over the last second, and the longest frame in it (ms)
  fps: { now: 0, worst: 0 },
}
window.lab = lab

// --- the bar on top ------------------------------------------------------------
const bar = document.getElementById('lab-bar')
bar.style.cssText = 'position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 16px;background:var(--panel);border-bottom:1px solid var(--line);font:12px var(--mono);color:var(--dim)'
const el = (tag, props) => Object.assign(document.createElement(tag), props)
const button = (text, onclick) => {
  const b = el('button', { type: 'button', className: 'small secondary', textContent: text, onclick })
  bar.append(b)
}
bar.append(el('strong', { textContent: 'Harbor lab', style: 'color:var(--ink);margin-right:6px' }))
for (const [key, s] of Object.entries(SCENARIOS)) {
  bar.append(el('a', { href: `?s=${key}`, textContent: s.label, style: `margin-right:4px;${s === scenario ? 'color:var(--accent);font-weight:700' : ''}` }))
}
bar.append(el('span', { textContent: '·' }))
button('Moor', () => lab.moor())
button('Scuttle', () => lab.scuttle())
button('Set sail', () => lab.setSail())
button('Land', () => lab.land())
button('Fail', () => lab.land({ failed: true }))
button('New commits', () => lab.hail())
const meter = el('span', { style: 'margin-left:auto' })
bar.append(meter)

// Frames per second say little where the browser caps them (an embedded
// pane runs at 30), so the meter also counts how much of each second the main
// thread had nothing to do (requestIdleCallback's time to spare): what the
// map's animations, style and paint leave over.
let frames = 0
let worst = 0
let idle = 0
let last = performance.now()
let windowStart = last
const tick = t => {
  frames++
  worst = Math.max(worst, t - last)
  last = t
  if (t - windowStart >= 1000) {
    const span = t - windowStart
    lab.fps = { now: Math.round((frames * 1000) / span), worst: Math.round(worst), idle: Math.round((idle * 100) / span) }
    meter.textContent = `${projects().length} ships · ${lab.fps.now} fps · worst frame ${lab.fps.worst} ms · ${lab.fps.idle}% idle`
    frames = 0
    worst = 0
    idle = 0
    windowStart = t
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
const spare = deadline => {
  idle += deadline.timeRemaining()
  requestIdleCallback(spare)
}
if (typeof requestIdleCallback === 'function') requestIdleCallback(spare)

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: DashboardView }, { path: '/:rest(.*)', component: { render: () => null } }],
})
router.push(params.get('view') === 'list' ? '/' : '/?view=map')
router.isReady().then(() => createApp(DashboardView).use(router).mount('#app'))
