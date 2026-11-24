import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, getSetting, setSecretSetting } from '../src/db/settings.js'
import { sendNotification, notifyUrl, upgradeNotifyUrl, normalizeMention, notifyPrefs, saveNotifyPrefs, notifyEvent } from '../src/lib/notify.js'

const KEY = 'a'.repeat(64)

function makeDb(url = null) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  if (url) setSecretSetting(db, KEY, 'notify_url', url)
  return db
}

const capture = (status = 200) => {
  const calls = []
  return {
    calls,
    fetchFn: async (url, opts) => (calls.push({ url, ...opts }), { ok: status < 400, status }),
  }
}

test('no configured URL means no request at all', async () => {
  const { calls, fetchFn } = capture()
  expect(await sendNotification(makeDb(), KEY, 'hello', { fetchFn })).toBe(false)
  expect(calls).toEqual([])
})

test('plain webhooks (ntfy et al) get the text as the body', async () => {
  const { calls, fetchFn } = capture()
  const ok = await sendNotification(makeDb('https://ntfy.sh/my-topic'), KEY, 'app down', { fetchFn })
  expect(ok).toBe(true)
  expect(calls[0].body).toBe('app down')
  expect(calls[0].headers['Content-Type']).toBe('text/plain')
})

test('Discord and Slack are recognized by URL and get their JSON', async () => {
  const { calls, fetchFn } = capture()
  await sendNotification(makeDb('https://discord.com/api/webhooks/1/abc'), KEY, 'boom', { fetchFn })
  expect(JSON.parse(calls[0].body)).toEqual({ content: 'boom' })
  await sendNotification(makeDb('https://hooks.slack.com/services/T/B/x'), KEY, 'boom', { fetchFn })
  expect(JSON.parse(calls[1].body)).toEqual({ text: 'boom' })
})

test('the URL is stored encrypted, and a legacy plaintext value still works until upgraded', () => {
  const db = makeDb()
  setSetting(db, 'notify_url', 'https://ntfy.sh/legacy') // what an older panel wrote
  expect(notifyUrl(db, KEY)).toBe('https://ntfy.sh/legacy')
  expect(upgradeNotifyUrl(db, KEY)).toBe(true)
  expect(getSetting(db, 'notify_url')).not.toContain('ntfy.sh') // no plaintext left for a backup to carry
  expect(notifyUrl(db, KEY)).toBe('https://ntfy.sh/legacy')
  expect(upgradeNotifyUrl(db, KEY)).toBe(false) // idempotent
})

test('a failing webhook is reported as false, never thrown', async () => {
  const db = makeDb('https://ntfy.sh/t')
  expect(await sendNotification(db, KEY, 'x', { fetchFn: capture(500).fetchFn })).toBe(false)
  expect(await sendNotification(db, KEY, 'x', { fetchFn: async () => { throw new Error('refused') } })).toBe(false)
})

test('legacy discordapp.com webhooks get the Discord shape too', async () => {
  const { calls, fetchFn } = capture()
  await sendNotification(makeDb('https://discordapp.com/api/webhooks/1/abc'), KEY, 'boom', { fetchFn })
  expect(JSON.parse(calls[0].body)).toEqual({ content: 'boom' })
  expect(calls[0].headers['Content-Type']).toBe('application/json')
})

test('a host that merely starts with discord.com is not Discord', async () => {
  const { calls, fetchFn } = capture()
  const db = makeDb('https://discord.com.example.net/api/webhooks/1/abc')
  await sendNotification(db, KEY, 'boom', { fetchFn })
  expect(calls[0].body).toBe('boom')
  expect(calls[0].headers['Content-Type']).toBe('text/plain')
})

test('an unparseable stored URL is swallowed, not thrown at the caller', async () => {
  const { calls, fetchFn } = capture()
  expect(await sendNotification(makeDb('not-a-url'), KEY, 'x', { fetchFn })).toBe(false)
  expect(calls).toEqual([])
})

test('mentions are whitelisted and stored bare, whatever form they were copied in', () => {
  expect(normalizeMention('')).toBe('')
  expect(normalizeMention('@Channel')).toBe('@channel')
  expect(normalizeMention('<!here> <@U0123ABCD>, @W0123ABCD')).toBe('@here U0123ABCD W0123ABCD')
  expect(normalizeMention('<!subteam^S0123ABCD>')).toBe('S0123ABCD')
  expect(normalizeMention('<@123456789012345678>')).toBe('123456789012345678')
  expect(normalizeMention('@channel @channel')).toBe('@channel')
  expect(normalizeMention('@rasmus')).toBe(null) // a display name pings nobody from a webhook
  expect(normalizeMention('<https://evil.example|click>')).toBe(null)
  expect(normalizeMention(42)).toBe(null)
})

test('a mention goes out in each platform\'s own syntax', async () => {
  const { calls, fetchFn } = capture()
  const mention = '@channel U0123ABCD S0123ABCD 123456789012345678'
  await sendNotification(makeDb('https://hooks.slack.com/services/T/B/x'), KEY, 'boom', { fetchFn, mention })
  expect(JSON.parse(calls[0].body).text).toBe('<!channel> <@U0123ABCD> <!subteam^S0123ABCD> boom')
  await sendNotification(makeDb('https://discord.com/api/webhooks/1/abc'), KEY, 'boom', { fetchFn, mention })
  expect(JSON.parse(calls[1].body).content).toBe('@everyone <@123456789012345678> boom')
  await sendNotification(makeDb('https://ntfy.sh/t'), KEY, 'boom', { fetchFn, mention: '@here' })
  expect(calls[2].body).toBe('@here boom')
})

test('preferences default to what the panel always sent, and only valid patches are stored', () => {
  const db = makeDb()
  const prefs = notifyPrefs(db)
  expect(prefs.mention).toBe('')
  expect(prefs.events.deploy_success).toEqual({ send: false, ping: false })
  expect(prefs.events.deploy_failed).toEqual({ send: true, ping: false })
  expect(prefs.events.restart_burst).toEqual({ send: true, ping: false })

  expect(saveNotifyPrefs(db, { events: { deploy_success: { send: true } }, mention: '@channel' })).toBe(null)
  expect(notifyPrefs(db).events.deploy_success).toEqual({ send: true, ping: false })
  expect(notifyPrefs(db).mention).toBe('@channel')

  expect(saveNotifyPrefs(db, { events: { nope: { send: true } } })).toContain('unknown')
  expect(saveNotifyPrefs(db, { events: { deploy_failed: { send: 'yes' } } })).toContain('true or false')
  expect(saveNotifyPrefs(db, { mention: '@rasmus' })).toContain('notify_mention')
  expect(notifyPrefs(db).mention).toBe('@channel') // a refused patch writes nothing
  expect(saveNotifyPrefs(db, { mention: null })).toBe(null)
  expect(notifyPrefs(db).mention).toBe('')
})

test('an event is sent only when on, pinged only when asked, with the address on its own line', async () => {
  const db = makeDb('https://hooks.slack.com/services/T/B/x')
  saveNotifyPrefs(db, { events: { restart_burst: { ping: true } }, mention: '@channel' })
  const { calls, fetchFn } = capture()

  expect(await notifyEvent(db, KEY, 'deploy_success', 'shipped', { fetchFn })).toBe(false) // off by default
  expect(calls).toEqual([])

  await notifyEvent(db, KEY, 'deploy_failed', 'broke', { fetchFn, url: 'https://app.example.com' })
  expect(JSON.parse(calls[0].body).text).toBe('broke\nhttps://app.example.com')

  await notifyEvent(db, KEY, 'restart_burst', 'looping', { fetchFn })
  expect(JSON.parse(calls[1].body).text).toBe('<!channel> looping')

  expect(await notifyEvent(db, KEY, 'made_up', 'x', { fetchFn })).toBe(false)
  expect(calls.length).toBe(2)
})
