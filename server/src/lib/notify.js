import { getSetting } from '../db/settings.js'

// Fire-and-forget notifications to one user-configured webhook (Rigging →
// Notifications). Anything that accepts a POST works: ntfy and friends get
// the message as a plain-text body, Discord and Slack are recognized by
// their URLs and get the JSON shape they insist on. Never throws and never
// blocks the caller — a dead webhook must not slow a deploy or the poller.

export function notifyUrl(db) {
  return getSetting(db, 'notify_url') ?? ''
}

function shape(url, text) {
  if (/^https:\/\/(\w+\.)?discord\.com\/api\/webhooks\//.test(url)) {
    return { body: JSON.stringify({ content: text }), type: 'application/json' }
  }
  if (/^https:\/\/hooks\.slack\.com\//.test(url)) {
    return { body: JSON.stringify({ text }), type: 'application/json' }
  }
  return { body: text, type: 'text/plain' }
}

// Resolves true when the webhook accepted the message, false on any failure.
export async function sendNotification(db, text, { fetchFn = fetch } = {}) {
  const url = notifyUrl(db)
  if (!url) return false
  const { body, type } = shape(url, text)
  try {
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
