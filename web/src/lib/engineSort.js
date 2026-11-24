// Sorting the Engine room's tables (pm2 processes and containers) by any
// column. Pure, so the order can be tested without mounting the view.

// What each column sorts by, and which way a first click goes: names
// A→Z, readings biggest first — the hungriest process is what one looks for.
export const SORT_COLUMNS = {
  name: { value: r => r.name, first: 'asc' },
  project: { value: r => r.projectLabel, first: 'asc' },
  status: { value: r => statusRank(r.status), first: 'asc' },
  up: { value: r => (r.uptime ? r.now - r.uptime : null), first: 'desc' },
  cpu: { value: r => r.cpu, first: 'desc' },
  mem: { value: r => r.memory, first: 'desc' },
  restarts: { value: r => r.restarts, first: 'desc' },
  pid: { value: r => r.pid || null, first: 'asc' },
}

export const DEFAULT_SORT = { key: 'name', dir: 'asc' }

// Ascending status puts what needs a look first: broken, then down, then on
// its way somewhere, then running; anything unknown last.
const STATUS_RANK = { errored: 0, failed: 0, stopped: 1, launching: 2, stopping: 2, online: 3 }
const statusRank = status => STATUS_RANK[status] ?? 4

// A missing reading ('—' on screen) goes last whichever way the column
// runs: flipping the direction should flip the numbers, not bring the blanks
// to the top. Ties fall back to the name, A→Z, so the order never jitters
// between polls.
export function sortRows(rows, { key, dir } = DEFAULT_SORT, now = Date.now()) {
  const column = SORT_COLUMNS[key] ?? SORT_COLUMNS.name
  const sign = dir === 'desc' ? -1 : 1
  const keyed = rows.map(row => ({ row, v: column.value({ ...row, now }) }))
  keyed.sort((a, b) => {
    const aMissing = a.v == null || a.v === ''
    const bMissing = b.v == null || b.v === ''
    if (aMissing !== bMissing) return aMissing ? 1 : -1
    if (!aMissing) {
      const diff = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v
      if (diff) return sign * diff
    }
    return a.row.name.localeCompare(b.row.name)
  })
  return keyed.map(k => k.row)
}

// A click on a header: the same column flips, another starts its own way.
export function nextSort(current, key) {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: SORT_COLUMNS[key]?.first ?? 'asc' }
}

// Remembered per table in the browser; anything unreadable is the default.
export function loadSort(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (saved && SORT_COLUMNS[saved.key] && (saved.dir === 'asc' || saved.dir === 'desc')) return saved
  } catch { /* unreadable: default */ }
  return { ...DEFAULT_SORT }
}

export function saveSort(storageKey, sort) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sort))
  } catch { /* storage full or blocked: the order just is not remembered */ }
}
