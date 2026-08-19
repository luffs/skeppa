import { Hono } from 'hono'
import { streamText } from 'hono/streaming'
import { SLUG_RE, IMAGE_RE } from '../lib/validate.js'
import { createContainerClient } from '../containers/client.js'
import { managedRef, buildManagedImage, MANAGED_PREFIX } from '../containers/images.js'
import { projectsUsing, getManagedImages, toLocalImages, annotate, syncImages } from '../live/images.js'

// Shipyard API: CRUD for managed images (Containerfile in the DB), builds
// streamed as plain text, plus a read-only view of the engine's local image
// store with a dangling-only prune. Everything engine-side is best-effort —
// the definitions stay editable when the engine is unreachable.
//
// The Shipyard view itself reads LiveState, not this GET — every mutation
// here republishes that section, which is what makes the change show up.

const IMAGE_COLUMNS = 'id, name, containerfile, last_built_at, last_build_status, created_at'

export function imageRoutes({ db, config, liveState = null, containerClient = null }) {
  const app = new Hono()

  let engineInstance = containerClient
  const engine = () => {
    if (!engineInstance) {
      if (!config.containerSocket) {
        throw new Error('no container engine socket configured — see the build sandbox section in the README')
      }
      engineInstance = createContainerClient({ socketPath: config.containerSocket })
    }
    return engineInstance
  }

  const getImage = id => db.query(`SELECT * FROM images WHERE id = ?`).get(Number(id))

  // Republish the Shipyard section after anything that changed it. A missing
  // engine is not an error here — syncImages records it as engine_error and
  // keeps the definitions.
  const syncLive = async () => {
    if (!liveState) return
    let eng = null
    try {
      eng = engine()
    } catch { /* no socket configured */ }
    await syncImages(db, liveState, eng)
  }

  app.get('/', async c => {
    const managed = getManagedImages(db)
    let local = []
    let storeListed = false
    let engineError = null
    try {
      local = toLocalImages(db, await engine().listImages())
      storeListed = true
    } catch (err) {
      engineError = err.message
    }
    // exists/size live only on this REST shape — LiveState keeps the two
    // halves apart and the client joins them.
    annotate(managed, local, storeListed)
    return c.json({ managed, local, engine_error: engineError, default_image: config.buildImage })
  })

  app.post('/', async c => {
    const body = await c.req.json().catch(() => ({}))
    const name = body.name?.trim().toLowerCase() ?? ''
    if (!SLUG_RE.test(name)) {
      return c.json({ error: 'validation failed', fields: { name: 'lowercase letters, digits and dashes only' } }, 400)
    }
    if (db.query('SELECT 1 FROM images WHERE name = ?').get(name)) {
      return c.json({ error: 'validation failed', fields: { name: 'name already in use' } }, 400)
    }
    const containerfile = typeof body.containerfile === 'string' ? body.containerfile : ''
    const { lastInsertRowid } = db.query('INSERT INTO images (name, containerfile) VALUES (?, ?)')
      .run(name, containerfile)
    await syncLive()
    return c.json(db.query(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`).get(Number(lastInsertRowid)), 201)
  })

  // Refresh a registry image in the local store — the panel's `podman pull`.
  // Managed refs are built, never pulled. Registered before /:id routes.
  app.post('/pull', async c => {
    const body = await c.req.json().catch(() => ({}))
    const ref = body.ref?.trim() ?? ''
    if (!IMAGE_RE.test(ref)) return c.json({ error: 'invalid image reference' }, 400)
    if (ref.startsWith(MANAGED_PREFIX)) {
      return c.json({ error: 'managed images are built from their Containerfile, not pulled' }, 400)
    }
    try {
      await engine().pullImage(ref)
      await syncLive()
      return c.json({ ok: true, ref })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })

  // Remove one registry image from the local store (the panel's `podman rmi`).
  // Guarded: managed images go through their card's delete, and anything a
  // project references stays. If a container still uses the image the engine
  // answers 409, which is surfaced instead of forced.
  app.post('/remove', async c => {
    const body = await c.req.json().catch(() => ({}))
    const ref = body.ref?.trim() ?? ''
    if (!IMAGE_RE.test(ref)) return c.json({ error: 'invalid image reference' }, 400)
    if (ref.startsWith(MANAGED_PREFIX)) {
      return c.json({ error: 'managed images are removed from their Shipyard card' }, 400)
    }
    const usedBy = projectsUsing(db, ref)
    if (usedBy.length) return c.json({ error: `image is used by: ${usedBy.join(', ')}` }, 400)
    try {
      await engine().removeImage(ref)
      await syncLive()
      return c.json({ ok: true, ref })
    } catch (err) {
      return c.json({ error: err.message }, err.status === 409 ? 409 : 500)
    }
  })

  // Dangling layers only (the engine's default filter) — never touches tagged
  // images, so it is always safe. Registered before /:id so it wins the match.
  app.post('/prune', async c => {
    try {
      const result = await engine().pruneImages()
      await syncLive()
      return c.json({
        ok: true,
        deleted: (result.ImagesDeleted ?? []).length,
        reclaimed: result.SpaceReclaimed ?? 0,
      })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })

  app.patch('/:id', async c => {
    const image = getImage(c.req.param('id'))
    if (!image) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.containerfile === 'string') {
      db.query('UPDATE images SET containerfile = ? WHERE id = ?').run(body.containerfile, image.id)
      await syncLive()
    }
    return c.json(db.query(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`).get(image.id))
  })

  app.get('/:id/log', c => {
    const image = getImage(c.req.param('id'))
    if (!image) return c.json({ error: 'not found' }, 404)
    return c.json({ log: image.last_build_log, status: image.last_build_status, built_at: image.last_built_at })
  })

  // Build, streaming the log as plain text. The stream always ends with a
  // ✔/✖ marker line; the row's last_build_* fields carry the durable result.
  app.post('/:id/build', async c => {
    const image = getImage(c.req.param('id'))
    if (!image) return c.json({ error: 'not found' }, 404)
    let eng
    try {
      eng = engine()
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
    return streamText(c, async stream => {
      try {
        // Manual builds refresh FROM bases — pressing Build after an upstream
        // release is how a managed image picks the new version up.
        await buildManagedImage({ db, engine: eng, image, pull: true, onLine: line => stream.writeln(line) })
        await stream.writeln('✔ build finished')
      } catch (err) {
        await stream.writeln(`✖ build failed: ${err.message}`)
      }
      // Build status, timestamp and the store's new size, either way.
      await syncLive()
    })
  })

  app.delete('/:id', async c => {
    const image = getImage(c.req.param('id'))
    if (!image) return c.json({ error: 'not found' }, 404)
    const ref = managedRef(image.name)
    const usedBy = projectsUsing(db, ref)
    if (usedBy.length) {
      return c.json({ error: `image is used by: ${usedBy.join(', ')}` }, 400)
    }
    try {
      await engine().removeImage(ref)
    } catch {
      // engine unreachable or image in use by a stopped container — the
      // definition removal is what matters; the layer becomes prunable later
    }
    db.query('DELETE FROM images WHERE id = ?').run(image.id)
    await syncLive()
    return c.json({ ok: true })
  })

  return app
}
