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

// Which projects genuinely depend on an image ref — the same two questions
// the deploy itself asks: `build_image || BUILD_IMAGE` for the sandbox
// (deploy/sandbox.js) and `run_image || build_image || BUILD_IMAGE` for the
// container (containers/runtime.js resolveRunImage). An empty field is not
// "no image", it is the default one, so the default has to count the projects
// that never named it — otherwise the image almost everything builds in is
// the one listed as used by nobody, and nothing warns before it is deleted.
// run_image only counts for the container runtime: a pm2 project never
// reaches resolveRunImage, so a value left behind by a runtime switch is not
// a use. build_image counts unconditionally — the build sandbox is a
// panel-wide setting that can be turned on without touching the project.
export function projectsUsing(db, ref, defaultImage = '') {
  if (!ref) return []
  return db.query(
    `SELECT slug FROM projects
     WHERE COALESCE(NULLIF(build_image, ''), ?) = ?
        OR (runtime = 'container' AND COALESCE(NULLIF(run_image, ''), NULLIF(build_image, ''), ?) = ?)
     ORDER BY slug`
  ).all(defaultImage, ref, defaultImage, ref).map(r => r.slug)
}

// The DB half: definitions and who uses them. Deliberately no `exists`/`size`
// — those are engine facts, and a lazy-watch diff cannot carry a null inside
// an array (the key is simply dropped), so "unknown" would be indistinguishable
// from "not built". The client joins them against `local` instead.
export function getManagedImages(db, defaultImage = '') {
  return db.query(`SELECT ${IMAGE_COLUMNS} FROM images ORDER BY name`).all().map(row => ({
    ...row,
    ref: managedRef(row.name),
    used_by: projectsUsing(db, managedRef(row.name), defaultImage),
  }))
}

// The image's own identity, straight out of the listing. A floating tag says
// none of it: `:1` is a pointer, and two servers on the same tag can hold
// different images. The digest is what the copy actually is, `createdAt` how
// old it is, and the OCI label the version string — when the author published
// one, which many images do not.
const OCI_VERSION_LABEL = 'org.opencontainers.image.version'

// 'docker.io/oven/bun@sha256:ab…' → 'sha256:ab…'; '' when the image was built
// here and never came from a registry.
function repoDigest(img) {
  return (img.RepoDigests ?? []).map(entry => entry.split('@')[1]).find(Boolean) ?? ''
}

export function toLocalImages(db, list, defaultImage = '') {
  return list.map(img => {
    const tags = (img.RepoTags ?? []).filter(t => t !== '<none>:<none>')
    return {
      id: img.Id,
      tags,
      size: img.Size ?? null,
      // Unknown has to be '' rather than null for the strings: a null is a
      // deletion on the wire, and the client cannot tell the key never
      // arrived from the key being removed.
      digest: repoDigest(img),
      version: img.Labels?.[OCI_VERSION_LABEL] ?? '',
      // Seconds in the listing, ms everywhere in the panel.
      createdAt: typeof img.Created === 'number' ? img.Created * 1000 : null,
      dangling: tags.length === 0,
      managed: tags.some(t => t.startsWith(MANAGED_PREFIX)),
      used_by: [...new Set(tags.flatMap(ref => projectsUsing(db, ref, defaultImage)))].sort(),
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
    // A constant, but it rides along so the client can recognize the reserved
    // namespace without hardcoding it on the far side of the wire.
    managedPrefix: MANAGED_PREFIX,
    managed: db ? getManagedImages(db) : [],
    local: [],
    storeListed: false,
    engineError: '',
    defaultImage: config.buildImage ?? '',
  }
}

// The panel's default build image, as LiveState already carries it — so the
// sync functions below need no config of their own and cannot drift from the
// value the client is told about.
const defaultImageOf = liveState => liveState.images?.defaultImage ?? ''

// Definitions only — no engine call. For the things that change `used_by`
// without touching the image itself: a project created, edited or deleted.
export function syncManagedImages(db, liveState) {
  liveState.images.managed = getManagedImages(db, defaultImageOf(liveState))
}

// Both halves. `engine` may be null (no socket configured), which is reported
// the same way an unreachable one is.
export async function syncImages(db, liveState, engine) {
  const images = liveState.images
  try {
    if (!engine) throw new Error('no container engine socket configured')
    images.local = toLocalImages(db, await engine.listImages(), defaultImageOf(liveState))
    images.storeListed = true
    images.engineError = ''
  } catch (err) {
    images.local = []
    images.storeListed = false
    images.engineError = err.message
  }
  syncManagedImages(db, liveState)
}
