import { getSetting, setSecretSetting } from '../db/settings.js'
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

function shape(url, text) {
  const { hostname, pathname } = new URL(url)
  if (DISCORD_HOSTS.has(hostname) && pathname.startsWith('/api/webhooks/')) {
    return { body: JSON.stringify({ content: text }), type: 'application/json' }
  }
  if (hostname === 'hooks.slack.com') {
    return { body: JSON.stringify({ text }), type: 'application/json' }
  }
  return { body: text, type: 'text/plain' }
}

// Resolves true when the webhook accepted the message, false on any failure.
// Reading the setting touches SQLite and shaping the body parses the URL, so
// both sit inside the try — neither may escape into the deploy that called us.
export async function sendNotification(db, masterKey, text, { fetchFn = fetch } = {}) {
  try {
    const url = notifyUrl(db, masterKey)
    if (!url) return false
    const { body, type } = shape(url, text)
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
