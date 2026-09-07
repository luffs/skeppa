import { Hono } from 'hono'

export function deploymentRoutes({ db, runner }) {
  const app = new Hono()

  // Includes the stored log; for a running deployment the in-memory collector
  // is more current than the batched DB column, so prefer it.
  app.get('/:id', c => {
    const row = db.query('SELECT * FROM deployments WHERE id = ?').get(Number(c.req.param('id')))
    if (!row) return c.json({ error: 'not found' }, 404)
    // Deploy logs routinely echo env values — a tenant reads only their own.
    const user = c.get('user')
    if (user && user.role !== 'admin') {
      const owner = db.query('SELECT owner_id FROM projects WHERE id = ?').get(row.project_id)
      if (owner?.owner_id !== user.id) return c.json({ error: 'not found' }, 404)
    }
    const activeLog = runner.getActiveLog(row.id)
    return c.json({ ...row, log: activeLog ?? row.log })
  })

  return app
}
