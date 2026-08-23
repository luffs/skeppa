import { appLiveStats } from '../containers/runtime.js'
import { roundCpu, roundMem } from './quantize.js'

// The container half of the Engine room. Every container the engine reports —
// panel-owned or not — described in the same vocabulary the poller uses for
// pm2 processes (status/uptime/memory/cpu/restarts/pid), plus the few facts
// that only exist for containers (image, engine state, published ports).
//
// The listing is one call; the per-container numbers are not, so each entry
// costs an inspect and (while running) a stats sample. That is the same price
// the poller already paid per container-runtime project — it now pays it once
// for the whole engine instead, and the project view reads from the result.

// Docker-style names carry a leading slash; podman's compat API mimics it.
export function containerName(entry) {
  const raw = entry?.Names?.[0] ?? entry?.Name ?? ''
  return raw.replace(/^\//, '')
}

// Engine state -> the status vocabulary StatusBadge already knows. The raw
// state rides along untranslated, since "stopped" covers exited, created and
// paused alike and the difference is worth showing.
export function stateToStatus(state) {
  if (state === 'running') return 'online'
  if (state === 'restarting') return 'launching'
  if (!state) return 'unknown'
  return 'stopped'
}

// The ports row answers "how do I reach it", so ceremony that is always the
// same stays out: localhost binds carry no address (publishing on localhost
// is the panel's own guarantee), a 1:1 mapping collapses to the one number,
// and EXPOSEd-but-unpublished ports are dropped — they are not reachable from
// the host, and listing them as if they were misleads. An unusual bind
// address (0.0.0.0, a specific interface) is exactly what deserves to stand
// out, so it keeps its prefix. Deduping folds the v4/v6 halves the engine
// lists separately for one mapping.
export function portLabels(entry) {
  const labels = (entry?.Ports ?? []).flatMap(p => {
    if (!p.PublicPort) return []
    const proto = p.Type ?? 'tcp'
    const mapping = p.PublicPort === p.PrivatePort
      ? `${p.PublicPort}`
      : `${p.PublicPort}→${p.PrivatePort}`
    const local = !p.IP || p.IP === '127.0.0.1' || p.IP === '::1' || p.IP === '::'
    return [`${local ? '' : `${p.IP}:`}${mapping}/${proto}`]
  })
  return [...new Set(labels)].sort()
}

const NO_STATS = { uptime: null, memory: null, cpu: null, restarts: null, pid: null }

// One entry from the listing, joined with its own stats. A failed inspect is
// not fatal: the listing already knows whether the thing is running.
async function describe(engine, entry) {
  const name = containerName(entry)
  const stats = await appLiveStats(engine, name).catch(() => null)
  return [name, {
    ...NO_STATS,
    ...(stats ?? {}),
    // The listing is the fresher of the two — inspect can lose the race with
    // a container that stopped mid-tick.
    status: stateToStatus(entry.State),
    memory: roundMem(stats?.memory),
    cpu: roundCpu(stats?.cpu),
    image: entry.Image ?? '',
    state: entry.State ?? '',
    createdAt: typeof entry.Created === 'number' ? entry.Created * 1000 : null,
    ports: portLabels(entry),
    // Set by the panel on the containers it creates; '' for everything else.
    // The client joins it against its own project list, the same way it joins
    // pm2 process names.
    slug: entry.Labels?.['skeppa.project'] ?? '',
  }]
}

// { containers, error }: containers keyed by name, or null when the engine
// could not be reached at all (which the error string explains).
export async function collectContainers(engine) {
  if (!engine) return { containers: null, error: 'no container engine socket configured' }
  let list
  try {
    list = await engine.listContainers()
  } catch (err) {
    return { containers: null, error: err.message }
  }
  const described = await Promise.all(list.filter(e => containerName(e)).map(e => describe(engine, e)))
  return { containers: Object.fromEntries(described), error: '' }
}
