import { REPO_RE } from '../lib/validate.js'
import { NOTIFY_EVENTS, notifyEvent } from '../lib/notify.js'

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
//   notify                one of its notifications, sent through this
//                         panel's webhook under its name and by this panel's
//                         per-event settings — for an agent with no webhook
//                         of its own (one setup for the whole fleet)
//
// An agent may be the weaker machine: it is never handed an installation
// token, which reaches every repo the installation holds.

const coded = (code, message) => Object.assign(new Error(message), { code })

// The most notifications a node may send through here in NOTIFY_WINDOW_MS:
// a crash loop over there must not flood the channel.
export const NOTIFY_BURST = 30
export const NOTIFY_WINDOW_MS = 10 * 60_000

export function createFleetAnswers({ github, links, db = null, masterKey = '', notifyFn = notifyEvent, now = Date.now }) {
  const sent = new Map() // node id -> timestamps (ms) of what it sent, the window's

  const repoParam = params => {
    const repo = typeof params?.repo === 'string' ? params.repo.trim() : ''
    if (!REPO_RE.test(repo)) throw coded('bad-request', 'repo must be owner/name')
    return repo
  }
  const needApp = () => {
    if (!github?.isConfigured()) throw coded('unavailable', 'no GitHub App is configured on the master')
  }

  const METHODS = {
    async notify(nodeId, params) {
      if (!db) throw coded('unavailable', 'this panel sends no notifications for others')
      const event = String(params?.event ?? '')
      if (!NOTIFY_EVENTS.includes(event)) throw coded('bad-request', `unknown notification event: ${event.slice(0, 40)}`)
      const text = typeof params?.text === 'string' ? params.text.trim().slice(0, 1500) : ''
      if (!text) throw coded('bad-request', 'nothing to say')
      const url = typeof params?.url === 'string' && /^https?:\/\/\S{1,300}$/.test(params.url) ? params.url : ''
      const t = now()
      const recent = (sent.get(nodeId) ?? []).filter(at => t - at < NOTIFY_WINDOW_MS)
      if (recent.length >= NOTIFY_BURST) throw coded('rate-limited', `more than ${NOTIFY_BURST} notifications in ${NOTIFY_WINDOW_MS / 60_000} minutes`)
      recent.push(t)
      sent.set(nodeId, recent)
      const name = db.query('SELECT name FROM nodes WHERE id = ?').get(Number(nodeId))?.name ?? `server ${nodeId}`
      return { sent: await notifyFn(db, masterKey, event, `${name}: ${text}`, { url }) }
    },
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
