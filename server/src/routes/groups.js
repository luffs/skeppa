import { Hono } from 'hono'
import { normalizeGroupName, GROUP_NAME_MAX } from '../lib/validate.js'
import { getGroupInfo, getProjectInfo, GROUP_INFO_COLUMNS } from '../live/state.js'

// Piers: project groups. Organization only — a pier changes where a project
// is listed, never what it runs, reaches or is routed as. A pier belongs to
// one owner and holds only that owner's projects (the project PATCH checks
// it), so it lives in the owner's fleet store and tenants never see each
// other's. A project joins or leaves a pier through its own PATCH
// (`group_id`); these routes name, rename and remove piers, and deploy
// everything moored at one.
export function groupRoutes({ db, config, liveState, runner }) {
  const app = new Hono()

  // Same rule as projects: 404 rather than 403 for someone else's pier, and
  // no user in context (bare factory in tests) behaves as admin.
  const getGroupFor = c => {
    const group = getGroupInfo(db, c.req.param('id'))
    const user = c.get('user')
    if (group && user && user.role !== 'admin' && group.owner_id !== user.id) return null
    return group
  }

  const nameError = (name, ownerId, excludeId = -1) => {
    if (name == null) return `a name of 1–${GROUP_NAME_MAX} characters`
    const clash = db.query('SELECT 1 FROM project_groups WHERE owner_id = ? AND name = ? COLLATE NOCASE AND id != ?')
      .get(ownerId, name, excludeId)
    return clash ? 'there is already a pier with that name' : ''
  }

  const projectIdsAt = groupId =>
    db.query('SELECT id FROM projects WHERE group_id = ? ORDER BY name').all(groupId).map(r => r.id)

  app.get('/', c => {
    const user = c.get('user')
    if (user && user.role !== 'admin') {
      return c.json(db.query(`SELECT ${GROUP_INFO_COLUMNS} FROM project_groups WHERE owner_id = ? ORDER BY name COLLATE NOCASE`).all(user.id))
    }
    return c.json(db.query(`SELECT ${GROUP_INFO_COLUMNS} FROM project_groups ORDER BY owner_id, name COLLATE NOCASE`).all())
  })

  // A tenant makes piers for themselves. An admin may make one in someone
  // else's fleet — they can edit that person's projects, so they can sort
  // them too — and `owner_id` says whose.
  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const user = c.get('user')
    const admin = !user || user.role === 'admin'
    let ownerId = user?.id ?? null
    if (admin && body.owner_id != null && body.owner_id !== '') {
      ownerId = Number(body.owner_id)
      if (!Number.isInteger(ownerId) || !db.query('SELECT 1 FROM users WHERE id = ?').get(ownerId)) {
        return c.json({ error: 'validation failed', fields: { owner_id: 'no such crew member' } }, 400)
      }
    }
    if (ownerId == null) return c.json({ error: 'validation failed', fields: { owner_id: 'whose pier is this?' } }, 400)
    const name = normalizeGroupName(body.name)
    const error = nameError(name, ownerId)
    if (error) return c.json({ error: 'validation failed', fields: { name: error } }, 400)

    const { lastInsertRowid } = db.query('INSERT INTO project_groups (owner_id, name) VALUES (?, ?)').run(ownerId, name)
    const group = getGroupInfo(db, lastInsertRowid)
    liveState.groups[group.id] = group
    return c.json(group, 201)
  })

  app.patch('/:id', async c => {
    const group = getGroupFor(c)
    if (!group) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    const name = normalizeGroupName(body.name)
    const error = nameError(name, group.owner_id, group.id)
    if (error) return c.json({ error: 'validation failed', fields: { name: error } }, 400)
    db.query('UPDATE project_groups SET name = ? WHERE id = ?').run(name, group.id)
    const updated = getGroupInfo(db, group.id)
    liveState.groups[group.id] = updated
    return c.json(updated)
  })

  // The projects stay, ungrouped: the foreign key clears their group_id, and
  // their live info follows so no card points at a pier that is gone.
  app.delete('/:id', c => {
    const group = getGroupFor(c)
    if (!group) return c.json({ error: 'not found' }, 404)
    const ids = projectIdsAt(group.id)
    db.query('DELETE FROM project_groups WHERE id = ?').run(group.id)
    db.query('UPDATE projects SET group_id = NULL WHERE group_id = ?').run(group.id) // in case foreign keys are off
    for (const id of ids) {
      if (liveState.projects[id]) liveState.projects[id].info = getProjectInfo(db, id)
    }
    delete liveState.groups[group.id]
    return c.json({ ok: true, released: ids.length })
  })

  // Every vessel at the pier sets out — exactly as many Deploy clicks would,
  // each on its own project's queue. The panel's own project is left out: a
  // self-deploy reloads the panel, which would cut the others off mid-way.
  app.post('/:id/deploy', c => {
    const group = getGroupFor(c)
    if (!group) return c.json({ error: 'not found' }, 404)
    const projects = db.query('SELECT id, name, runtime, pm2_name FROM projects WHERE group_id = ? ORDER BY name').all(group.id)
    const deployments = []
    const skipped = []
    for (const p of projects) {
      if (p.runtime === 'pm2' && p.pm2_name === config.selfPm2Name) {
        skipped.push({ project_id: p.id, name: p.name, reason: 'the panel itself — deploy it on its own' })
        continue
      }
      deployments.push({ project_id: p.id, id: runner.enqueue(p.id, { trigger: 'manual' }) })
    }
    return c.json({ deployments, skipped }, 202)
  })

  return app
}
