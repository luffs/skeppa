import { existsSync, rmSync } from 'node:fs'
import { projectDirs, decryptedEnv, runtimeEnv, writeEcosystem } from './envfiles.js'
import * as realPm2 from './pm2.js'
import { createContainerClient } from '../containers/client.js'
import { appContainerName, recreateAppContainer } from '../containers/runtime.js'

// After a server reboot nothing starts the apps (the pm2 dump holds only the
// panel — see README — and podman is daemonless), so the panel brings its own
// apps back with freshly decrypted env, honoring auto_start: pm2 stop via the
// panel clears the flag, so panel-stopped apps stay stopped across reboots.
//
// pm2 runtime: start projects pm2 does not list AT ALL (listed ones — online
// or stopped — are left alone, making this a no-op on plain panel restarts).
// Container runtime: recreate containers that are not running (podman
// remembers exited containers, but their env is stale — recreation injects
// fresh values, same as a deploy).
//
// Also rewrites/removes ecosystem files on the way through, scrubbing
// plaintext env blocks written by versions before the env-injection change.
export async function resurrectApps({ db, config, pm2 = realPm2, containers = null, log = console.log }) {
  const projects = db.query('SELECT * FROM projects').all()

  let pm2Known = null
  if (projects.some(p => p.runtime !== 'container')) {
    try {
      pm2Known = new Set((await pm2.jlist()).map(p => p.name))
    } catch (err) {
      log(`[resurrect] pm2 unreachable, skipping pm2 apps: ${err.message}`)
    }
  }

  let engine = containers
  if (!engine && config.containerSocket && projects.some(p => p.runtime === 'container')) {
    engine = createContainerClient({ socketPath: config.containerSocket })
  }

  const started = []
  for (const project of projects) {
    const dirs = projectDirs(config, project)

    if (project.runtime === 'container') {
      rmSync(dirs.ecosystem, { force: true }) // stale from a pm2 era
      if (!project.start_command?.trim() || !project.auto_start) continue
      if (!existsSync(dirs.source)) continue
      if (!engine) {
        log(`[resurrect] ${project.slug}: container runtime but no engine socket configured, skipping`)
        continue
      }
      try {
        const existing = await engine.inspectContainer(appContainerName(project.slug))
        if (existing?.State?.Running) continue
        await recreateAppContainer({
          config, project, dirs,
          env: runtimeEnv(project, decryptedEnv(db, config, project.id)),
          client: engine, db,
        })
        started.push(project.pm2_name)
        log(`[resurrect] started container ${appContainerName(project.slug)}`)
      } catch (err) {
        log(`[resurrect] failed to start container ${project.slug}: ${err.message}`)
      }
      continue
    }

    // pm2 runtime. Scrub/refresh only ecosystem files that already exist —
    // never create app dirs for projects that were never deployed.
    if (existsSync(dirs.ecosystem)) writeEcosystem(config, project)

    if (!project.start_command?.trim()) continue
    if (!project.auto_start) continue
    if (project.pm2_name === config.selfPm2Name) continue
    if (pm2Known === null || pm2Known.has(project.pm2_name)) continue
    if (!existsSync(dirs.ecosystem)) continue

    try {
      await pm2.startOrReload(dirs.ecosystem, runtimeEnv(project, decryptedEnv(db, config, project.id)))
      started.push(project.pm2_name)
      log(`[resurrect] started ${project.pm2_name}`)
    } catch (err) {
      log(`[resurrect] failed to start ${project.pm2_name}: ${err.message}`)
    }
  }
  return started
}
