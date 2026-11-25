import { REPO_RE } from '../lib/validate.js'

// What this panel tells an agent that asks (nodes/links.js `ask`): its
// GitHub App, lent out. The agent needs no App of its own — no private key
// on that server, no webhook pointing at it — and gets no more than it
// needs:
//
//   githubToken           a token for ONE repository, read-only (contents),
//                         and only one of its own projects deploys (or one
//                         the admin here just asked about through the relay)
//   githubRepoInstallation  which installation covers a repo, and whose
//   githubRepos           the repo listing, for its mooring form
//   githubOwner           the App owner's login (the picker's "mine")
//
// An agent may be the weaker machine: it is never handed an installation
// token, which reaches every repo the installation holds.

const coded = (code, message) => Object.assign(new Error(message), { code })

export function createFleetAnswers({ github, links }) {
  const repoParam = params => {
    const repo = typeof params?.repo === 'string' ? params.repo.trim() : ''
    if (!REPO_RE.test(repo)) throw coded('bad-request', 'repo must be owner/name')
    return repo
  }
  const needApp = () => {
    if (!github?.isConfigured()) throw coded('unavailable', 'no GitHub App is configured on the master')
  }

  const METHODS = {
    async githubToken(nodeId, params) {
      const repo = repoParam(params)
      needApp()
      if (!links.mayUseRepo(nodeId, repo)) throw coded('forbidden', `no project on that server deploys ${repo}`)
      const { token, expiresAt } = await github.getScopedToken(repo)
      return { token, expiresAt }
    },
    async githubRepoInstallation(_nodeId, params) {
      const repo = repoParam(params)
      needApp()
      const { id, account } = await github.getRepoInstallation(repo)
      return { id, account }
    },
    async githubRepos(_nodeId, params) {
      needApp()
      const account = typeof params?.account === 'string' && params.account ? params.account : null
      return github.listRepos(account, { fresh: params?.fresh === true })
    },
    async githubOwner() {
      needApp()
      return (await github.appOwnerLogin?.()) ?? ''
    },
  }

  return {
    METHODS,
    answer(nodeId, method, params) {
      if (!Object.hasOwn(METHODS, method)) throw coded('unknown-method', `this panel does not answer "${method.slice(0, 40)}"`)
      return METHODS[method](nodeId, params)
    },
  }
}
