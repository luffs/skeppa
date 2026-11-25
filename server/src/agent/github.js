import { GitHubApp } from '../github/appClient.js'

// An agent's GitHub: its own App when it has one configured (Rigging there),
// the master's otherwise — asked over the uplink (agent/uplink.js `ask`,
// answered by nodes/answers.js). With the master's, this server holds no
// private key and no webhook points at it: the master forwards pushes, and
// lends a token for one repo at a time.
//
// Only what deploys and the project form need is lent: tokens (git clone,
// the branch head, branch lists, a repo's root — all inherited from
// GitHubApp, which asks getInstallationToken), which installation covers a
// repo, the repo listing and the App owner. The App's own pages (webhook
// deliveries, the manifest flow) are the master's to show.
export class FleetGitHub extends GitHubApp {
  constructor({ ask, ...rest }) {
    super(rest)
    this._ask = ask
    this._lent = new Map() // repo -> { token, expiresAt (ms) }
  }

  ownApp() {
    return super.isConfigured()
  }

  // Configured either way: deploys of GitHub repos work.
  isConfigured() {
    return true
  }

  async getInstallationToken(repoFullName = null) {
    if (this.ownApp()) return super.getInstallationToken(repoFullName)
    if (!repoFullName) throw new Error('no repo to ask the master for a token for')
    const cached = this._lent.get(repoFullName)
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token
    const { token, expiresAt } = await this._ask('githubToken', { repo: repoFullName })
    this._lent.set(repoFullName, { token, expiresAt: Number(expiresAt) })
    return token
  }

  async getRepoInstallation(repoFullName) {
    if (this.ownApp()) return super.getRepoInstallation(repoFullName)
    return this._ask('githubRepoInstallation', { repo: repoFullName })
  }

  async listRepos(accountLogin = null, { fresh = false } = {}) {
    if (this.ownApp()) return super.listRepos(accountLogin, { fresh })
    return this._ask('githubRepos', { account: accountLogin ?? '', fresh })
  }

  async appOwnerLogin() {
    if (this.ownApp()) return super.appOwnerLogin()
    return this._ask('githubOwner', {}).catch(() => '')
  }

  async _appJwt() {
    if (this.ownApp()) return super._appJwt()
    throw new Error('this server uses the GitHub App of the master it reports to — its App settings are there')
  }

  reset() {
    super.reset()
    this._lent.clear()
  }
}
