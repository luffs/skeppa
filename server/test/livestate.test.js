import { test, expect } from 'bun:test'
import { LazyWatch } from 'lazy-watch'
import { Hub } from '../src/live/hub.js'
import { createLiveState, projectDefaults } from '../src/live/state.js'

const tick = () => new Promise(r => setTimeout(r, 0))

function fakeSock() {
  return {
    sent: [],
    send(s) {
      this.sent.push(JSON.parse(s))
    },
  }
}

test('client gets a full snapshot on connect, then diffs that patch a mirror', async () => {
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults()
  LazyWatch.flush(liveState)

  const hub = new Hub({ liveState })
  const sock = fakeSock()
  hub.add(sock)

  expect(sock.sent[0].type).toBe('state:full')
  const mirror = structuredClone(sock.sent[0].state)
  expect(mirror.projects['1'].pm2.status).toBe('unknown')

  liveState.projects[1].pm2.status = 'online'
  liveState.projects[1].currentDeployment = { id: 42, status: 'running', startedAt: 't' }
  LazyWatch.flush(liveState)
  await tick()

  const diffs = sock.sent.filter(m => m.type === 'state')
  expect(diffs.length).toBe(1) // batched into one diff
  for (const { diff } of diffs) LazyWatch.patch(mirror, diff)
  expect(mirror.projects['1'].pm2.status).toBe('online')
  expect(mirror.projects['1'].currentDeployment.id).toBe(42)
})

test('deletions propagate through diffs', async () => {
  const liveState = createLiveState()
  liveState.projects[1] = projectDefaults()
  LazyWatch.flush(liveState)

  const hub = new Hub({ liveState })
  const sock = fakeSock()
  hub.add(sock)
  const mirror = structuredClone(sock.sent[0].state)

  delete liveState.projects[1]
  LazyWatch.flush(liveState)
  await tick()

  for (const m of sock.sent.filter(m => m.type === 'state')) LazyWatch.patch(mirror, m.diff)
  expect(mirror.projects['1']).toBeUndefined()
})

test('log subscribe/unsubscribe bookkeeping', () => {
  const hub = new Hub({ liveState: createLiveState() })
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
  const hub = new Hub({ liveState: createLiveState() })
  hub.getLogBacklog = id => (id === 7 ? 'line1\nline2\n' : null)
  const sock = fakeSock()
  hub.add(sock)
  hub.handleMessage(sock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 7 }))
  const backlog = sock.sent.find(m => m.type === 'logs:backlog')
  expect(backlog.log).toBe('line1\nline2\n')
})

test('disconnecting cleans up log subscriptions', () => {
  const hub = new Hub({ liveState: createLiveState() })
  const sock = fakeSock()
  hub.add(sock)
  hub.handleMessage(sock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 1 }))
  hub.remove(sock)
  expect(hub.logSubs.size).toBe(0)
  expect(hub.clients.size).toBe(0)
})

test('unknown and malformed messages are ignored', () => {
  const hub = new Hub({ liveState: createLiveState() })
  const sock = fakeSock()
  hub.add(sock)
  hub.handleMessage(sock, 'not json at all')
  hub.handleMessage(sock, JSON.stringify({ type: 'evil:type', deploymentId: 1 }))
  hub.handleMessage(sock, JSON.stringify({ type: 'logs:subscribe', deploymentId: 'not-a-number' }))
  expect(hub.logSubs.size).toBe(0)
})

test('client count changes drive the poller start/stop hook', () => {
  const events = []
  const hub = new Hub({ liveState: createLiveState(), onClientsChange: n => events.push(n) })
  const a = fakeSock()
  const b = fakeSock()
  hub.add(a)
  hub.add(b)
  hub.remove(a)
  hub.remove(b)
  expect(events).toEqual([1, 2, 1, 0])
})
