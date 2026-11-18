// The repository picker's logic, kept out of the component so it can be
// tested on its own: searching, sorting, grouping by account, and the
// stretches of a name a search matched.

export const REPO_SORTS = [
  { key: 'name', label: 'Name' },
  { key: 'pushed', label: 'Last push' },
  { key: 'created', label: 'Created' },
]

// The search box's words, lowercased; every one has to match somewhere.
export const searchWords = query => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)

// A repo matches when each word is in its owner/name or its description,
// in any order: "skep pan" finds luff/skeppa-panel.
export function matchesRepo(repo, words) {
  if (!words.length) return true
  const hay = `${repo.full_name} ${repo.description ?? ''}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.full_name.localeCompare(b.full_name)
const at = iso => (iso ? new Date(iso).getTime() : 0)

// Name A–Z (case does not matter), or newest first by last push or creation;
// ties fall back to the name, so the order never shuffles between renders.
export function sortRepos(repos, sort = 'name') {
  const list = [...repos]
  if (sort === 'pushed') return list.sort((a, b) => at(b.pushed_at) - at(a.pushed_at) || byName(a, b))
  if (sort === 'created') return list.sort((a, b) => at(b.created_at) - at(a.created_at) || byName(a, b))
  return list.sort(byName)
}

// One group per account, accounts A–Z — but only when there is more than
// one: a single account is just a list, with owner null.
export function groupRepos(sorted) {
  const owners = new Map()
  for (const r of sorted) {
    if (!owners.has(r.owner)) owners.set(r.owner, [])
    owners.get(r.owner).push(r)
  }
  if (owners.size <= 1) return sorted.length ? [{ owner: null, repos: sorted }] : []
  return [...owners.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([owner, repos]) => ({ owner, repos }))
}

// The text cut into [{ text, hit }] pieces where the words occur, for a
// template to wrap the hits in <mark> — plain text pieces, never HTML.
export function highlight(text, words) {
  const s = String(text ?? '')
  const lower = s.toLowerCase()
  const ranges = []
  for (const w of words) {
    // one character on, not a whole word: overlapping occurrences count too
    for (let i = lower.indexOf(w); i !== -1 && w; i = lower.indexOf(w, i + 1)) ranges.push([i, i + w.length])
  }
  if (!ranges.length) return [{ text: s, hit: false }]
  ranges.sort((a, b) => a[0] - b[0])
  const merged = [ranges[0]]
  for (const [from, to] of ranges.slice(1)) {
    const last = merged.at(-1)
    if (from <= last[1]) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  const out = []
  let pos = 0
  for (const [from, to] of merged) {
    if (from > pos) out.push({ text: s.slice(pos, from), hit: false })
    out.push({ text: s.slice(from, to), hit: true })
    pos = to
  }
  if (pos < s.length) out.push({ text: s.slice(pos), hit: false })
  return out
}
