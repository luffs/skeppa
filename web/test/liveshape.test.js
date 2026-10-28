import { describe, test, expect } from 'vitest'
import { SHAPES } from '../src/live.js'
import { STORE_SHAPES } from '../../server/src/live/stores.js'

// A store is collections of records and singletons, and lazy-storage checks
// the declaration by hash: a client whose top level differs from the
// server's is answered with `shape-mismatch` and never sees the store. The
// two declarations are written out on both sides of the wire — nothing is
// imported across the workspaces at runtime — so this is what keeps them
// equal. The server's own suite pins the values; this pins the agreement.
describe('the client declares the stores as the server does', () => {
  test('every store the client opens has the server shape', () => {
    expect(SHAPES).toEqual(STORE_SHAPES)
  })

  // The distinction that matters on the wire: a collection is records keyed
  // by id, a singleton is one record. `lines` has no choice — a deploy log's
  // values are strings, which no collection could hold.
  test('users and projects are the only collections', () => {
    const collections = Object.values(SHAPES).flatMap(
      s => Object.keys(s.initial).filter(key => !s.singletons.includes(key))
    )
    expect(collections.sort()).toEqual(['projects', 'users'])
  })
})
