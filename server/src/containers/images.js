import { tarArchive } from '../lib/tar.js'

// Shipyard: images whose Containerfile lives in the panel DB. They build into
// the engine store under a reserved namespace, which makes them recognizable
// — and reproducible: if such an image is missing when a container is created
// (pruned store, fresh server), it is rebuilt from the DB instead of pulled.
// The engine store is cache; the database is the source of truth.

export const MANAGED_PREFIX = 'localhost/skeppa/'

export function managedRef(name) {
  return `${MANAGED_PREFIX}${name}:latest`
}

// 'localhost/skeppa/bun-node:latest' → 'bun-node'; null for anything else.
export function managedNameFromRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(MANAGED_PREFIX)) return null
  return ref.slice(MANAGED_PREFIX.length).replace(/:latest$/, '')
}

// Builds one managed image from its stored Containerfile (the build context
// is an in-memory tar — no files on disk) and records the outcome on the row.
export async function buildManagedImage({ db, engine, image, onLine = () => {} }) {
  const ref = managedRef(image.name)
  const context = tarArchive([{ name: 'Containerfile', content: image.containerfile }])
  const lines = []
  const capture = line => {
    lines.push(line)
    onLine(line)
  }
  try {
    await engine.buildImage(ref, context, capture)
    db.query(`UPDATE images SET last_built_at = ?, last_build_status = 'success', last_build_log = ? WHERE id = ?`)
      .run(new Date().toISOString(), lines.join('\n'), image.id)
  } catch (err) {
    capture(`✖ ${err.message}`)
    db.query(`UPDATE images SET last_built_at = ?, last_build_status = 'failed', last_build_log = ? WHERE id = ?`)
      .run(new Date().toISOString(), lines.join('\n'), image.id)
    throw err
  }
}

// Makes `image` exist in the engine store: managed names rebuild from the DB,
// everything else pulls from its registry.
export async function materializeImage({ engine, image, db = null, onLine = () => {} }) {
  const name = managedNameFromRef(image)
  if (name) {
    const row = db?.query('SELECT * FROM images WHERE name = ?').get(name)
    if (!row) {
      const err = new Error(`image ${image} is Skeppa-managed but not defined in the Shipyard`)
      err.friendly = true
      throw err
    }
    onLine(`building managed image ${image}`)
    await buildManagedImage({ db, engine, image: row, onLine })
    return
  }
  onLine(`pulling image ${image} (first use — this can take a while)`)
  await engine.pullImage(image)
}

// createContainer with the missing-image fallback both runtimes share.
export async function createContainerEnsuringImage({ engine, name, spec, db = null, onLine = () => {} }) {
  try {
    return await engine.createContainer(name, spec)
  } catch (err) {
    if (err.status !== 404) throw err
    await materializeImage({ engine, image: spec.Image, db, onLine })
    return await engine.createContainer(name, spec)
  }
}
