import { existsSync } from 'node:fs'
import { projectDirs, decryptedEnv, runtimeEnv, writeEcosystem } from './envfiles.js'
import * as realPm2 from './pm2.js'

// After a server reboot the pm2 daemon comes back knowing only what was in its
// dump — which should be just the panel (`pm2 save` while apps run would write
// their decrypted env to ~/.pm2/dump.pm2 in plaintext, see README). So the
// panel brings its own apps back: every project with a start command that pm2
// does not list AT ALL — and whose auto_start flag is set — is started with
// freshly decrypted env. Processes pm2 does list are left alone, which makes
// this a no-op on plain panel restarts and self-deploys; stopping an app
// through the panel clears auto_start, so it stays stopped across a reboot.
//
// It also rewrites each existing ecosystem file on the way through, scrubbing
// the plaintext env blocks that versions before the env-injection change
// baked into them.
export async function resurrectApps({ db, config, pm2 = realPm2, log = console.log }) {
  const projects = db.query('SELECT * FROM projects').all()

  let known
  try {
    known = new Set((await pm2.jlist()).map(p => p.name))
  } catch (err) {
    log(`[resurrect] pm2 unreachable, skipping: ${err.message}`)
    return []
  }

  const started = []
  for (const project of projects) {
    const dirs = projectDirs(config, project)
    // Scrub/refresh only files that already exist — never create app dirs for
    // projects that were never deployed.
    if (existsSync(dirs.ecosystem)) writeEcosystem(config, project)

    if (!project.start_command?.trim()) continue
    if (!project.auto_start) continue
    if (project.pm2_name === config.selfPm2Name) continue
    if (known.has(project.pm2_name)) continue
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
