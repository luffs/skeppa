import { parseNetworks } from '../lib/validate.js'

// Convoy networks: named, always-Internal netavark networks that connect the
// containers that share them and nothing else. Internet for the app comes
// from its profile, never from a shared network — so adding a database to a
// convoy can never accidentally grant it egress. Names live on the project
// row (space-separated, validated); the engine store is cache and missing
// networks are recreated from the DB, mirroring how managed images heal.

// Reserved prefix so panel-made networks can never collide with (or shadow)
// networks the admin created by hand.
export const NETWORK_PREFIX = 'skeppa-net-'
export const engineNetworkName = name => `${NETWORK_PREFIX}${name}`

// The engine networks a project's container joins, in create order. Open
// projects with convoy networks also join the engine's default bridge —
// that is what carries their internet once NetworkingConfig is set, since
// naming any network replaces the engine-default (slirp) mode entirely.
// A restricted project with no networks listed gets a convoy of its own,
// named after the slug: "restricted" must isolate even when the user names
// nothing, not fall back to open.
export function projectEngineNetworks(project) {
  if (project.runtime !== 'container') return []
  const named = (parseNetworks(project.networks) ?? []).map(engineNetworkName)
  if (project.network_profile === 'restricted') {
    return named.length ? named : [engineNetworkName(project.slug)]
  }
  return named.length ? ['podman', ...named] : []
}

// Creates whichever convoy networks are missing from the engine store. The
// default bridge ("podman") is the engine's own and never touched.
export async function ensureProjectNetworks(engine, project) {
  for (const name of projectEngineNetworks(project)) {
    if (name.startsWith(NETWORK_PREFIX) && !(await engine.hasNetwork(name))) {
      await engine.createNetwork(name, { internal: true })
    }
  }
}
