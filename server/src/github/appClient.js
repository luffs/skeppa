import { createSign } from 'node:crypto'
import { getSetting, getSecretSetting } from '../db/settings.js'

const API = 'https://api.github.com'

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

export function makeAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }))
  const data = `${header}.${payload}`
  const signature = createSign('RSA-SHA256').update(data).sign(privateKeyPem)
  return `${data}.${b64url(signature)}`
}

// GitHub App client: signs an app JWT and caches installation tokens until
// shortly before expiry. The app can be installed by more than one account
// (make it public in its GitHub settings and a friend can install it on
// their repo), so tokens are minted per installation and a repo resolves
// to the installation that covers it.
export class GitHubApp {
  constructor({ db, config, fetchFn = fetch }) {
    this.db = db
    this.config = config
    this._fetchFn = fetchFn
    this._tokens = new Map() // installationId -> { token, expiresAt (ms) }
    this._repoInstallations = new Map() // repo_full_name -> installationId
    this._installationId = null // first installation - the no-repo fallback
    this._repos = new Map() // installationId -> { repos, at (ms), pending? } — listRepos' cache
    this._installations = null // { list, at } — the installation list, briefly cached
  }

  credentials() {
    return {
      appId: getSetting(this.db, 'github_app_id'),
      privateKey: getSecretSetting(this.db, this.config.masterKey, 'github_private_key'),
      webhookSecret: getSecretSetting(this.db, this.config.masterKey, 'github_webhook_secret'),
    }
  }

  isConfigured() {
    const { appId, privateKey } = this.credentials()
    return Boolean(appId && privateKey)
  }

  // Call after settings change so new credentials take effect immediately.
  reset() {
    this._tokens.clear()
    this._repoInstallations.clear()
    this._installationId = null
    this._repos.clear()
    this._installations = null
    this._appOwner = null
  }

  // Exchange a one-time code from GitHub's app-manifest creation flow for the
  // new app's credentials (id, slug, pem, webhook_secret, …). Deliberately
  // unauthenticated — the short-lived, single-use code is the proof.
  async convertManifestCode(code) {
    const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'skeppa',
        'x-github-api-version': '2022-11-28',
      },
    })
    if (res.status !== 201) {
      // Non-201 bodies are plain error JSON — credentials only travel on 201.
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub app-manifest conversion failed (${res.status}): ${body.slice(0, 300)}`)
    }
    return res.json()
  }

  async _fetch(path, { token, jwt, method = 'GET' } = {}) {
    const res = await this._fetchFn(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'skeppa',
        'x-github-api-version': '2022-11-28',
        authorization: token ? `token ${token}` : `Bearer ${jwt}`,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${body.slice(0, 300)}`)
    }
    // Some endpoints (webhook redelivery) reply 202 with an empty body.
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  async _appJwt() {
    const { appId, privateKey } = this.credentials()
    if (!appId || !privateKey) throw new Error('GitHub App is not configured — add credentials in Settings')
    return makeAppJwt(appId, privateKey)
  }

  async getInstallationId() {
    if (this._installationId) return this._installationId
    const jwt = await this._appJwt()
    const installations = await this._fetch('/app/installations', { jwt })
    if (!installations.length) {
      throw new Error('The GitHub App has no installations — install it on your account/org first')
    }
    this._installationId = installations[0].id
    return this._installationId
  }

  // Which installation covers a repo. A friend who installed the app on
  // their repo is a second installation; installations[0] only ever covers
  // the panel owner, so anything repo-scoped must resolve through here.
  async getRepoInstallation(repoFullName) {
    const cached = this._repoInstallations.get(repoFullName)
    if (cached) return cached
    const jwt = await this._appJwt()
    let data
    try {
      data = await this._fetch(`/repos/${repoFullName}/installation`, { jwt })
    } catch (err) {
      if (String(err.message).includes('(404)')) {
        throw new Error(`the GitHub App is not installed on ${repoFullName} — its owner has to install it`, { cause: err })
      }
      throw err
    }
    const entry = { id: data.id, account: data.account?.login ?? '' }
    this._repoInstallations.set(repoFullName, entry)
    return entry
  }

  async getInstallationIdForRepo(repoFullName) {
    return (await this.getRepoInstallation(repoFullName)).id
  }

  async _tokenForInstallation(installationId) {
    const cached = this._tokens.get(installationId)
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token
    const jwt = await this._appJwt()
    const data = await this._fetch(`/app/installations/${installationId}/access_tokens`, {
      jwt,
      method: 'POST',
    })
    const entry = { token: data.token, expiresAt: new Date(data.expires_at).getTime() }
    this._tokens.set(installationId, entry)
    return entry.token
  }

  // With a repo, the token comes from the installation covering that repo;
  // without one, from the first installation (panel-owner concerns).
  async getInstallationToken(repoFullName = null) {
    const id = repoFullName
      ? await this.getInstallationIdForRepo(repoFullName)
      : await this.getInstallationId()
    return this._tokenForInstallation(id)
  }

  // App metadata (name, slug, html_url) — the slug builds the install link.
  async getApp() {
    return this._fetch('/app', { jwt: await this._appJwt() })
  }

  // The account the App belongs to — the panel owner's, as a rule: whose
  // repos an admin with no GitHub login of their own counts as theirs in the
  // repo picker. Asked once per credentials; '' when GitHub cannot say.
  async appOwnerLogin() {
    if (this._appOwner == null) {
      this._appOwner = this.getApp().then(app => app?.owner?.login ?? '', () => {
        this._appOwner = null // asked again next time
        return ''
      })
    }
    return this._appOwner
  }

  // Unlike getInstallationId this never throws on "none yet" — the first-run
  // checklist needs to distinguish "not installed" from "broken".
  async listInstallations() {
    return this._fetch('/app/installations', { jwt: await this._appJwt() })
  }

  // GitHub's log of recent webhook deliveries — the authoritative answer to
  // "I pushed and nothing happened".
  async listWebhookDeliveries(perPage = 20) {
    const rows = await this._fetch(`/app/hook/deliveries?per_page=${perPage}`, { jwt: await this._appJwt() })
    return rows.map(d => ({
      id: d.id,
      delivered_at: d.delivered_at,
      event: d.event,
      action: d.action,
      status: d.status,
      status_code: d.status_code,
      redelivery: d.redelivery,
      duration: d.duration,
    }))
  }

  async redeliverWebhookDelivery(deliveryId) {
    return this._fetch(`/app/hook/deliveries/${deliveryId}/attempts`, {
      jwt: await this._appJwt(),
      method: 'POST',
    })
  }

  async getBranchHead(repoFullName, branch) {
    const token = await this.getInstallationToken(repoFullName)
    const data = await this._fetch(`/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`, { token })
    return {
      sha: data.commit?.sha ?? null,
      message: data.commit?.commit?.message?.split('\n')[0] ?? null,
      pushedAt: data.commit?.commit?.committer?.date ?? null,
    }
  }

  // A repository's branches, by name, and which one is its default — what
  // the branch select in the mooring form and Rigging offers. Up to
  // MAX_BRANCH_PAGES pages of 100 (GitHub's branch listing has no total to
  // fetch them all at once); `more` says the list was cut there.
  async listBranches(repoFullName) {
    const token = await this.getInstallationToken(repoFullName)
    const page = n => this._fetch(`/repos/${repoFullName}/branches?per_page=100&page=${n}`, { token })
    const [repo, first] = await Promise.all([this._fetch(`/repos/${repoFullName}`, { token }), page(1)])
    const pages = [first ?? []]
    while (pages.at(-1).length === 100 && pages.length < MAX_BRANCH_PAGES) pages.push((await page(pages.length + 1)) ?? [])
    const names = pages.flat().map(b => b.name).filter(n => typeof n === 'string')
    return {
      default_branch: repo?.default_branch ?? '',
      branches: [...new Set(names)].sort((a, b) => a.localeCompare(b)),
      more: pages.at(-1).length === 100,
    }
  }

  // A repository's root: its file names, and package.json if there is one —
  // what the mooring form's suggestions are read from (lib/suggest.js).
  async readRepoRoot(repoFullName, branch) {
    const token = await this.getInstallationToken(repoFullName)
    const ref = encodeURIComponent(branch)
    const root = await this._fetch(`/repos/${repoFullName}/contents?ref=${ref}`, { token })
    const files = Array.isArray(root) ? root.filter(e => e.type === 'file').map(e => e.name) : []
    let packageJson = null
    if (files.includes('package.json')) {
      const file = await this._fetch(`/repos/${repoFullName}/contents/package.json?ref=${ref}`, { token })
      try {
        packageJson = JSON.parse(Buffer.from(file?.content ?? '', file?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'))
      } catch {
        packageJson = null // not JSON: no suggestions from it
      }
    }
    return { files, packageJson }
  }

  // Every repo across every installation — the panel owner sees a friend-
  // installed repo in the picker exactly like their own.
  // accountLogin scopes the listing to installations owned by that GitHub
  // account — how a tenant sees their repos and nobody else's. null = all.
  //
  // Cached per installation, so the admin's listing and each tenant's share
  // one copy: a listing younger than REPOS_FRESH_MS is answered as it is; an
  // older one is still answered at once while a fresh one is fetched behind
  // it (stale-while-revalidate), so the picker never waits on GitHub after
  // the first time. Webhooks keep it honest in between (forgetRepos on an
  // installation change, notePush on a push), `fresh` skips it (the
  // picker's Refresh). A cold fetch asks for every installation, and every
  // page after the first, at once rather than one after another.
  async listRepos(accountLogin = null, { fresh = false } = {}) {
    let installations = await this._installationsCached(fresh)
    if (!installations.length) {
      throw new Error('The GitHub App has no installations — install it on your account/org first')
    }
    if (accountLogin != null) {
      installations = installations.filter(
        i => i.account?.login?.toLowerCase() === accountLogin.toLowerCase()
      )
    }
    const lists = await Promise.all(installations.map(i => this._installationRepos(i, fresh)))
    return lists.flat().map(r => ({ ...r }))
  }

  // An installation's listing changed (repos added or removed, installed,
  // uninstalled): its cache goes, and the installation list with it. No id
  // forgets everything.
  forgetRepos(installationId = null) {
    this._installations = null
    if (installationId == null) this._repos.clear()
    else this._repos.delete(Number(installationId))
    for (const [repo, entry] of this._repoInstallations) {
      if (installationId == null || entry.id === Number(installationId)) this._repoInstallations.delete(repo)
    }
  }

  // A push moved a repo's last push: the cached row follows, so sorting by
  // last push stays right without refetching anything.
  notePush(repoFullName, pushedAt) {
    for (const entry of this._repos.values()) {
      const row = entry.repos?.find(r => r.full_name === repoFullName)
      if (row) row.pushed_at = pushedAt
    }
  }

  async _installationsCached(fresh) {
    const cached = this._installations
    if (!fresh && cached && Date.now() - cached.at < INSTALLATIONS_FRESH_MS) return cached.list
    const list = await this.listInstallations()
    this._installations = { list, at: Date.now() }
    return list
  }

  async _installationRepos(installation, fresh) {
    const id = installation.id
    const entry = this._repos.get(id)
    if (!fresh && entry?.repos) {
      if (Date.now() - entry.at >= REPOS_FRESH_MS && !entry.pending) {
        // A failed refresh keeps the old listing and tries again next time.
        const refresh = this._fetchInstallationRepos(installation)
          .catch(err => {
            console.error(`[github] refreshing the repos of installation ${id} failed: ${err.message}`)
            return entry.repos
          })
          .finally(() => { if (entry.pending === refresh) delete entry.pending })
        entry.pending = refresh
      }
      return entry.repos
    }
    // Nothing cached (or Refresh): wait for it — and share one fetch between
    // callers asking at the same moment.
    if (!fresh && entry?.pending) return entry.pending
    const pending = this._fetchInstallationRepos(installation)
    this._repos.set(id, { ...(entry ?? {}), pending })
    try {
      return await pending
    } finally {
      const now = this._repos.get(id)
      if (now?.pending === pending) delete now.pending
    }
  }

  async _fetchInstallationRepos(installation) {
    const token = await this._tokenForInstallation(installation.id)
    const page = n => this._fetch(`/installation/repositories?per_page=100&page=${n}`, { token })
    const first = await page(1)
    const pages = Math.min(10, Math.ceil((first.total_count ?? 0) / 100))
    const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => page(i + 2)))
    const repos = [first, ...rest].flatMap(d => d.repositories ?? []).map(mapRepo)
    // The listing says which installation covers each repo — what
    // getRepoInstallation would otherwise ask GitHub about one by one.
    const account = installation.account?.login ?? ''
    for (const r of repos) this._repoInstallations.set(r.full_name, { id: installation.id, account })
    this._repos.set(installation.id, { repos, at: Date.now() })
    return repos
  }
}

// How long a listing is answered without asking GitHub again. Older ones are
// still answered at once, and refreshed behind the answer.
export const REPOS_FRESH_MS = 10 * 60_000
export const MAX_BRANCH_PAGES = 10
const INSTALLATIONS_FRESH_MS = 10 * 60_000

// What the repo picker sorts, groups and describes by — all already in the
// listing, so nothing costs a request of its own. '' rather than null for the
// optional strings, so the client compares without guards.
function mapRepo(r) {
  return {
    full_name: r.full_name,
    owner: r.owner?.login ?? r.full_name.split('/')[0],
    name: r.name ?? r.full_name.split('/')[1],
    private: Boolean(r.private),
    default_branch: r.default_branch,
    pushed_at: r.pushed_at ?? '',
    created_at: r.created_at ?? '',
    description: r.description ?? '',
    language: r.language ?? '',
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
  }
}
