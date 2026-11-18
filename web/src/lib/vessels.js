// What a project's live state comes to at a glance, for anything that sums up
// several projects (a folded pier). One state per project, the most pressing
// first, so the counts add up to the number of vessels.
//
//   underway  a deploy is queued or running
//   down      the process or container is stopped or errored
//   failed    the last voyage failed (the old version may still be serving)
//   ahead     new commits are pushed and not deployed
//   running   online, or a published static site
//   idle      never deployed, not published, or not known yet
export const VESSEL_STATES = [
  { key: 'underway', dot: 'blue pulse', label: n => `${n} under way` },
  { key: 'down', dot: 'red', label: n => `${n} down` },
  { key: 'failed', dot: 'red', label: n => `${n} failed` },
  { key: 'ahead', dot: 'amber', label: n => `${n} with new commits` },
  { key: 'running', dot: 'green', label: n => `${n} running` },
  { key: 'idle', dot: '', label: n => `${n} idle` },
]

// `live` is a project's LiveState entry (store.live.projects[id]).
export function vesselState(live) {
  if (!live) return 'idle'
  if (live.currentDeployment) return 'underway'
  const status = live.pm2?.status
  if (status === 'stopped' || status === 'errored') return 'down'
  if (live.lastDeployment?.status === 'failed') return 'failed'
  if (live.headCommit?.sha && live.headCommit.sha !== live.deployedSha) return 'ahead'
  if (status === 'online' || status === 'published') return 'running'
  return 'idle'
}

// [{ key, dot, text }] for the states present, in VESSEL_STATES order.
export function summarizeVessels(lives) {
  const counts = {}
  for (const live of lives) {
    const key = vesselState(live)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return VESSEL_STATES.filter(s => counts[s.key]).map(s => ({ key: s.key, dot: s.dot, text: s.label(counts[s.key]) }))
}
