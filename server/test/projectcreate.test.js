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
    port: 4001, // auto-assigned: 4000 + id
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
  expect((await res.json()).port).toBe(4001)
})

test('an explicitly chosen port is kept as-is', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, port: 8080 })
  expect((await res.json()).port).toBe(8080)
})

test('the auto port bumps past one claimed by hand', async () => {
  const { app } = setup()
  await create(app, { ...NEW_PROJECT_FORM, port: 4002 }) // id 1, takes the next project's default
  const res = await create(app, { ...NEW_PROJECT_FORM, name: 'Other', pm2_name: 'other' })
  expect((await res.json()).port).toBe(4003) // 4000 + id 2 is taken → next free
})

test('routing a subdomain no longer requires typing a port', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, subdomain: 'myapp' })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.subdomain).toBe('myapp')
  expect(body.port).toBe(4001)
})

test('clearing the port on an edit re-assigns the default', async () => {
  const { app } = setup()
  const { id } = await (await create(app, { ...NEW_PROJECT_FORM, port: 9000 })).json()
  const res = await app.request(`/${id}`, { method: 'PATCH', body: JSON.stringify({ port: '' }) })
  expect(res.status).toBe(200)
  expect((await res.json()).port).toBe(4000 + id)
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
