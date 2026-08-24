import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { setSetting } from '../src/db/settings.js'
import { sendNotification } from '../src/lib/notify.js'

function makeDb(url = null) {
  const db = new Database(':memory:')
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)))
  if (url) setSetting(db, 'notify_url', url)
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
  expect(await sendNotification(makeDb(), 'hello', { fetchFn })).toBe(false)
  expect(calls).toEqual([])
})

test('plain webhooks (ntfy et al) get the text as the body', async () => {
  const { calls, fetchFn } = capture()
  const ok = await sendNotification(makeDb('https://ntfy.sh/my-topic'), 'app down', { fetchFn })
  expect(ok).toBe(true)
  expect(calls[0].body).toBe('app down')
  expect(calls[0].headers['Content-Type']).toBe('text/plain')
})

test('Discord and Slack are recognized by URL and get their JSON', async () => {
  const { calls, fetchFn } = capture()
  await sendNotification(makeDb('https://discord.com/api/webhooks/1/abc'), 'boom', { fetchFn })
  expect(JSON.parse(calls[0].body)).toEqual({ content: 'boom' })
  await sendNotification(makeDb('https://hooks.slack.com/services/T/B/x'), 'boom', { fetchFn })
  expect(JSON.parse(calls[1].body)).toEqual({ text: 'boom' })
})

test('a failing webhook is reported as false, never thrown', async () => {
  const db = makeDb('https://ntfy.sh/t')
  expect(await sendNotification(db, 'x', { fetchFn: capture(500).fetchFn })).toBe(false)
  expect(await sendNotification(db, 'x', { fetchFn: async () => { throw new Error('refused') } })).toBe(false)
})

test('legacy discordapp.com webhooks get the Discord shape too', async () => {
  const { calls, fetchFn } = capture()
  await sendNotification(makeDb('https://discordapp.com/api/webhooks/1/abc'), 'boom', { fetchFn })
  expect(JSON.parse(calls[0].body)).toEqual({ content: 'boom' })
  expect(calls[0].headers['Content-Type']).toBe('application/json')
})

test('a host that merely starts with discord.com is not Discord', async () => {
  const { calls, fetchFn } = capture()
  const db = makeDb('https://discord.com.example.net/api/webhooks/1/abc')
  await sendNotification(db, 'boom', { fetchFn })
  expect(calls[0].body).toBe('boom')
  expect(calls[0].headers['Content-Type']).toBe('text/plain')
})

test('an unparseable stored URL is swallowed, not thrown at the caller', async () => {
  const { calls, fetchFn } = capture()
  expect(await sendNotification(makeDb('not-a-url'), 'x', { fetchFn })).toBe(false)
  expect(calls).toEqual([])
})
