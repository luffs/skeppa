import { describe, test, expect } from 'vitest'
import { describeAction, processOf, outcomeOf } from '../src/lib/fleetLog.js'

// The Fleet's log in words (lib/fleetLog.js): what a node's life and a
// relayed change come to, and how each went.
describe('the fleet log in words', () => {
  test("a node's life", () => {
    expect(describeAction('created')).toBe('added to the fleet')
    expect(describeAction('new join code')).toBe('made a new join code')
    expect(describeAction('offline')).toBe('went offline')
    expect(describeAction('back')).toBe('reporting again')
  })

  test('relayed changes', () => {
    expect(describeAction('POST /api/projects/3/deploy')).toBe('deployed')
    expect(describeAction('POST /api/projects/3/pm2/restart')).toBe('restart')
    expect(describeAction('PATCH /api/projects/3')).toBe('changed Rigging')
    expect(describeAction('PUT /api/projects/3/env')).toBe('saved the Manifest')
    expect(describeAction('DELETE /api/projects/3')).toBe('scuttled')
    expect(describeAction('POST /api/projects')).toBe('moored a project')
    expect(describeAction('POST /api/groups/2/deploy')).toBe('deployed the pier')
    expect(describeAction('POST /api/images/4/build')).toBe('built')
    expect(describeAction('POST /api/system/pm2/skeppa-proxy/stop')).toBe('stop')
    expect(processOf('POST /api/system/pm2/skeppa-proxy/stop')).toBe('skeppa-proxy')
    expect(describeAction('PUT /api/proxy')).toBe('changed the harbor gate')
    // nothing known: said as it is
    expect(describeAction('POST /api/projects/3/something-new')).toBe('POST /api/projects/3/something-new')
  })

  test('how it went', () => {
    expect(outcomeOf({ action: 'POST /api/projects/3/deploy', status: 202, error: '' })).toEqual({ tone: 'green', text: '✓', why: '' })
    expect(outcomeOf({ action: 'POST /api/projects/3/deploy', status: 400, error: 'validation failed' })).toEqual({ tone: 'red', text: '400', why: 'validation failed' })
    expect(outcomeOf({ action: 'POST /api/users', status: 0, error: 'not through the fleet' })).toEqual({ tone: 'red', text: 'failed', why: 'not through the fleet' })
    expect(outcomeOf({ action: 'paired', status: 0, error: '' }).text).toBe('')
  })
})
