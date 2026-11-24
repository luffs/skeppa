import { getSetting, setSetting, setSecretSetting } from '../db/settings.js'
import { decrypt } from './crypto.js'

// Fire-and-forget notifications to one user-configured webhook (Rigging →
// Notifications). Anything that accepts a POST works: ntfy and friends get
// the message as a plain-text body, Discord and Slack are recognized by
// their host and get the JSON shape they insist on. Never throws and never
// blocks the caller — a dead webhook must not slow a deploy or the poller.

// The URL is a bearer credential — anyone holding a Discord or Slack webhook
// URL can post as the panel — and the database gets copied into every
// backup, so it is stored encrypted like ENV values. Values written before
// that change are plain text: read as such, and upgraded once at boot.
function parseSecret(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.value && parsed.iv) return parsed
  } catch { /* legacy plaintext, not a JSON envelope */ }
  return null
}

export function notifyUrl(db, masterKey) {
  const raw = getSetting(db, 'notify_url')
  if (!raw) return ''
  const secret = parseSecret(raw)
  return secret ? decrypt(secret.value, secret.iv, masterKey) : raw
}

// Re-stores a legacy plaintext URL encrypted. True when it did something.
export function upgradeNotifyUrl(db, masterKey) {
  const raw = getSetting(db, 'notify_url')
  if (!raw || parseSecret(raw)) return false
  setSecretSetting(db, masterKey, 'notify_url', raw)
  return true
}

// Matched on the parsed hostname rather than the URL text: `discordapp.com`
// is still live in webhook URLs handed out years ago, and a pattern anchored
// to the whole URL silently stops matching the day a host gains a subdomain.
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'])

// Which platform a URL is, by its parsed host — the body shape and the
// mention syntax both follow from it.
function platformOf(url) {
  const { hostname, pathname } = new URL(url)
  if (DISCORD_HOSTS.has(hostname) && pathname.startsWith('/api/webhooks/')) return 'discord'
  if (hostname === 'hooks.slack.com') return 'slack'
  return 'plain'
}

// The stored mention is platform-neutral (see normalizeMention); each
// platform pings only with its own syntax — Slack ignores a bare "@channel"
// from a webhook, Discord needs "<@id>". A token the platform has no syntax
// for (a Slack ID on Discord) is left out rather than posted as noise.
function formatMention(platform, mention) {
  const out = []
  for (const token of mention.split(' ').filter(Boolean)) {
    const broadcast = token.startsWith('@') ? token.slice(1) : null
    if (platform === 'slack') {
      if (broadcast) out.push(`<!${broadcast}>`)
      else if (/^[UW]/.test(token)) out.push(`<@${token}>`)
      else if (token.startsWith('S')) out.push(`<!subteam^${token}>`)
    } else if (platform === 'discord') {
      if (broadcast) out.push(broadcast === 'here' ? '@here' : '@everyone')
      else if (/^\d+$/.test(token)) out.push(`<@${token}>`)
    } else {
      out.push(token)
    }
  }
  return out.join(' ')
}

function shape(url, text, mention = '') {
  const platform = platformOf(url)
  const ping = mention ? formatMention(platform, mention) : ''
  const full = ping ? `${ping} ${text}` : text
  if (platform === 'discord') return { body: JSON.stringify({ content: full }), type: 'application/json' }
  if (platform === 'slack') return { body: JSON.stringify({ text: full }), type: 'application/json' }
  return { body: full, type: 'text/plain' }
}

// Resolves true when the webhook accepted the message, false on any failure.
// Reading the setting touches SQLite and shaping the body parses the URL, so
// both sit inside the try — neither may escape into the deploy that called us.
export async function sendNotification(db, masterKey, text, { fetchFn = fetch, mention = '' } = {}) {
  try {
    const url = notifyUrl(db, masterKey)
    if (!url) return false
    const { body, type } = shape(url, text, mention)
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) console.error(`[notify] webhook answered ${res.status}`)
    return res.ok
  } catch (err) {
    console.error(`[notify] ${err.message}`)
    return false
  }
}

// What gets sent, per event: `send` turns the event on, `ping` prefixes the
// message with the configured mention. The defaults are what the panel did
// before the choice existed — failures and restart bursts, nobody pinged —
// so an upgrade changes nothing until someone opens the form.
export const NOTIFY_EVENTS = ['deploy_success', 'deploy_failed', 'restart_burst']
const DEFAULT_EVENTS = {
  deploy_success: { send: false, ping: false },
  deploy_failed: { send: true, ping: false },
  restart_burst: { send: true, ping: false },
}

// Who a ping reaches, kept platform-neutral and whitelisted, since it lands
// verbatim in a chat message: @channel, @here, @everyone, a Slack member or
// user-group ID (U…, W…, S…) or a Discord user ID (digits). The forms people
// copy out of a client — "<@U0123ABCD>", "<!here>", "@U0123ABCD" — are
// accepted and stored bare. Returns null when any token is something else.
export function normalizeMention(raw) {
  if (typeof raw !== 'string') return null
  const tokens = raw.split(/[\s,]+/).filter(Boolean)
  if (tokens.length > 10) return null
  const out = []
  for (const t of tokens) {
    const inner = t.replace(/^<?[@!]?/, '').replace(/>$/, '')
    let m
    if ((m = /^(channel|here|everyone)$/i.exec(inner))) out.push(`@${m[1].toLowerCase()}`)
    else if ((m = /^(?:subteam\^)?([UWS][A-Z0-9]{6,20})$/.exec(inner))) out.push(m[1])
    else if ((m = /^(\d{15,25})$/.exec(inner))) out.push(m[1])
    else return null
  }
  return [...new Set(out)].join(' ')
}

export function notifyPrefs(db) {
  let stored = {}
  try {
    stored = JSON.parse(getSetting(db, 'notify_prefs') ?? '{}') ?? {}
  } catch { /* unreadable: defaults */ }
  const events = {}
  for (const key of NOTIFY_EVENTS) {
    const s = stored.events?.[key] ?? {}
    events[key] = {
      send: typeof s.send === 'boolean' ? s.send : DEFAULT_EVENTS[key].send,
      ping: typeof s.ping === 'boolean' ? s.ping : DEFAULT_EVENTS[key].ping,
    }
  }
  return { events, mention: normalizeMention(stored.mention ?? '') ?? '' }
}

// Validates and stores a partial update — { events?: { <event>: { send?, ping? } },
// mention? } — nothing is written unless all of it is valid. Returns an
// error message, or null once stored.
export function saveNotifyPrefs(db, patch) {
  const prefs = notifyPrefs(db)
  if (patch.events !== undefined) {
    if (!patch.events || typeof patch.events !== 'object' || Array.isArray(patch.events)) return 'notify_events must be an object'
    for (const [key, value] of Object.entries(patch.events)) {
      if (!NOTIFY_EVENTS.includes(key)) return `unknown notification event: ${key}`
      if (!value || typeof value !== 'object') return `notify_events.${key} must be an object`
      for (const flag of ['send', 'ping']) {
        if (!(flag in value)) continue
        if (typeof value[flag] !== 'boolean') return `notify_events.${key}.${flag} must be true or false`
        prefs.events[key][flag] = value[flag]
      }
    }
  }
  if (patch.mention !== undefined) {
    const mention = normalizeMention(patch.mention ?? '')
    if (mention == null) return 'notify_mention takes @channel, @here, @everyone, Slack member/group IDs (U…, S…) or Discord user IDs'
    prefs.mention = mention
  }
  setSetting(db, 'notify_prefs', JSON.stringify(prefs))
  return null
}

// One event through the preferences: dropped when the event is off, pinged
// when it asks to be, with the project's address on a line of its own
// (Slack and Discord link it; ntfy shows it as text). Same contract as
// sendNotification — never throws.
export async function notifyEvent(db, masterKey, event, text, { url = '', fetchFn = fetch } = {}) {
  try {
    const { events, mention } = notifyPrefs(db)
    const pref = events[event]
    if (!pref?.send) return false
    const body = url ? `${text}\n${url}` : text
    return await sendNotification(db, masterKey, body, { fetchFn, mention: pref.ping ? mention : '' })
  } catch (err) {
    console.error(`[notify] ${err.message}`)
    return false
  }
}
