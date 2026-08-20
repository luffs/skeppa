import { existsSync } from 'node:fs'
import { applyAction } from './pm2.js'
import { projectDirs, decryptedEnv, runtimeEnv } from './envfiles.js'
import { appContainerName, recreateAppContainer } from '../containers/runtime.js'

// start/stop/restart for one project, whichever runtime it uses. The project
// page and the Engine room both drive processes through here so the two
// cannot drift apart — in particular the auto_start bookkeeping ("stopped
// stays stopped" across reboots) belongs to the action, not to the caller.
// `engine` is a getter, so pm2-only installs never touch the socket.
export async function applyProjectAction({ db, config, project, act, engine }) {
  if (project.runtime === 'container') {
    if (act === 'stop') {
      await engine().stopContainer(appContainerName(project.slug))
    } else {
      // start/restart = recreate: containers are disposable and this is the
      // only way stale env is replaced with freshly decrypted values.
      const dirs = projectDirs(config, project)
      if (!existsSync(dirs.source)) {
        throw Object.assign(new Error('deploy the project first'), { status: 400 })
      }
      await recreateAppContainer({
        config,
        project,
        dirs,
        env: runtimeEnv(project, decryptedEnv(db, config, project.id)),
        client: engine(),
        db,
      })
    }
  } else {
    // start/restart re-inject the current ENV set; decrypted only for the
    // duration of the pm2 call, never written anywhere.
    await applyAction(act, project.pm2_name, projectDirs(config, project).ecosystem,
      runtimeEnv(project, decryptedEnv(db, config, project.id)))
  }
  // Stop also turns off start-at-boot; start/restart turn it back on.
  db.query('UPDATE projects SET auto_start = ? WHERE id = ?').run(act === 'stop' ? 0 : 1, project.id)
}
