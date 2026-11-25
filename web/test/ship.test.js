import { describe, test, expect, vi } from 'vitest'
import { relayPath, nodeShip } from '../src/lib/ship.js'
import { api } from '../src/api.js'

// A fleet server's ids go into the paths its ship calls: whatever it reports,
// a call stays on its relay (/api/nodes/<node>/api/…) or is not made.
describe('the relay path', () => {
  test('a plain path is relayed as it is, query and all', () => {
    expect(relayPath(3, '/api/projects/5/deploy')).toBe('/api/nodes/3/api/projects/5/deploy')
    expect(relayPath(3, '/api/images/2/build?detach=1')).toBe('/api/nodes/3/api/images/2/build?detach=1')
    expect(relayPath(3, '/api/projects/5/files?path=docs/../README.md')).toBe('/api/nodes/3/api/projects/5/files?path=docs/../README.md') // the query is the agent's to judge
  })

  test('anything that would leave it is refused', () => {
    for (const evil of [
      '/api/projects/../../../../system/pm2/skeppa-proxy/stop?/deploy',
      '/api/projects/%2e%2e/%2E%2E/%2e%2e/%2e%2e/nodes/5/unpair?',
      '/api/projects/.%2e/x',
      '/api/projects/..\\..\\..\\..\\images/prune',
      '/api/projects/a%2f..%2f..%2fx',
      '/api/projects/a%5cb',
      '/api/projects/./5',
      '/api/projects/%E0%A4%A',
      '/system/pm2/skeppa-proxy/stop',
      'https://elsewhere.example/api/x',
      null,
    ]) expect(relayPath(3, evil)).toBeNull()
  })

  test('a ship refuses the call before anything is sent, and a link goes nowhere', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async () => ({}))
    const ship = nodeShip(3)
    await expect(ship.api.post('/api/projects/../../../../system/pm2/skeppa-proxy/stop?/deploy')).rejects.toMatchObject({ status: 400 })
    expect(post).not.toHaveBeenCalled()
    await ship.api.post('/api/projects/5/deploy')
    expect(post.mock.calls.map(c => c[0])).toEqual(['/api/nodes/3/api/projects/5/deploy'])
    post.mockRestore()
    expect(ship.url('/api/projects/../../x/files/raw')).toBe('#')
    expect(ship.url('/api/projects/5/files/raw?path=a.txt')).toBe('/api/nodes/3/api/projects/5/files/raw?path=a.txt')
  })
})
