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

// GitHub App client: signs an app JWT, resolves the (single) installation and
// caches installation tokens until shortly before expiry.
export class GitHubApp {
  constructor({ db, config }) {
    this.db = db
    this.config = config
    this._tokenCache = null // { token, expiresAt (ms) }
    this._installationId = null
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
    this._tokenCache = null
    this._installationId = null
  }

  async _fetch(path, { token, jwt, method = 'GET' } = {}) {
    const res = await fetch(`${API}${path}`, {
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
    return res.json()
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

  async getInstallationToken() {
    if (this._tokenCache && this._tokenCache.expiresAt - Date.now() > 60_000) {
      return this._tokenCache.token
    }
    const jwt = await this._appJwt()
    const installationId = await this.getInstallationId()
    const data = await this._fetch(`/app/installations/${installationId}/access_tokens`, {
      jwt,
      method: 'POST',
    })
    this._tokenCache = { token: data.token, expiresAt: new Date(data.expires_at).getTime() }
    return data.token
  }

  // Token plus its expiry, for callers that show the token to the user
  // (e.g. the copy-paste clone command) rather than using it internally.
  async getInstallationTokenInfo() {
    const token = await this.getInstallationToken()
    return { token, expiresAt: this._tokenCache?.expiresAt ?? null }
  }

  async getBranchHead(repoFullName, branch) {
    const token = await this.getInstallationToken()
    const data = await this._fetch(`/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`, { token })
    return {
      sha: data.commit?.sha ?? null,
      message: data.commit?.commit?.message?.split('\n')[0] ?? null,
      pushedAt: data.commit?.commit?.committer?.date ?? null,
    }
  }

  async listRepos() {
    const token = await this.getInstallationToken()
    const repos = []
    for (let page = 1; page <= 10; page++) {
      const data = await this._fetch(`/installation/repositories?per_page=100&page=${page}`, { token })
      repos.push(...data.repositories)
      if (repos.length >= data.total_count || data.repositories.length === 0) break
    }
    return repos.map(r => ({
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
    }))
  }
}
