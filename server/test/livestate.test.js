import { test, expect } from 'bun:test'
import { Hub } from '../src/live/hub.js'

// The Hub carries deploy logs only; live state is covered by livestores.test.js.

function fakeSock() {
  return {
    sent: [],
    send(s) {
      this.sent.push(JSON.parse(s))
    },
  }
}

test('log subscribe/unsubscribe bookkeeping', () => {
  const hub = new Hub()
  const a = fakeSock()
  const b = fakeSock()
  hub.add(a)
  hub.add(b)

  hub.handleMessage(a, JSON.stringify({ type: 'logs:subscribe', deploymentId: 7 }))
  hub.sendLog(7, 'hello')
  expect(a.sent.some(m => m.type === 'logs:line' && m.line === 'hello')).toBe(true)
  expect(b.sent.some(m => m.type === 'logs:line')).toBe(false) // only subscribers get lines

  hub.handleMessage(a, JSON.stringify({ type: 'logs:unsubscribe', deploymentId: 7 }))
  hub.sendLog(7, 'after')
  expect(a.sent.some(m => m.line === 'after')).toBe(false)
  expect(hub.logSubs.size).toBe(0)
})

test('subscribers receive the in-memory backlog on subscribe', () => {
  const hub = new Hub()
  hub.getLogBacklog = id => (id === 7 ? 'line1\nline2\n' : null)
  const sock = fakeSock()
  hub.add(sock)
  hub.handleMessage(sock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 7 }))
  const backlog = sock.sent.find(m => m.type === 'logs:backlog')
  expect(backlog.log).toBe('line1\nline2\n')
})

test('disconnecting cleans up log subscriptions', () => {
  const hub = new Hub()
  const sock = fakeSock()
  hub.add(sock)
  hub.handleMessage(sock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 1 }))
  hub.remove(sock)
  expect(hub.logSubs.size).toBe(0)
  expect(hub.clients.size).toBe(0)
})

test('unknown and malformed messages are ignored', () => {
  const hub = new Hub()
  const sock = fakeSock()
  hub.add(sock)
  hub.handleMessage(sock, 'not json at all')
  hub.handleMessage(sock, JSON.stringify({ type: 'evil:type', deploymentId: 1 }))
  hub.handleMessage(sock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 'not-a-number' }))
  expect(hub.logSubs.size).toBe(0)
  expect(sock.sent).toEqual([]) // nothing is sent on connect: no snapshot lives here
})

test('client count changes drive the poller start/stop hook', () => {
  const events = []
  const hub = new Hub({ onClientsChange: n => events.push(n) })
  const a = fakeSock()
  const b = fakeSock()
  hub.add(a)
  hub.add(b)
  hub.remove(a)
  hub.remove(b)
  expect(events).toEqual([1, 2, 1, 0])
})
