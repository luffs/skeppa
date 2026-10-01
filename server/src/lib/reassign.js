import { routedHost, proxySettings } from '../proxy/index.js'
import { projectEngineNetworks } from '../containers/networks.js'
import { getProjectInfo } from '../live/state.js'
import { APEX } from './validate.js'

// Moving every project of one crew member to another — what Crew offers
// before removing someone who still owns projects.
//
// A move is more than a new owner_id. The owner decides where a project is
// routed (an admin's flat name, a tenant's handle or own domain), what its
// shared container networks are called, and — for a tenant — what the
// project may be at all. So a move is planned first: blockers refuse it, and
// the changes are shown before anyone confirms.

const USER_COLUMNS = 'id, username, role, handle, domain, github_login'

// Whose names a subdomain competes with: every admin shares the flat
// namespace; a tenant has their own domain's, or else their handle's.
const namespace = u => (u?.role === 'tenant' ? u.domain || u.handle || '' : '')
const asOwnedBy = (project, user) => ({
  ...project, owner_role: user.role, owner_handle: user.handle, owner_domain: user.domain,
})

export function reassignUsers(db, fromId, toId) {
  const get = id => db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) ?? null
  return { from: get(fromId), to: get(toId) }
}

// `from` and `to` are user rows (reassignUsers). Resolves to
// { from, to, projects, blockers, changes }; nothing is written.
export async function planReassign({ db, github = null }, from, to) {
  const projects = db.query('SELECT * FROM projects WHERE owner_id = ? ORDER BY name').all(from.id)
  const { baseDomain } = proxySettings(db)
  const blockers = []
  const changes = []

  for (const p of projects) {
    const refuse = reason => blockers.push({ project: p.name, reason })

    // A tenant's project is a container or a static site, built only from
    // repos of their own GitHub installation — the same rules mooring
    // enforces. Handing a tenant the admin's private repo would let them
    // deploy it and read it in the file viewer.
    if (to.role === 'tenant') {
      if (p.runtime === 'pm2' || p.deployed_runtime === 'pm2') {
        refuse('runs as a pm2 process — a tenant gets containers and static sites only; switch it to a container first')
      }
      if (p.host_access) refuse('has host access, which is admin-only')
      if (p.repo_full_name && !p.git_url) {
        if (!to.github_login) {
          refuse(`is a GitHub repo, and ${to.username} has no linked GitHub account`)
        } else if (!github) {
          refuse('is a GitHub repo, and without the GitHub App there is no telling whose it is')
        } else {
          try {
            const { account } = await github.getRepoInstallation(p.repo_full_name)
            if (account.toLowerCase() !== to.github_login.toLowerCase()) {
              refuse(`is in ${account}'s GitHub installation, not ${to.username}'s — a tenant deploys only their own repos`)
            }
          } catch (err) {
            refuse(`could not check its GitHub installation: ${err.message}`)
          }
        }
      }
    }

    // Routing: the address is built from the owner, so it may change — or
    // collide with something already routed in the new owner's namespace.
    if (p.subdomain === APEX && !(to.role === 'tenant' && to.domain)) {
      refuse(`sits at the root of ${from.domain || 'its owner’s domain'}, and ${to.username} has no domain of their own`)
      continue
    }
    if (p.subdomain && namespace(from) !== namespace(to)) {
      const clash = db.query(
        `SELECT p.name, u.role, u.handle, u.domain FROM projects p LEFT JOIN users u ON u.id = p.owner_id
         WHERE p.subdomain = ? AND (p.owner_id IS NULL OR p.owner_id != ?)`
      ).all(p.subdomain, from.id).find(row => namespace(row) === namespace(to))
      if (clash) refuse(`its subdomain "${p.subdomain}" is already routed for ${to.username} by ${clash.name}`)
    }
    if (baseDomain && p.subdomain) {
      const before = routedHost(asOwnedBy(p, from), baseDomain)
      const after = routedHost(asOwnedBy(p, to), baseDomain)
      if (before !== after) changes.push({ project: p.name, kind: 'address', before: `https://${before}`, after: `https://${after}` })
    }

    // Tenant convoys are namespaced by handle; a running container keeps its
    // networks until the project is next deployed or restarted.
    const netsBefore = projectEngineNetworks(asOwnedBy(p, from))
    const netsAfter = projectEngineNetworks(asOwnedBy(p, to))
    if (netsBefore.join(',') !== netsAfter.join(',')) {
      changes.push({ project: p.name, kind: 'networks', before: netsBefore.join(', '), after: netsAfter.join(', ') })
    }
  }

  const who = u => ({ id: u.id, username: u.username, role: u.role })
  return { from: who(from), to: who(to), projects: projects.map(p => ({ id: p.id, name: p.name })), blockers, changes }
}

// Moves exactly the planned projects. Live info follows at once: the stores
// bridge sees each project change hands, so the old owner's live view loses
// it and the new owner's gains all of it (live/stores.js).
export function applyReassign({ db, liveState }, plan) {
  const ids = plan.projects.map(p => p.id)
  if (!ids.length) return 0
  const { changes } = db.query(
    `UPDATE projects SET owner_id = ? WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(', ')})`
  ).run(plan.to.id, plan.from.id, ...ids)
  for (const id of ids) {
    if (liveState.projects[id]) liveState.projects[id].info = getProjectInfo(db, id)
  }
  return changes
}
