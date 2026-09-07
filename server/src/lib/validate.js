// Any input that can reach a shell command or a filesystem path (slugs, branch
// names, pm2 names, cwd) is validated against a strict whitelist. The deploy
// script itself is intentionally arbitrary shell — that is the product — but
// nothing else is.

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
export const PM2_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
// Allows plain names and email addresses: Google sign-in matches the Google
// account's email against the username. Usernames never reach shells or paths.
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/
export const MIN_PASSWORD_LENGTH = 8
export const PM2_ACTIONS = ['start', 'stop', 'restart']
// OCI image reference (registry/repo:tag@digest). Travels via the container
// engine's JSON API, never a shell — this is a sanity check, not an escape.
export const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/
export const RUNTIMES = ['pm2', 'container']

// Multi-tenancy: admins are the panel owner; tenants moor and deploy their
// own container projects and nothing else. The handle namespaces a
// tenant's convoy networks (and later their subdomains), so it gets the
// same whitelist treatment as slugs.
export const ROLES = ['admin', 'tenant']
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/

// Plain-git projects: a public https clone URL, any host. Userinfo is
// rejected on purpose — credentials in a URL would sit plaintext in the
// DB, unlike everything else secret the panel stores. The https:// anchor
// also rules out git argument injection (nothing can start with a dash).
export const GIT_URL_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]{1,300}$/i

// Network profiles for container projects: open = engine default (internet
// as before), restricted = only its convoy networks (no internet, no LAN,
// no host). Convoy names become engine network names, so they get the same
// whitelist treatment as slugs.
export const NETWORK_PROFILES = ['open', 'restricted']
export const NETWORK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

// 'db-net cache' (spaces and/or commas) -> ['db-net', 'cache'], deduped.
// null when any token fails the whitelist - callers treat that as a
// validation error, never as an empty list.
export function parseNetworks(text) {
  if (text == null || text === '') return []
  if (typeof text !== 'string') return null
  const names = [...new Set(text.split(/[\s,]+/).filter(Boolean))]
  return names.every(n => NETWORK_NAME_RE.test(n)) ? names : null
}
// Container names as the engine accepts them. Like image refs these travel
// over the engine's JSON API, never a shell — a sanity check, not an escape.
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidBranch(branch) {
  return typeof branch === 'string' && BRANCH_RE.test(branch) && !branch.includes('..')
}

export function isValidCwd(cwd) {
  if (cwd == null || cwd === '') return true
  if (typeof cwd !== 'string' || cwd.startsWith('/') || cwd.includes('\\')) return false
  return cwd.split('/').every(seg => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '..')
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

// Collects field errors for a project payload; returns {} when everything is valid.
export function validateProject({ name, repo_full_name, git_url, branch, pm2_name, cwd, deploy_script, start_command, build_image, run_image, runtime, subdomain, port, memory_mb, network_profile, host_access, networks }) {
  const errors = {}
  if (typeof name !== 'string' || !name.trim()) errors.name = 'name is required'
  // A project is GitHub-App-backed (owner/repo) or plain-git (https URL) —
  // exactly one. '' plays the unset role for both.
  if (git_url) {
    if (!GIT_URL_RE.test(git_url)) errors.git_url = 'must be a public https:// clone URL, with no credentials in it'
    if (repo_full_name) errors.repo_full_name = 'set either a GitHub repo or a git URL, not both'
  } else if (typeof repo_full_name !== 'string' || !REPO_RE.test(repo_full_name)) {
    errors.repo_full_name = 'must be owner/repo'
  }
  if (!isValidBranch(branch)) errors.branch = 'invalid branch name'
  if (typeof pm2_name !== 'string' || !PM2_NAME_RE.test(pm2_name)) errors.pm2_name = 'letters, digits, dot, dash, underscore only'
  if (!isValidCwd(cwd)) errors.cwd = 'must be a safe relative path'
  if (deploy_script != null && typeof deploy_script !== 'string') errors.deploy_script = 'must be a string'
  if (start_command != null && typeof start_command !== 'string') errors.start_command = 'must be a string'
  if (build_image != null && !IMAGE_RE.test(build_image)) errors.build_image = 'invalid image reference'
  if (run_image != null && !IMAGE_RE.test(run_image)) errors.run_image = 'invalid image reference'
  if (runtime != null && !RUNTIMES.includes(runtime)) errors.runtime = `must be one of ${RUNTIMES.join(', ')}`
  if (subdomain != null && !SUBDOMAIN_RE.test(subdomain)) {
    errors.subdomain = 'lowercase letters, digits and dashes only'
  }
  if (port != null && !isValidPort(port)) errors.port = 'must be a port between 1 and 65535'
  if (memory_mb != null && !(Number.isInteger(memory_mb) && memory_mb >= 16 && memory_mb <= 1024 * 1024)) {
    errors.memory_mb = 'must be a whole number of megabytes, 16 or more'
  }
  if (network_profile != null && !NETWORK_PROFILES.includes(network_profile)) {
    errors.network_profile = `must be one of ${NETWORK_PROFILES.join(', ')}`
  }
  if (networks != null && parseNetworks(networks) == null) {
    errors.networks = 'names are lowercase letters, digits and dashes, separated by spaces'
  }
  // Untested combination, refused rather than silently ignored: the loopback
  // mechanism (slirp allow_host_loopback) only exists in the engine-default
  // network mode, which naming any network (or restricting) replaces.
  if (host_access && (network_profile === 'restricted' || (parseNetworks(networks) ?? []).length)) {
    errors.host_access = 'host access needs the open profile with no shared networks'
  }
  return errors
}
