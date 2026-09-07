import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting, getSetting, setSecretSetting } from '../src/db/settings.js'
import { sendNotification, notifyUrl, upgradeNotifyUrl } from '../src/lib/notify.js'

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
