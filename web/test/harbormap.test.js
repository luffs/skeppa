import { test, expect } from 'vitest'
import { layoutHarbor, layoutShifts, anyShift, dropTarget, nextBerth, nearestShip, shipName, cargoStacks, isWorn, SHIP_L, SHIP_B, ROW } from '../src/lib/harborMap.js'

// The harbor map's layout: every project gets exactly one place, nothing
// overlaps, nothing runs past the width, and the same harbor always comes
// out the same.
const project = id => ({ id, name: `p${id}` })
const fleet = (key, piers, loose = []) => ({
  key, label: key,
  piers: piers.map(([id, n]) => ({ pier: { id, name: `pier${id}` }, projects: Array.from({ length: n }, (_, i) => project(id * 100 + i)) })),
  loose: loose.map(project),
})
const ships = map => map.fleets.flatMap(f => f.ships)
const overlaps = (a, b) => a.x < b.x + SHIP_L && b.x < a.x + SHIP_L && a.y < b.y + SHIP_B && b.y < a.y + SHIP_B

const harbor = [fleet('mine', [[1, 3], [2, 0], [3, 13]], [7, 8, 9]), fleet('bob', [], [50])]

for (const width of [320, 343, 760, 1200]) {
  test(`at ${width}px: one place each, no overlaps, within the width`, () => {
    const map = layoutHarbor(harbor, width)
    const all = ships(map)
    expect(all.map(s => s.id).sort((a, b) => a - b)).toEqual([7, 8, 9, 50, 100, 101, 102, ...Array.from({ length: 13 }, (_, i) => 300 + i)])
    for (let i = 0; i < all.length; i++) {
      expect(all[i].x).toBeGreaterThanOrEqual(0)
      expect(all[i].x + SHIP_L).toBeLessThanOrEqual(map.width)
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false)
    }
    for (const f of map.fleets) {
      for (const j of f.jetties) expect(j.x + j.w).toBeLessThanOrEqual(map.width)
      for (const q of f.quays) expect(q.x + q.w).toBeLessThanOrEqual(map.width)
    }
    expect(Math.max(...all.map(s => s.y + SHIP_B))).toBeLessThan(map.height)
  })
}

test('the same harbor comes out the same', () => {
  expect(layoutHarbor(harbor, 760)).toEqual(layoutHarbor(harbor, 760))
})

test('a pier is a jetty straight down from the quay, its ships on both sides, bow out', () => {
  const map = layoutHarbor([fleet('f', [[3, 13]])], 760)
  const [jetty, ...more] = map.fleets[0].jetties
  expect(more).toEqual([]) // a long pier grows longer, it does not split
  expect(jetty.name).toBe('pier3')
  expect(jetty.berths).toBe(7)
  expect(jetty.h).toBeGreaterThan(jetty.w * 10)
  expect(jetty.y).toBe(map.fleets[0].quays[0].y + map.fleets[0].quays[0].h) // from the quay's edge

  const all = ships(map)
  expect(all.slice(0, 4).map(s => [s.side, s.dir])).toEqual([['left', -1], ['right', 1], ['left', -1], ['right', 1]])
  // stern to the jetty: the left ones end where it begins, the right ones begin where it ends
  for (const s of all) {
    if (s.side === 'left') expect(s.x + SHIP_L).toBeLessThan(jetty.x)
    else expect(s.x).toBeGreaterThan(jetty.x + jetty.w)
    expect(s.y).toBeGreaterThan(jetty.y)
    expect(s.y + SHIP_B).toBeLessThan(jetty.y + jetty.h)
  }
  // one berth under the other
  expect(all[2].y - all[0].y).toBe(ROW)
  expect(all[1].y).toBe(all[0].y)
})

test('piers stand side by side as far as the width holds, the rest at a quay further down', () => {
  const wide = layoutHarbor([fleet('f', [[1, 2], [2, 2], [3, 2]])], 1200).fleets[0] // 1200 holds three
  expect(wide.quays.length).toBe(1)
  expect(new Set(wide.jetties.map(j => j.y)).size).toBe(1)
  expect(wide.jetties.map(j => j.cx)).toEqual([...wide.jetties.map(j => j.cx)].sort((a, b) => a - b))

  const narrow = layoutHarbor([fleet('f', [[1, 2], [2, 2], [3, 2]])], 760).fleets[0] // 760 holds two
  expect(narrow.quays.map(q => q.shore)).toEqual([true, false]) // the shore, then a mole
  expect(narrow.jetties[2].y).toBeGreaterThan(narrow.jetties[0].y + narrow.jetties[0].h)
  expect(narrow.jetties[2].cx).toBe(narrow.jetties[0].cx)
})

const inside = (s, a) => s.x > a.x && s.x + SHIP_L < a.x + a.w && s.y > a.y && s.y + SHIP_B < a.y + a.h

test('an empty pier still has its jetty, and loose projects lie at anchor', () => {
  const map = layoutHarbor([fleet('f', [[2, 0]], [7, 8])], 320) // one column: nothing free beside the pier
  const f = map.fleets[0]
  expect(f.jetties).toEqual([expect.objectContaining({ pierId: 2, empty: true, name: 'pier2' })])
  expect(f.ships.map(s => s.side)).toEqual(['anchor', 'anchor'])
  expect(f.ships.map(s => s.rot)).toEqual([-2, 2]) // swung either way on the chain
  for (const s of f.ships) expect(inside(s, f.anchorage)).toBe(true)
  // below the pier, the width of the harbor
  expect(f.anchorage.y).toBeGreaterThan(f.jetties[0].y + f.jetties[0].h)
  expect(f.anchorage.w).toBe(320 - 32)
})

test('the anchorage lies in the open water beside the last piers, when a column is free', () => {
  // 1200 holds three piers: two here, so one column free
  const f = layoutHarbor([fleet('f', [[1, 7], [2, 2]], [7, 8, 9])], 1200).fleets[0]
  const edge = f.quays[0].y + f.quays[0].h
  const last = f.jetties[1]
  expect(f.anchorage.x).toBeGreaterThan(last.cx + SHIP_L) // clear of the pier's right-hand ships
  expect(f.anchorage.y).toBeGreaterThan(edge) // off the quay
  expect(f.anchorage.y).toBeLessThan(edge + 40) // …but in the same basin, not under it
  expect(f.anchorage.x + f.anchorage.w).toBeLessThanOrEqual(1200 - 16)
  for (const s of f.ships.filter(s => s.side === 'anchor')) expect(inside(s, f.anchorage)).toBe(true)

  // and the harbor is no taller for it than its longest pier
  const without = layoutHarbor([fleet('f', [[1, 7], [2, 2]])], 1200)
  expect(layoutHarbor([fleet('f', [[1, 7], [2, 2]], [7, 8, 9])], 1200).height).toBe(without.height)

  // every column taken (760 holds two): below, as on a phone
  const full = layoutHarbor([fleet('f', [[1, 2], [2, 2]], [7])], 760).fleets[0]
  expect(full.anchorage.y).toBeGreaterThan(full.jetties[0].y + full.jetties[0].h)
  expect(full.anchorage.x).toBe(16)

  // a fleet with no pier at all: below its quay
  const bare = layoutHarbor([fleet('f', [], [7])], 1200).fleets[0]
  expect(bare.anchorage.x).toBe(16)
  expect(bare.anchorage.y).toBeGreaterThan(bare.quays[0].y + bare.quays[0].h)
})

test('the anchorage takes no more columns than it needs, and the rose the one left over', () => {
  // one pier of seven, two columns free: three at anchor fit in one of them, under the pier's depth
  const map = layoutHarbor([fleet('f', [[1, 7]], [7, 8, 9])], 1200)
  const f = map.fleets[0]
  const cell = (1200 - 32) / 3
  expect(f.anchorage.w).toBeLessThan(cell)
  expect(map.rose.x).toBeGreaterThan(f.anchorage.x + f.anchorage.w)

  // a short pier and many at anchor: both free columns, and no rose
  const crowded = layoutHarbor([fleet('f', [[1, 2]], [7, 8, 9, 10, 11])], 1200)
  expect(crowded.fleets[0].anchorage.w).toBeGreaterThan(cell)
  expect(crowded.rose).toBe(null)
  for (const s of crowded.fleets[0].ships.filter(s => s.side === 'anchor')) expect(inside(s, crowded.fleets[0].anchorage)).toBe(true)
})

test('a container ship is as laden as its memory is used, and worn by restarts', () => {
  const MB = 1024 * 1024
  const live = (memory, over = {}) => ({ info: { runtime: 'container', memory_mb: 512 }, pm2: { status: 'online', memory, restarts: 0 }, ...over })
  expect(cargoStacks(live(40 * MB))).toBe(1)
  expect(cargoStacks(live(200 * MB))).toBe(2)
  expect(cargoStacks(live(400 * MB))).toBe(3)
  expect(cargoStacks(live(900 * MB))).toBe(3) // over its limit is still three
  expect(cargoStacks(live(100 * MB, { info: { runtime: 'container', memory_mb: 128 } }))).toBe(3)
  expect(cargoStacks(live(100 * MB, { info: { runtime: 'container', memory_mb: null } }))).toBe(1) // no limit: of half a gigabyte
  // not running: nothing on deck
  expect(cargoStacks(live(null))).toBe(0)
  expect(cargoStacks({ info: {}, pm2: { status: 'stopped', memory: 40 * MB } })).toBe(0)
  expect(cargoStacks(null)).toBe(0)

  expect(isWorn(live(1, { pm2: { status: 'online', restarts: 2 } }))).toBe(false)
  expect(isWorn(live(1, { pm2: { status: 'online', restarts: 3 } }))).toBe(true)
  // pm2 counts every deploy's reload: no sign of wear
  expect(isWorn({ info: { runtime: 'pm2' }, pm2: { restarts: 40 } })).toBe(false)
  // what runs decides, not what the form says
  expect(isWorn({ info: { runtime: 'static', deployed_runtime: 'container' }, pm2: { restarts: 5 } })).toBe(true)
  expect(isWorn(null)).toBe(false)
})

test('the fleets share the map out between them, top to bottom', () => {
  const map = layoutHarbor(harbor, 760)
  expect(map.fleets[0].top).toBe(0)
  expect(map.fleets[1].top).toBe(map.fleets[0].bottom)
  expect(map.fleets.at(-1).bottom).toBe(map.height)
  for (const f of map.fleets) {
    expect(f.water).toBeGreaterThan(f.top)
    expect(f.water).toBeLessThanOrEqual(f.bottom)
    for (const s of f.ships) expect(s.y + SHIP_B).toBeLessThan(f.water)
  }
})

test('letting go of a dragged ship: another of its fleet’s piers, its open water, or nothing', () => {
  // 760 holds two piers: mine has both columns taken, so its anchorage lies below
  const map = layoutHarbor([fleet('mine', [[1, 3], [2, 0]], [7]), fleet('bob', [[5, 1]], [50])], 760)
  const [mine, bob] = map.fleets
  const [p1, p2] = mine.jetties
  const water = { x: mine.anchorage.x + 300, y: mine.anchorage.y + 40 }

  // ship 100 lies at pier 1. Over pier 2: moor there, at its first berth — left of the jetty, bow out
  expect(dropTarget(map, 100, p2.cx - 40, p2.y + 20)).toEqual({
    kind: 'pier', pierId: 2, name: 'pier2', slot: { dir: -1, x: p2.x - 8 - SHIP_L, y: p2.y + 18 },
  })
  expect(dropTarget(map, 100, p2.cx, p2.y - 20).kind).toBe('pier') // its shed on the quay is the pier too
  expect(dropTarget(map, 100, p2.cx + 100, p2.y + p2.h + 30).kind).toBe('pier') // and a berth further down than its last
  // its own pier: nothing to do
  expect(dropTarget(map, 100, p1.cx + 30, p1.y + 30).kind).toBe('stay')
  // its fleet's open water: leave the pier
  expect(dropTarget(map, 100, water.x, water.y).kind).toBe('anchor')

  // ship 7 lies at anchor: the water is where it is, a pier takes it
  expect(dropTarget(map, 7, water.x, water.y).kind).toBe('stay')
  expect(dropTarget(map, 7, p1.cx, p1.y + 30)).toEqual(expect.objectContaining({ kind: 'pier', pierId: 1 }))
  // …at the berth after the three there: the right-hand one of the second row
  expect(nextBerth(mine, p1)).toEqual({ dir: 1, x: p1.x + p1.w + 8, y: p1.y + 18 + ROW })

  // a pier is its owner's: another fleet's is refused, its water too
  expect(dropTarget(map, 100, bob.jetties[0].cx, bob.jetties[0].y + 20).kind).toBe('foreign')
  expect(dropTarget(map, 50, p1.cx, p1.y + 30).kind).toBe('foreign')
  // the quay away from any pier, off the map, a ship that is not there
  expect(dropTarget(map, 100, (p1.cx + p2.cx) / 2, mine.quays[0].y + 5).kind).toBe('none')
  expect(dropTarget(map, 100, -5, p2.y + 20).kind).toBe('none')
  expect(dropTarget(map, 100, p2.cx, map.height + 10).kind).toBe('none')
  expect(dropTarget(map, 999, p2.cx, p2.y + 20).kind).toBe('none')
})

test('a lighthouse on the shore, and a compass rose only where there is open water', () => {
  const tight = layoutHarbor([fleet('f', [[1, 4], [2, 4]])], 760) // both columns taken
  expect(tight.light).toEqual({ x: 760 - 24, y: tight.fleets[0].quays[0].h })
  expect(tight.rose).toBe(null)

  const open = layoutHarbor([fleet('f', [[1, 4]])], 760) // a free column beside the pier
  const jetty = open.fleets[0].jetties[0]
  expect(open.rose.x).toBeGreaterThan(jetty.cx + SHIP_L)
  expect(open.rose.y - open.rose.r).toBeGreaterThan(jetty.y)
  expect(open.rose.y + open.rose.r).toBeLessThan(jetty.y + jetty.h)

  expect(layoutHarbor([], 760)).toEqual(expect.objectContaining({ light: null, rose: null, fleets: [] }))
})

test('names are cut to what fits', () => {
  expect(shipName('blog')).toBe('blog')
  expect(shipName('skeppa-panel-api-production')).toBe('skeppa-panel-api-p…')
  expect(shipName('skeppa-panel-api', 9)).toBe('skeppa-p…')
})

test('a folded fleet is its quay alone, and the fleets under it move up', () => {
  const open = layoutHarbor(harbor, 760)
  const folded = layoutHarbor([{ ...harbor[0], folded: true }, harbor[1]], 760)
  const [mine, bob] = folded.fleets
  expect(mine).toEqual(expect.objectContaining({ folded: true, jetties: [], ships: [], anchorage: null }))
  expect(mine.quays).toEqual([expect.objectContaining({ shore: true, y: 0 })])
  expect(bob.top).toBe(mine.bottom)
  expect(mine.bottom).toBeLessThan(80)
  expect(folded.height).toBeLessThan(open.height)
  expect(folded.light).toEqual(open.light === null ? null : expect.objectContaining({ x: 760 - 24 }))
  expect(open.fleets[0].folded).toBe(false)
  // bob's ship still has its place
  expect(bob.ships.map(s => s.id)).toEqual([50])
})

test('the arrow keys go to the nearest ship that way', () => {
  // pier 1 with four ships: 100 left, 101 right, 102 left under 100, 103 right under 101; 7 at anchor beside
  const map = layoutHarbor([fleet('f', [[1, 4]], [7])], 1200)
  const all = map.fleets.flatMap(f => f.ships)
  const go = (from, key) => nearestShip(all, from, key)?.id ?? null
  expect(go(100, 'ArrowRight')).toBe(101) // across the jetty
  expect(go(100, 'ArrowDown')).toBe(102) // down its side
  expect(go(102, 'ArrowUp')).toBe(100)
  expect(go(103, 'ArrowLeft')).toBe(102)
  expect(go(101, 'ArrowRight')).toBe(7) // out to the anchorage
  expect(go(100, 'ArrowLeft')).toBe(null) // nothing further that way
  expect(go(100, 'ArrowUp')).toBe(null)
  expect(go(103, 'Home')).toBe(100)
  expect(go(100, 'End')).toBe(7)
  expect(go(999, 'ArrowDown')).toBe(100) // from nowhere: the first
  expect(go(100, 'Enter')).toBe(null)
  expect(nearestShip([], 1, 'Home')).toBe(null)
})

// What a change of the harbor's shape moves, for the map to glide it there:
// a fleet by its top, and inside it what moved against that top.
test('layoutShifts: a jetty growing a berth moves the fleets under it, and nothing beside it', () => {
  const before = layoutHarbor([fleet('mine', [[1, 2], [2, 1]]), fleet('bob', [[5, 1]], [50])], 760)
  const now = layoutHarbor([fleet('mine', [[1, 3], [2, 1]]), fleet('bob', [[5, 1]], [50])], 760)
  const shifts = layoutShifts(before, now)
  expect(shifts.fleets).toEqual({ bob: ROW }) // one berth down
  expect(shifts.ships).toEqual({}) // the new ship is no move, and bob's go with their fleet
  expect(shifts.jetties).toEqual({})
  expect(anyShift(shifts)).toBe(true)
  expect(anyShift(layoutShifts(now, now))).toBe(false)
})

test('layoutShifts: inside a fleet, an anchorage under a grown jetty, and a ship to another pier', () => {
  const before = layoutHarbor([fleet('bob', [[5, 2], [6, 0]], [50])], 760)
  const grown = layoutHarbor([fleet('bob', [[5, 3], [6, 0]], [50])], 760)
  const g = layoutShifts(before, grown)
  expect(g.fleets).toEqual({})
  expect(g.anchorages.bob.dx).toBe(0)
  expect(g.anchorages.bob.dy).toBeGreaterThan(0) // down, under the longer jetty
  expect(g.ships[50]).toEqual(g.anchorages.bob) // at anchor: with its anchorage, step for step

  // ship 500 leaves pier 5 for pier 6: it glides across, 501 takes its berth
  const moved = layoutHarbor([{ ...fleet('bob', [[5, 0], [6, 0]], [50]), piers: [
    { pier: { id: 5, name: 'pier5' }, projects: [project(501)] },
    { pier: { id: 6, name: 'pier6' }, projects: [project(500)] },
  ] }], 760)
  const m = layoutShifts(before, moved)
  expect(m.ships[500].dx).not.toBe(0)
  expect(m.ships[501]).toBeTruthy()
})
