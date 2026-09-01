import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { projectRoutes } from '../src/routes/projects.js'
import { createLiveState } from '../src/live/state.js'

// The "moor a project" form posts a fixed set of fields; every column added
// since (write_env_file, build_image, run_image, runtime) must therefore have
// a working server-side default, or creating a project from the UI breaks.
const NEW_PROJECT_FORM = {
  repo_full_name: 'luff/app',
  branch: 'main',
  name: 'My App',
  pm2_name: 'my-app',
  deploy_script: 'bun install',
  start_command: 'bun run start',
  cwd: null,
  auto_deploy: true,
}

function setup() {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  const app = projectRoutes({
    db,
    config: { appsDir: '/srv/apps', selfPm2Name: 'skeppa' },
    liveState: createLiveState(),
  })
  return { db, app }
}

const create = (app, body) => app.request('/', { method: 'POST', body: JSON.stringify(body) })

test('the new-project form creates a project with sane defaults for every added column', async () => {
  const { db, app } = setup()
  const res = await create(app, NEW_PROJECT_FORM)
  expect(res.status).toBe(201)

  const created = await res.json()
  expect(created).toMatchObject({
    name: 'My App',
    slug: 'my-app',
    pm2_name: 'my-app',
    branch: 'main',
    auto_deploy: 1,
    runtime: 'pm2', // host process unless explicitly switched
    build_image: null, // panel default
    run_image: null,
    subdomain: null,
    port: 8101, // auto-assigned: harbor gate listen port (default 8100) + id
  })

  const row = db.query('SELECT * FROM projects WHERE id = ?').get(created.id)
  expect(row.write_env_file).toBe(0) // off for new projects; ENV is injected
  expect(row.auto_start).toBe(1) // start at boot until stopped from the panel
})

test('the form can opt into the container runtime and routing at creation time', async () => {
  const { app } = setup()
  const res = await create(app, {
    ...NEW_PROJECT_FORM,
    runtime: 'container',
    run_image: 'localhost/skeppa/bun-node:latest',
    subdomain: 'my-app',
    port: 4200,
    write_env_file: true,
  })
  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({
    runtime: 'container',
    run_image: 'localhost/skeppa/bun-node:latest',
    subdomain: 'my-app',
    port: 4200,
  })
})

// The port arrives as the user typed it, so a typo must fail validation.
// Number()-ing it on the client turned NaN into JSON null, which reads as
// "no port" and was saved silently.
test('memory limit: round-trips, empty means unlimited, garbage is rejected', async () => {
  const { app } = setup()
  let res = await create(app, { ...NEW_PROJECT_FORM, memory_mb: 512 })
  expect((await res.json()).memory_mb).toBe(512)

  res = await create(app, { ...NEW_PROJECT_FORM, name: 'B', pm2_name: 'b', memory_mb: '' })
  expect((await res.json()).memory_mb).toBeNull()

  res = await create(app, { ...NEW_PROJECT_FORM, name: 'C', pm2_name: 'c', memory_mb: 'lots' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.memory_mb).toBeDefined()

  res = await create(app, { ...NEW_PROJECT_FORM, name: 'D', pm2_name: 'd', memory_mb: 4 })
  expect(res.status).toBe(400) // below the 16 MB floor
})

test('a malformed port is rejected, not silently dropped', async () => {
  const { db, app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, port: '80o0' })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.port).toContain('between 1 and 65535')
  expect(db.query('SELECT COUNT(*) AS n FROM projects').get().n).toBe(0)
})

test('an empty port string means "assign one for me"', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, port: null })
  expect(res.status).toBe(201)
  expect((await res.json()).port).toBe(8101)
})

test('the auto port base follows the harbor gate listen port setting', async () => {
  const { db, app } = setup()
  db.query("INSERT INTO settings (key, value) VALUES ('proxy_http_port', '9000')").run()
  const res = await create(app, NEW_PROJECT_FORM)
  expect((await res.json()).port).toBe(9001)
})

test('an explicitly chosen port is kept as-is', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, port: 8080 })
  expect((await res.json()).port).toBe(8080)
})

test('the auto port bumps past one claimed by hand', async () => {
  const { app } = setup()
  await create(app, { ...NEW_PROJECT_FORM, port: 8102 }) // id 1, takes the next project's default
  const res = await create(app, { ...NEW_PROJECT_FORM, name: 'Other', pm2_name: 'other' })
  expect((await res.json()).port).toBe(8103) // 8100 + id 2 is taken → next free
})

test('routing a subdomain no longer requires typing a port', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, subdomain: 'myapp' })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.subdomain).toBe('myapp')
  expect(body.port).toBe(8101)
})

test('clearing the port on an edit re-assigns the default', async () => {
  const { app } = setup()
  const { id } = await (await create(app, { ...NEW_PROJECT_FORM, port: 9000 })).json()
  const res = await app.request(`/${id}`, { method: 'PATCH', body: JSON.stringify({ port: '' }) })
  expect(res.status).toBe(200)
  expect((await res.json()).port).toBe(8100 + id)
})

// The pm2 name field is hidden for container projects, so a collision there
// must not 400 on an invisible field — it is suffixed like the slug.
test('a colliding pm2 name is suffixed at creation instead of rejected', async () => {
  const { app } = setup()
  expect((await create(app, NEW_PROJECT_FORM)).status).toBe(201)

  const res = await create(app, { ...NEW_PROJECT_FORM, runtime: 'container', repo_full_name: 'luff/other' })
  expect(res.status).toBe(201)
  const second = await res.json()
  expect(second.pm2_name).toBe('my-app-2')
  expect(second.slug).toBe('my-app-2')
})

// Suffixing must terminate even when the base is already at the length limit;
// naive truncation would produce the same string forever.
test('suffixing a maximum-length name terminates and stays valid', async () => {
  const { app } = setup()
  const longName = 'a'.repeat(63)
  expect((await create(app, { ...NEW_PROJECT_FORM, name: longName, pm2_name: longName })).status).toBe(201)

  const res = await create(app, { ...NEW_PROJECT_FORM, name: longName, pm2_name: longName, repo_full_name: 'luff/other' })
  expect(res.status).toBe(201)
  const second = await res.json()
  expect(second.pm2_name).toBe('a'.repeat(61) + '-2')
  expect(second.pm2_name.length).toBeLessThanOrEqual(63)
})

test('auto_deploy false survives the round trip', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, auto_deploy: false })
  expect((await res.json()).auto_deploy).toBe(0)
})

// --- network profile fields ---------------------------------------------------

test('network fields are stored and returned', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Sec App', repo_full_name: 'o/sec', runtime: 'container', start_command: 'bun start',
      network_profile: 'restricted', networks: 'db-net', host_access: false,
    }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.network_profile).toBe('restricted')
  expect(body.networks).toBe('db-net')
  expect(body.host_access).toBe(0)
})

test('a bad network name and a bad profile are refused', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Bad', repo_full_name: 'o/bad', networks: 'Nope_Caps!', network_profile: 'sideways',
    }),
  })
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.fields.networks).toBeDefined()
  expect(body.fields.network_profile).toBeDefined()
})

test('host access with restricted or with networks is refused as untested', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'H', repo_full_name: 'o/h', network_profile: 'restricted', host_access: true,
    }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.host_access).toBeDefined()
})

// --- plain-git projects -------------------------------------------------------

test('a project can be created from a bare git URL, no GitHub App repo needed', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'External', git_url: 'https://codeberg.org/luff/skeppa.git', auto_deploy: true,
    }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.git_url).toBe('https://codeberg.org/luff/skeppa.git')
  expect(body.repo_full_name).toBe('')
  // no webhook will ever fire — the flag must not pretend otherwise
  expect(body.auto_deploy).toBe(0)
})

test('a git URL and a GitHub repo together are refused', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Both', repo_full_name: 'o/r', git_url: 'https://example.com/r.git',
    }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.repo_full_name).toContain('not both')
})

test('credentials embedded in a git URL are refused', async () => {
  const { app } = setup()
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Leaky', git_url: 'https://token@example.com/r.git',
    }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).fields.git_url).toContain('no credentials')
})
