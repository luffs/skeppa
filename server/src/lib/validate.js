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
export function validateProject({ name, repo_full_name, branch, pm2_name, cwd, deploy_script, start_command, build_image, run_image, runtime, subdomain, port }) {
  const errors = {}
  if (typeof name !== 'string' || !name.trim()) errors.name = 'name is required'
  if (typeof repo_full_name !== 'string' || !REPO_RE.test(repo_full_name)) errors.repo_full_name = 'must be owner/repo'
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
  if (subdomain != null && port == null && !errors.port) errors.port = 'required to route the subdomain'
  return errors
}
