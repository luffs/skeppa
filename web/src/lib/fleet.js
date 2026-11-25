import { store } from '../store.js'
import { bytes, timeAgo } from './format.js'
import { vesselState } from './vessels.js'

// What the Fleet's pages say about a server — this panel or one reporting
// here — from its ship (lib/ship.js): its live system record and projects.
// The Fleet list and a server's own page read the same, so they agree.

// Its disk as it last said (the poller's system.disk): how full, and that in
// bytes; null when it has not.
export function diskOf(ship) {
  const d = ship.live.system?.disk
  if (!Number.isFinite(d?.total) || !Number.isFinite(d?.free) || d.total <= 0) return null
  const percent = Math.round(((d.total - d.free) / d.total) * 100)
  return { percent, free: d.free, total: d.total, title: `${bytes(d.free)} free of ${bytes(d.total)}` }
}

// Memory in use, the same way; null when unknown.
export function memoryOf(ship) {
  const m = ship.live.system?.memory
  if (!Number.isFinite(m?.total) || !Number.isFinite(m?.free) || m.total <= 0) return null
  return { percent: Math.round(((m.total - m.free) / m.total) * 100), title: `${bytes(m.total - m.free)} of ${bytes(m.total)}` }
}

// The one-minute load against its cores, as said; '' when unknown.
export function loadOf(ship) {
  const sys = ship.live.system
  if (!Array.isArray(sys?.loadavg)) return ''
  return `${sys.loadavg[0]}${sys.cpuCount ? ` / ${sys.cpuCount}` : ''}`
}

// The chip a disk earns: amber from 80 %, red from 90 % (the server's own
// lib/diskwatch.js notifies at 90).
export function diskTone(disk) {
  if (!disk) return ''
  return disk.percent >= 90 ? 'red' : disk.percent >= 80 ? 'amber' : ''
}

// Its version against this panel's: green the same, amber another.
// `node`: its record, for the fleet protocol — a server whose protocol does
// not meet this panel's is the one thing worse than another commit
// (server nodes/protocol.js), and says which side to update.
export function versionChip(version, node = null) {
  const here = store.live.system?.version ?? ''
  if (node?.protocolGap) {
    const older = node.protocolGap === 'older'
    return {
      text: older ? 'update needed' : 'newer than this panel',
      color: 'red',
      drift: true,
      gap: node.protocolGap,
      title: older
        ? `Its panel${version ? ` (${version})` : ''} speaks fleet protocol ${node.protocol}, older than this panel understands — Update panel brings it level`
        : `Its panel${version ? ` (${version})` : ''} speaks fleet protocol ${node.protocol}, newer than this panel understands — update this panel`,
    }
  }
  if (!version) return null
  if (!here) return { text: version, color: '', title: 'The commit its panel runs' }
  if (version === here) return { text: version, color: 'green', title: 'The same commit as this panel' }
  return { text: `${version} ≠ ${here}`, color: 'amber', drift: true, title: `Its panel runs ${version}, this one ${here}` }
}

// A server's state chip, from its node record (none: this panel, online).
export function stateChip(n) {
  if (!n || n.online) return { text: 'online', color: 'green' }
  if (n.paired) return { text: 'offline', color: 'red' }
  if (n.joinExpiresAt && Date.parse(n.joinExpiresAt) > store.now) return { text: 'waiting to pair', color: 'amber' }
  return { text: 'not paired', color: '' }
}

export function lastSeen(n) {
  return n && !n.online && n.lastSeenAt ? `seen ${timeAgo(n.lastSeenAt)}` : ''
}

// Its vessels: how many, and how many want looking at (down, failed or ahead).
export function vesselsOf(ship) {
  const lives = Object.values(ship.live.projects ?? {}).filter(p => p?.info)
  const attention = lives.filter(p => ['down', 'failed', 'ahead'].includes(vesselState(p))).length
  return { count: lives.length, attention }
}

// Its own panel project: the pm2 project named as its panel
// (system.selfPm2Name). A server installed without one has none, and is
// updated on the server itself.
export function panelOf(ship) {
  const self = ship.live.system?.selfPm2Name
  if (!self) return null
  return Object.values(ship.live.projects ?? {}).find(live =>
    live?.info?.pm2_name === self && (live.info.deployed_runtime || live.info.runtime) === 'pm2') ?? null
}
