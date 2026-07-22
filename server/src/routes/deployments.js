import { Hono } from 'hono'

export function deploymentRoutes({ db, runner }) {
  const app = new Hono()

  // Includes the stored log; for a running deployment the in-memory collector
  // is more current than the batched DB column, so prefer it.
  app.get('/:id', c => {
    const row = db.query('SELECT * FROM deployments WHERE id = ?').get(Number(c.req.param('id')))
    if (!row) return c.json({ error: 'not found' }, 404)
    const activeLog = runner.getActiveLog(row.id)
    return c.json({ ...row, log: activeLog ?? row.log })
  })

  return app
}
