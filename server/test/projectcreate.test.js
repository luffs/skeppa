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
    port: null,
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

test('auto_deploy false survives the round trip', async () => {
  const { app } = setup()
  const res = await create(app, { ...NEW_PROJECT_FORM, auto_deploy: false })
  expect((await res.json()).auto_deploy).toBe(0)
})
