// This panel's disk, watched: a full disk is what most often takes a deploy
// server down (a build that cannot write, a database that cannot grow). Once
// it crosses FULL_PERCENT a notification goes out (`disk_full`), once; when
// it is back under CLEAR_PERCENT, another says so. Every panel watches its
// own — a Fleet agent's goes out through its master like the rest of its
// notifications (index.js sendEvent), named.

export const FULL_PERCENT = 90
export const CLEAR_PERCENT = 85

const gb = n => `${(n / 1e9).toFixed(1)} GB`

// `read()` → { free, total } in bytes (the poller's system.disk), or nothing
// while unknown; `notify(text)` sends. check() once a minute or so.
export function createDiskWatch({ read, notify, full = FULL_PERCENT, clear = CLEAR_PERCENT }) {
  let alerted = false
  return {
    check() {
      const disk = read()
      if (!Number.isFinite(disk?.total) || !Number.isFinite(disk?.free) || disk.total <= 0) return null
      const used = Math.round(((disk.total - disk.free) / disk.total) * 100)
      if (!alerted && used >= full) {
        alerted = true
        notify(`⚠ Disk ${used}% full — ${gb(disk.free)} free of ${gb(disk.total)}. Builds and apps that write will start failing; prune images in the Shipyard or clear space.`)
      } else if (alerted && used < clear) {
        alerted = false
        notify(`✔ Disk back at ${used}% — ${gb(disk.free)} free.`)
      }
      return used
    },
    get alerted() {
      return alerted
    },
  }
}
