import { managedRef, MANAGED_PREFIX } from '../containers/images.js'

// The Shipyard's data as LiveState carries it, so the view renders from the
// mirror instead of refetching /api/images on arrival and after every one of
// its own mutations — and so it also follows changes it did not cause (a
// self-heal rebuild during a deploy, a project switching build image).
//
// Two halves with very different costs: the definitions come from the DB and
// are always available, the local store needs the container engine and is
// best-effort — the poller refreshes it on a slow lane, and an unreachable
// engine leaves the definitions perfectly editable.

const IMAGE_COLUMNS = 'id, name, containerfile, last_built_at, last_build_status'

// Which projects genuinely depend on an image ref. run_image only counts for
// the container runtime — a pm2 project never reaches resolveRunImage, so a
// value left behind by a runtime switch is not a use, and counting it would
// block the delete (and list the project as a user) on behalf of something
// that cannot run the image. build_image counts unconditionally: the build
// sandbox is a panel-wide setting that can be turned on without touching the
// project.
export function projectsUsing(db, ref) {
  return db.query(
    `SELECT slug FROM projects
     WHERE build_image = ? OR (run_image = ? AND runtime = 'container')`
  ).all(ref, ref).map(r => r.slug)
}

// The DB half: definitions and who uses them. Deliberately no `exists`/`size`
// — those are engine facts, and a lazy-watch diff cannot carry a null inside
// an array (the key is simply dropped), so "unknown" would be indistinguishable
// from "not built". The client joins them against `local` instead.
export function getManagedImages(db) {
  return db.query(`SELECT ${IMAGE_COLUMNS} FROM images ORDER BY name`).all().map(row => ({
    ...row,
    ref: managedRef(row.name),
    used_by: projectsUsing(db, managedRef(row.name)),
  }))
}

export function toLocalImages(db, list) {
  return list.map(img => {
    const tags = (img.RepoTags ?? []).filter(t => t !== '<none>:<none>')
    return {
      id: img.Id,
      tags,
      size: img.Size ?? null,
      dangling: tags.length === 0,
      managed: tags.some(t => t.startsWith(MANAGED_PREFIX)),
      used_by: [...new Set(tags.flatMap(ref => projectsUsing(db, ref)))],
    }
  })
}

// Joins the two halves for the REST view of the same data. `exists` stays
// null — "unknown", which the UI renders as no claim at all — unless a listing
// actually succeeded: without that an unreachable engine would report every
// managed image as missing.
export function annotate(managed, local, storeListed) {
  for (const m of managed) {
    const hit = local.find(l => l.tags.includes(m.ref))
    m.exists = storeListed ? !!hit : null
    m.size = hit?.size ?? null
  }
  return managed
}

export function imagesDefaults(db = null, config = {}) {
  return {
    managed: db ? getManagedImages(db) : [],
    local: [],
    storeListed: false,
    engineError: '',
    defaultImage: config.buildImage ?? '',
  }
}

// Definitions only — no engine call. For the things that change `used_by`
// without touching the image itself: a project created, edited or deleted.
export function syncManagedImages(db, liveState) {
  liveState.images.managed = getManagedImages(db)
}

// Both halves. `engine` may be null (no socket configured), which is reported
// the same way an unreachable one is.
export async function syncImages(db, liveState, engine) {
  const images = liveState.images
  try {
    if (!engine) throw new Error('no container engine socket configured')
    images.local = toLocalImages(db, await engine.listImages())
    images.storeListed = true
    images.engineError = ''
  } catch (err) {
    images.local = []
    images.storeListed = false
    images.engineError = err.message
  }
  syncManagedImages(db, liveState)
}
