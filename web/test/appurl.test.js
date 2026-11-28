import { test, expect } from 'vitest'
import { appUrlFor } from '../src/store.js'
import { routedHost } from '../../server/src/proxy/index.js'

// The links the panel shows and the hosts the gate routes are built on two
// sides; this holds them to each other for every kind of owner.
const BASE = 'apps.example.com'
const owners = {
  admin: { owner_role: 'admin' },
  handle: { owner_role: 'tenant', owner_handle: 'bob' },
  domain: { owner_role: 'tenant', owner_handle: 'eve', owner_domain: 'eve.dev' },
}

test('the panel links every project where the gate routes it, the apex included', () => {
  for (const owner of Object.values(owners)) {
    for (const subdomain of ['app', '@']) {
      if (subdomain === '@' && owner === owners.handle) continue // refused on save
      const row = { ...owner, subdomain }
      expect(appUrlFor(row, BASE)).toBe(`https://${routedHost(row, BASE)}`)
    }
  }
  expect(appUrlFor({ ...owners.admin, subdomain: '@' }, BASE)).toBe('https://apps.example.com')
  expect(appUrlFor({ ...owners.domain, subdomain: '@' }, BASE)).toBe('https://eve.dev')
  expect(appUrlFor({ ...owners.handle, subdomain: 'app' }, BASE)).toBe('https://app.bob.apps.example.com')
})
