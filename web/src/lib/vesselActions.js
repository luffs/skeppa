import { localShip } from './ship.js'
import { alertDialog, confirmDialog } from './dialog.js'
import { vesselState } from './vessels.js'

// What can be done to a project, decided once for the harbor row and the
// project page alike: the one action its state calls for, and the rest for a
// ⋮ menu. `perform` carries an action out, confirmations included; the
// navigating ones (open the app, Rigging) stay with the caller, which knows
// its router. `ship` is the server the project is on (lib/ship.js): this
// panel unless said otherwise.

const isStatic = project => (project.deployed_runtime || project.runtime) === 'static'

// The button a state asks for, or null when nothing wants doing.
export function primaryAction(project, live) {
  const state = vesselState(live)
  if (state === 'ahead') return { key: 'deploy', label: 'Deploy latest' }
  if (state === 'failed') return { key: 'deploy', label: 'Retry deploy' }
  if (state === 'down' && !isStatic(project)) return { key: 'start', label: 'Start' }
  if (state === 'idle' && !live?.lastDeployment) return { key: 'deploy', label: 'Deploy' }
  return null
}

// The owner's piers, A–Z; a project only ever moors at its owner's.
export function ownerPiers(project, ship = localShip) {
  return Object.values(ship.live.groups ?? {})
    .filter(g => g.owner_id === project.owner_id)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// The voyage a "Last voyage" link opens: the one under way, or the last one.
export const lastVoyageId = live => live?.currentDeployment?.id ?? live?.lastDeployment?.id ?? null

// The ⋮ menu, in groups: what is done most (deploy, restart or start); then,
// with `goto`, where to look (the last voyage's log, the process log,
// Rigging — the row has them, the page has its tabs); with `piers`, where it
// is listed (the current pier ticked, not hidden); and, set apart at the
// end, Stop, the one thing that takes the app down. `exclude` is the key of
// the button next to the menu, which the menu does not repeat; the app's
// address is a link of its own on the row and the page, so it is not here.
export function actionMenu(project, live, { exclude = '', goto = false, piers = false, ship = localShip } = {}) {
  const underway = vesselState(live) === 'underway'
  const running = !isStatic(project) && live?.pm2?.status === 'online'
  const items = []
  const add = item => { if (item.key !== exclude) items.push(item) }

  add({ key: 'deploy', label: 'Deploy', disabled: underway })
  if (running) add({ key: 'restart', label: 'Restart' })
  else if (!isStatic(project)) add({ key: 'start', label: 'Start' })

  if (goto) {
    items.push({ heading: 'Go to' })
    if (lastVoyageId(live)) items.push({ key: 'voyage', label: underway ? 'Voyage under way' : 'Last voyage' })
    if (!isStatic(project)) items.push({ key: 'logbook', label: 'Logbook' })
    items.push({ key: 'rigging', label: 'Rigging' })
  }

  if (piers) {
    const all = ownerPiers(project, ship)
    if (all.length) {
      items.push({ heading: 'Move to pier' })
      for (const g of all) {
        const here = g.id === project.group_id
        items.push({ key: `pier:${g.id}`, label: here ? `✓ ${g.name}` : g.name, disabled: here, hint: here ? 'Moored here now' : '' })
      }
      const anchored = project.group_id == null
      items.push({ key: 'pier:', label: anchored ? '✓ At anchor (no pier)' : 'At anchor (no pier)', disabled: anchored })
    }
  }

  if (running) {
    items.push({ separator: true })
    add({ key: 'stop', label: 'Stop…', danger: true })
  }
  // A heading or a separator with nothing after it says nothing.
  while (items.length && (items.at(-1).heading || items.at(-1).separator)) items.pop()
  return items
}

const VERB = { deploy: 'Deploy', start: 'Start', stop: 'Stop', restart: 'Restart' }

// Deploy, start, stop, restart, or a move between piers. Resolves to the
// API's answer ({ id } for a deploy), or null when declined or failed — a
// failure is already said in a dialog.
export async function performAction(project, key, ship = localShip) {
  if (key.startsWith('pier:')) {
    const groupId = key.slice(5)
    try {
      return await ship.api.patch(`/api/projects/${project.id}`, { group_id: groupId === '' ? null : Number(groupId) })
    } catch (err) {
      const why = err.fields ? Object.values(err.fields).join(', ') : err.message
      alertDialog(`Could not move ${project.name}: ${why}`)
      return null
    }
  }
  if (key === 'stop' && !(await confirmDialog(`Really stop "${project.name}"?`, { confirmLabel: 'Stop' }))) return null
  if (key === 'restart' && !(await confirmDialog(`Restart "${project.name}"?`, { confirmLabel: 'Restart' }))) return null
  try {
    return key === 'deploy'
      ? await ship.api.post(`/api/projects/${project.id}/deploy`)
      : await ship.api.post(`/api/projects/${project.id}/pm2/${key}`)
  } catch (err) {
    alertDialog(`${VERB[key] ?? key} failed: ${err.message}`)
    return null
  }
}
