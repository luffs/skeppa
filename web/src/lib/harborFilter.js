import { vesselState } from './vessels.js'

// The harbor's filter: a search over what tells projects apart, and a state
// filter over the same states the rows and folded piers show
// (lib/vessels.js), so "2 need attention" in the summary and the two rows
// it leads to can never disagree.

// A state filter, and which vessel states it lets through.
export const STATE_FILTERS = {
  attention: { label: 'need attention', states: ['down', 'failed', 'ahead'] },
  running: { label: 'running', states: ['running'] },
}

export const filterWords = query => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)

// Every word, in any order, somewhere in the name, the repository, the
// branch, the pier's name or (for an admin) the owner's: "kund api" finds
// the api project at the Kunder pier.
export function matchesSearch(info, words, { pierName = '', ownerName = '' } = {}) {
  if (!words.length) return true
  const hay = [info.name, info.repo_full_name, info.git_url, info.branch, pierName, ownerName]
    .filter(Boolean).join(' ').toLowerCase()
  return words.every(w => hay.includes(w))
}

// '' lets everything through; an unknown key does too.
export function matchesState(live, filter) {
  const f = STATE_FILTERS[filter]
  return !f || f.states.includes(vesselState(live))
}

// How many of `lives` each state filter would show — the summary's numbers.
export function stateCounts(lives) {
  const out = {}
  for (const [key, f] of Object.entries(STATE_FILTERS)) out[key] = lives.filter(l => f.states.includes(vesselState(l))).length
  return out
}
