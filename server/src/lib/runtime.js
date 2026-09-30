// What is live versus what is configured, and the pm2 names no project may
// ever act on.

// The harbor gate's own pm2 process (proxy/index.js starts it under this name).
export const PROXY_PM2_NAME = 'skeppa-proxy'

// `runtime` is what the next deploy will do; `deployed_runtime` is what the
// last successful one did. Until a project has deployed, the two are the same
// question. Everything that acts on what is running right now — the gate's
// route, the status, start/stop, boot resurrection — asks this.
export const liveRuntime = project => project.deployed_runtime || project.runtime

// pm2 processes that belong to the panel, not to a project: its own process
// and the harbor gate. A project's pm2 name is a free-text field (and, for
// projects that are not pm2 processes, derived from a name the owner picks),
// so nothing may ever stop or delete a process on the strength of it alone.
export const isReservedPm2Name = (config, name) => name === PROXY_PM2_NAME || name === config.selfPm2Name
