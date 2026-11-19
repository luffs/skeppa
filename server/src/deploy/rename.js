import { existsSync, renameSync } from 'node:fs'
import { SLUG_RE } from '../lib/validate.js'
import { liveRuntime, isReservedPm2Name } from '../lib/runtime.js'
import { projectDirs, decryptedEnv, runtimeEnv, writeEcosystem } from './envfiles.js'
import { appContainerName, recreateAppContainer, capturePreviousLogs } from '../containers/runtime.js'
import { projectEngineNetworks, NETWORK_PREFIX } from '../containers/networks.js'

// A refusal the caller shows as a field error under the slug.
export class SlugError extends Error {}

// Renames a project's slug, and with it everything named after it: the
// berth APPS_DIR/<slug> (source, shared, the published snapshot, the
// ecosystem file), the container skeppa-app-<slug> and a restricted
// project's own convoy network. Nothing runs from a path or a name the row
// no longer says, so what runs is taken down first, the berth moved, the row
// changed, and only then is it brought back up — under the new name, from
// the new path. The caller holds the project's queue (no deploy shares the
// directory) and reloads the harbor gate afterwards, whose file routes are
// rooted in the berth.
//
// Until the row is changed a failure puts everything back as it was. After
// that the rename stands even if the app does not come up again: the reason
// is returned as a warning, and start or deploy picks it up from there.
//
// `project` carries owner_role/owner_handle (convoy names hang on them);
// `engine` is a getter, so a pm2-only install never touches the socket.
export async function renameSlug({ db, config, project, slug, engine, pm2 }) {
  slug = typeof slug === 'string' ? slug.trim() : ''
  if (slug === project.slug) return { slug, restarted: false, warning: '' }
  if (!SLUG_RE.test(slug)) {
    throw new SlugError('lowercase letters, digits and dashes, starting with a letter or digit, at most 63')
  }
  // The panel's own checkout is the running panel; moving it is a reinstall.
  if (project.pm2_name === config.selfPm2Name) throw new SlugError("the panel's own project keeps its slug")
  if (db.query('SELECT 1 FROM projects WHERE slug = ? AND id != ?').get(slug, project.id)) {
    throw new SlugError('slug already used by another project')
  }
  const renamed = { ...project, slug }
  const from = projectDirs(config, project)
  const to = projectDirs(config, renamed)
  // Left over from a deleted project, usually — its files are never ours to
  // take over or overwrite.
  if (existsSync(to.root)) throw new SlugError(`${to.root} already exists on disk`)

  const runtime = liveRuntime(project)
  const hasEngine = runtime === 'container' && Boolean(config.containerSocket)
  const appEnv = () => runtimeEnv(project, decryptedEnv(db, config, project.id))
  const bringUp = (p, dirs) => runtime === 'container'
    ? recreateAppContainer({ config, project: p, dirs, env: appEnv(), client: engine(), db })
    : pm2.startOrReload(dirs.ecosystem, appEnv())

  // Take down what runs under the old name. A container is removed (its
  // last logs saved into the berth first, so they move along); a pm2
  // process is deleted, since a pm2 restart would bring back its old cwd.
  let wasRunning = false
  if (hasEngine) {
    const name = appContainerName(project.slug)
    const existing = await engine().inspectContainer(name)
    if (existing) {
      wasRunning = Boolean(existing.State?.Running)
      await capturePreviousLogs(engine(), name, from)
      try {
        await engine().stopContainer(name)
      } catch (err) {
        if (err.status !== 404) throw err
      }
      await engine().removeContainer(name)
    }
  } else if (runtime === 'pm2' && !isReservedPm2Name(config, project.pm2_name)) {
    const proc = await pm2.describe(project.pm2_name).catch(() => null)
    if (proc) {
      wasRunning = proc.pm2_env?.status === 'online'
      await pm2.deleteProcess(project.pm2_name)
    }
  }

  let moved = false
  try {
    if (existsSync(from.root)) {
      renameSync(from.root, to.root)
      moved = true
    }
    db.query('UPDATE projects SET slug = ? WHERE id = ?').run(slug, project.id)
  } catch (err) {
    if (moved) renameSync(to.root, from.root)
    if (wasRunning) await bringUp(project, from).catch(() => {})
    throw err
  }

  // The ecosystem file names the working directory by its absolute path.
  if (existsSync(to.ecosystem)) writeEcosystem(config, renamed)

  let warning = ''
  if (wasRunning) {
    try {
      await bringUp(renamed, to)
    } catch (err) {
      warning = `the app did not start again: ${err.message}`
    }
  }

  // A restricted project with no convoy listed has a network named after
  // its slug; the new container made a new one, the old is nobody's now.
  if (hasEngine) {
    const keep = new Set(projectEngineNetworks(renamed))
    for (const name of projectEngineNetworks(project)) {
      if (name.startsWith(NETWORK_PREFIX) && !keep.has(name)) {
        await engine().removeNetwork(name).catch(() => {}) // still in use, or gone — either is fine
      }
    }
  }
  return { slug, restarted: wasRunning && !warning, warning }
}
