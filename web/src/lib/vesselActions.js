import { store } from '../store.js'
import { api } from '../api.js'
import { alertDialog, confirmDialog } from './dialog.js'
import { vesselState } from './vessels.js'

// What can be done to a project, decided once for the harbor row and the
// project page alike: the one action its state calls for, and the rest for a
// ⋯ menu. `perform` carries an action out, confirmations included; the
// navigating ones (open the app, Rigging) stay with the caller, which knows
// its router.

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

// The owner's other piers; a project only ever moors at its owner's.
export function otherPiers(project) {
  return Object.values(store.live.groups ?? {})
    .filter(g => g.owner_id === project.owner_id && g.id !== project.group_id)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// The ⋯ menu. `rigging` adds the link to the settings tab (the row has it;
// the page has the tab itself), `piers` the Move to pier section.
export function actionMenu(project, live, { appUrl = '', rigging = false, piers = false } = {}) {
  const underway = vesselState(live) === 'underway'
  const items = [{ key: 'deploy', label: 'Deploy', disabled: underway }]
  if (appUrl) items.push({ key: 'open', label: 'Open app ↗' })
  if (!isStatic(project)) {
    if (live?.pm2?.status === 'online') items.push({ key: 'restart', label: 'Restart' }, { key: 'stop', label: 'Stop…' })
    else items.push({ key: 'start', label: 'Start' })
  }
  if (rigging) items.push({ key: 'rigging', label: 'Rigging' })
  if (piers) {
    const others = otherPiers(project)
    if (others.length || project.group_id != null) {
      items.push({ heading: 'Move to pier' })
      for (const g of others) items.push({ key: `pier:${g.id}`, label: g.name })
      if (project.group_id != null) items.push({ key: 'pier:', label: 'At anchor (no pier)' })
    }
  }
  return items
}

const VERB = { deploy: 'Deploy', start: 'Start', stop: 'Stop', restart: 'Restart' }

// Deploy, start, stop, restart, or a move between piers. Resolves to the
// API's answer ({ id } for a deploy), or null when declined or failed — a
// failure is already said in a dialog.
export async function performAction(project, key) {
  if (key.startsWith('pier:')) {
    const groupId = key.slice(5)
    try {
      return await api.patch(`/api/projects/${project.id}`, { group_id: groupId === '' ? null : Number(groupId) })
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
      ? await api.post(`/api/projects/${project.id}/deploy`)
      : await api.post(`/api/projects/${project.id}/pm2/${key}`)
  } catch (err) {
    alertDialog(`${VERB[key] ?? key} failed: ${err.message}`)
    return null
  }
}
