// Jittery numbers are rounded before they enter LiveState: lazy-watch only
// emits real changes, so values that merely wobble below display precision
// would otherwise produce a diff on every poller tick.
const MB = 1024 * 1024

export const roundCpu = c => (typeof c === 'number' ? Math.round(c) : null)
export const roundMem = b => (typeof b === 'number' ? Math.round(b / MB) * MB : null)
