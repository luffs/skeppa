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

  // Token plus its expiry, for callers that show the token to the user
  // (e.g. the copy-paste clone command) rather than using it internally.
  async getInstallationTokenInfo(repoFullName = null) {
    const id = repoFullName
      ? await this.getInstallationIdForRepo(repoFullName)
      : await this.getInstallationId()
    const token = await this._tokenForInstallation(id)
    return { token, expiresAt: this._tokens.get(id)?.expiresAt ?? null }
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

  // Every repo across every installation — the panel owner sees a friend-
  // installed repo in the picker exactly like their own.
  // accountLogin scopes the listing to installations owned by that GitHub
  // account — how a tenant sees their repos and nobody else's. null = all.
  async listRepos(accountLogin = null) {
    let installations = await this.listInstallations()
    if (!installations.length) {
      throw new Error('The GitHub App has no installations — install it on your account/org first')
    }
    if (accountLogin != null) {
      installations = installations.filter(
        i => i.account?.login?.toLowerCase() === accountLogin.toLowerCase()
      )
    }
    const repos = []
    for (const installation of installations) {
      const token = await this._tokenForInstallation(installation.id)
      const mine = []
      for (let page = 1; page <= 10; page++) {
        const data = await this._fetch(`/installation/repositories?per_page=100&page=${page}`, { token })
        mine.push(...data.repositories)
        if (mine.length >= data.total_count || data.repositories.length === 0) break
      }
      repos.push(...mine)
    }
    return repos.map(r => ({
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
    }))
  }
}
