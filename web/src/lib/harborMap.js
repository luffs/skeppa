// Where everything sits on the harbor map — a pure function of the fleets,
// so the map is the same for the same harbor (ships never shuffle between
// two updates) and can be tested without a browser.
//
// Seen from above, north up: the quay runs along the top and each pier is a
// jetty reaching straight down from it into the water. Ships lie stern-to on
// both sides of their jetty, bow out, one berth under the other, so a pier
// only ever grows longer. As many piers stand side by side as the width
// holds; the rest get a quay of their own further down (a mole, out in the
// water). Projects at no pier lie at anchor: in the open water beside the
// fleet's last piers where the width leaves a column free, below them
// otherwise.
// Every fleet (an owner's projects, for an admin) starts at its own quay.
//
// Units are CSS pixels at 1:1 — the map is laid out for the width it has,
// not scaled — so text stays readable on a phone.

export const SHIP_L = 120 // length (stern to bow) of a berth
export const SHIP_B = 26 // beam
export const NAME_H = 14 // the name under a ship
export const BERTH = 8 // between a ship's stern and its jetty
export const JETTY_W = 16
export const ROW = SHIP_B + NAME_H + 8 // from one berth to the next down a jetty
export const CHAIN = 20 // from an anchored ship's berth to its buoy
const PAD = 16
const COL_W = 2 * (SHIP_L + BERTH) + JETTY_W // a jetty with a ship on each side
const COL_GAP = 28
const LABEL_H = 26 // the fleet's name, on its first quay
const QUAY_H = 38 // the pier sheds stand here
const BARE_QUAY = 10 // a quay with no piers under it
const FOLDED_GAP = 14 // under a folded fleet's quay
const MOLE_INSET = 8
const FIRST = 18 // from the quay's edge to the first berth
const STUB = 44 // an empty pier's jetty
const BASIN_GAP = 30 // open water under a row of piers
const ANCHOR_CELL = SHIP_L + CHAIN + 24
const ANCHOR_ROW = SHIP_B + NAME_H + 20
const ANCHOR_TOP = 34 // from the anchorage's edge to its first ship, its label between
const ANCHOR_OFF = 12 // open water between a quay and an anchorage beside its piers

// How many ships at anchor fit side by side across `w`, buoys included.
const anchoredAcross = w => Math.max(1, Math.floor((w + 8) / ANCHOR_CELL))
// How tall an anchorage of `count` ships is at that width.
const anchorageHeight = (count, w) =>
  ANCHOR_TOP + (Math.ceil(count / anchoredAcross(w)) - 1) * ANCHOR_ROW + SHIP_B + NAME_H + 12

// An anchorage at x, top, w wide: its outline, and `loose` at anchor in it.
function anchor(loose, x, top, w) {
  const perRow = anchoredAcross(w)
  const ships = loose.map((project, i) => {
    const row = Math.floor(i / perRow)
    const col = i % perRow
    return {
      id: project.id,
      project,
      pierId: null,
      side: 'anchor',
      dir: 1,
      x: x + 12 + col * ANCHOR_CELL,
      y: top + ANCHOR_TOP + row * ANCHOR_ROW,
      // swung a little on the anchor chain, one way or the other
      rot: (row + col) % 2 ? 2 : -2,
    }
  })
  const h = anchorageHeight(loose.length, w)
  return { ships, anchorage: { x, y: top, w, h, labelY: top + 19 } }
}

// fleets: [{ key, label, detail, folded, piers: [{ pier, projects }], loose: [project infos] }]
//   folded: only the fleet's quay, its name on it — nothing at its piers or at anchor is laid out
// → { width, height, light, rose, fleets: [{ key, label, detail, folded, labelX, labelY, top, bottom, water, quays, jetties, anchorage, ships }] }
//   top, bottom: the fleet's stretch of the map, quay to the next fleet's quay; water: where what it holds ends
//   quays:   [{ x, y, w, h, shore }]            shore: the land itself (the map's top edge), not a mole
//   jetties: [{ pierId, name, empty, cx, x, y, w, h, berths, firstY }]
//   ships:   [{ id, project, pierId, side: 'left' | 'right' | 'anchor', dir: -1 | 1, x, y, rot }]
//            x, y: the berth's top left; dir: which way the bow points
//   light:   where the lighthouse stands; rose: a compass rose, where there is open water for one
export function layoutHarbor(fleets, width = 900) {
  const W = Math.max(320, Math.floor(width))
  const usable = W - 2 * PAD
  const cols = Math.max(1, Math.floor((usable + COL_GAP) / (COL_W + COL_GAP)))
  const cell = usable / cols
  const out = []
  let light = null
  let rose = null
  let y = 0

  fleets.forEach((fleet, n) => {
    const quays = []
    const jetties = []
    const ships = []
    let anchorage = null
    const top = y
    const labelX = (n === 0 ? 0 : MOLE_INSET) + 14
    const labelY = y + 18

    if (fleet.folded) {
      const shore = n === 0
      const h = LABEL_H + BARE_QUAY
      quays.push({ x: shore ? 0 : MOLE_INSET, y, w: shore ? W : W - 2 * MOLE_INSET, h, shore })
      if (shore) light = { x: W - 24, y: y + h }
      y += h + FOLDED_GAP
      out.push({ key: fleet.key, label: fleet.label, detail: fleet.detail ?? '', folded: true, labelX, labelY, top, bottom: y, water: y - FOLDED_GAP, quays, jetties, anchorage, ships })
      return
    }

    // as many piers side by side as the width holds; a fleet with none
    // still has its quay, for its name
    const rows = []
    for (let i = 0; i < fleet.piers.length; i += cols) rows.push(fleet.piers.slice(i, i + cols))
    if (!rows.length) rows.push([])

    rows.forEach((row, r) => {
      const shore = n === 0 && r === 0
      const h = (r === 0 ? LABEL_H : 0) + (row.length ? QUAY_H : BARE_QUAY)
      quays.push({ x: shore ? 0 : MOLE_INSET, y, w: shore ? W : W - 2 * MOLE_INSET, h, shore })
      const edge = y + h
      if (shore) light = { x: W - 24, y: edge }
      let bottom = edge

      row.forEach(({ pier, projects }, c) => {
        const cx = Math.round(PAD + cell * (c + 0.5))
        const berths = Math.ceil(projects.length / 2)
        const jh = projects.length ? FIRST + (berths - 1) * ROW + SHIP_B + NAME_H : STUB
        jetties.push({
          pierId: pier.id,
          name: pier.name,
          empty: projects.length === 0,
          cx,
          x: cx - JETTY_W / 2,
          y: edge,
          w: JETTY_W,
          h: jh,
          berths,
          firstY: edge + FIRST + SHIP_B / 2, // the first berth's bollard
        })
        projects.forEach((project, i) => {
          const left = i % 2 === 0
          ships.push({
            id: project.id,
            project,
            pierId: pier.id,
            side: left ? 'left' : 'right',
            dir: left ? -1 : 1,
            x: left ? cx - JETTY_W / 2 - BERTH - SHIP_L : cx + JETTY_W / 2 + BERTH,
            y: edge + FIRST + Math.floor(i / 2) * ROW,
            rot: 0,
          })
        })
        // an empty pier says so under its jetty
        bottom = Math.max(bottom, edge + jh + (projects.length ? 0 : 22))
      })

      // The fleet's last piers leave columns free: its ships at no pier lie at
      // anchor there, in as few columns as hold them without reaching deeper
      // than the piers do — or, where they must, than all the free columns
      // would make them.
      const free = cols - row.length
      let taken = 0
      if (fleet.loose.length && row.length && free > 0 && r === rows.length - 1) {
        const width = k => cell * k - 10
        const reach = k => ANCHOR_OFF + anchorageHeight(fleet.loose.length, width(k))
        const deepest = Math.max(bottom - edge, reach(free))
        taken = 1
        while (reach(taken) > deepest) taken++
        const moored = anchor(fleet.loose, Math.round(PAD + cell * row.length + 10), edge + ANCHOR_OFF, Math.floor(width(taken)))
        ships.push(...moored.ships)
        anchorage = moored.anchorage
        bottom = Math.max(bottom, anchorage.y + anchorage.h)
      }

      // open water still left beside them: room for the compass rose
      const depth = bottom - edge
      if (!rose && row.length && row.length + taken < cols && depth >= 100) {
        rose = {
          x: Math.round(PAD + cell * (row.length + taken + 0.5)),
          y: Math.round(edge + depth / 2 + 6),
          r: Math.min(44, Math.floor((depth - 40) / 2)),
        }
      }
      y = bottom + (row.length ? BASIN_GAP : 14)
    })

    // no free column: the anchorage lies below the piers, the width of the harbor
    if (fleet.loose.length && !anchorage) {
      const moored = anchor(fleet.loose, PAD, y, usable)
      ships.push(...moored.ships)
      anchorage = moored.anchorage
      y = anchorage.y + anchorage.h + BASIN_GAP
    }

    const water = y - (fleet.piers.length || anchorage ? BASIN_GAP : 14)
    out.push({ key: fleet.key, label: fleet.label, detail: fleet.detail ?? '', folded: false, labelX, labelY, top, bottom: y, water, quays, jetties, anchorage, ships })
  })

  const height = Math.max(y - BASIN_GAP + PAD + 6, 120)
  if (out.length) out.at(-1).bottom = height
  return { width: W, height, light, rose, fleets: out }
}

// What moved between two layouts of the harbor (of the same width), for the
// map to glide it there instead of jumping: each fleet by how far its top
// moved, and inside a fleet each jetty, its anchorage and each ship by how
// far it moved against that top — so a ship that only goes along with its
// fleet does not move twice. The rose stands on its own. Only what moved,
// and only what is in both: a ship new to a fleet (or come from another)
// has nothing to glide from. In map units:
// → { fleets: { <key>: dy }, jetties: { <pierId>: { dx, dy } },
//     anchorages: { <fleet key>: { dx, dy } }, ships: { <id>: { dx, dy } }, rose: { dx, dy } | null }
export function layoutShifts(before, now) {
  const out = { fleets: {}, jetties: {}, anchorages: {}, ships: {}, rose: null }
  const delta = (a, b, da = 0, db = 0) => {
    const dx = b.x - a.x
    const dy = (b.y - db) - (a.y - da)
    return dx || dy ? { dx, dy } : null
  }
  const was = new Map(before.fleets.map(f => [f.key, f]))
  for (const f of now.fleets) {
    const old = was.get(f.key)
    if (!old) continue
    if (f.top !== old.top) out.fleets[f.key] = f.top - old.top
    const jetties = new Map(old.jetties.map(j => [j.pierId, j]))
    for (const j of f.jetties) {
      const d = jetties.has(j.pierId) && delta(jetties.get(j.pierId), j, old.top, f.top)
      if (d) out.jetties[j.pierId] = d
    }
    const d = old.anchorage && f.anchorage && delta(old.anchorage, f.anchorage, old.top, f.top)
    if (d) out.anchorages[f.key] = d
    const ships = new Map(old.ships.map(s => [s.id, s]))
    for (const s of f.ships) {
      const ds = ships.has(s.id) && delta(ships.get(s.id), s, old.top, f.top)
      if (ds) out.ships[s.id] = ds
    }
  }
  out.rose = (before.rose && now.rose && delta(before.rose, now.rose)) || null
  return out
}

// Whether layoutShifts found anything to move.
export function anyShift(shifts) {
  return !!shifts.rose || ['fleets', 'jetties', 'anchorages', 'ships'].some(k => Object.keys(shifts[k]).length)
}

// The ship to go to from `fromId` with an arrow key ('ArrowLeft', …), among
// `ships` (a layout's, every fleet's): the nearest whose middle lies that
// way, a step straight on counting for less than one aside — so ArrowDown
// walks down a jetty's side, and ArrowRight crosses to the other side of it.
// Home and End go to the first and the last. null where there is none.
export function nearestShip(ships, fromId, key) {
  if (!ships.length) return null
  if (key === 'Home') return ships[0]
  if (key === 'End') return ships.at(-1)
  const from = ships.find(s => s.id === fromId)
  if (!from) return ships[0]
  const axis = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key]
  if (!axis) return null
  const mid = s => [s.x + SHIP_L / 2, s.y + SHIP_B / 2]
  const [fx, fy] = mid(from)
  let best = null
  let bestScore = Infinity
  for (const s of ships) {
    if (s === from) continue
    const [x, y] = mid(s)
    const dx = x - fx
    const dy = y - fy
    const ahead = dx * axis[0] + dy * axis[1]
    const aside = Math.abs(dx * axis[1] + dy * axis[0])
    if (ahead < 4) continue
    const score = ahead + 3 * aside
    if (score < bestScore) { best = s; bestScore = score }
  }
  return best
}

// The free berth at the end of a jetty: { x, y, dir }. It shows that there
// is room and where the pier grows; which berth a ship moored there ends up
// in is the caller's order of the pier's projects (the harbor's is by name).
export function nextBerth(fleet, jetty) {
  const n = fleet.ships.filter(s => s.pierId === jetty.pierId).length
  const left = n % 2 === 0
  return {
    dir: left ? -1 : 1,
    x: left ? jetty.cx - JETTY_W / 2 - BERTH - SHIP_L : jetty.cx + JETTY_W / 2 + BERTH,
    y: jetty.y + FIRST + Math.floor(n / 2) * ROW,
  }
}

// What letting go of a ship at (x, y) would do — a ship only ever moors at
// its own fleet's piers (a pier is its owner's), so everything is asked of
// the fleet it lies in:
//   { kind: 'pier', pierId, name, slot }  over another of its piers: moor there; `slot` is its free berth (nextBerth)
//   { kind: 'anchor' }                    over its open water, from a pier: leave the pier
//   { kind: 'stay' }                      over where it already is: its own pier, or the water for one at anchor
//   { kind: 'foreign' }                   over another fleet
//   { kind: 'none' }                      on land, or off the map
// A pier is its jetty and what lies along it, the shed on the quay
// included, and a berth further down than its last.
const REACH = SHIP_L + BERTH + JETTY_W / 2
export function dropTarget(layout, shipId, x, y) {
  const home = layout.fleets.find(f => f.ships.some(s => s.id === shipId))
  const ship = home?.ships.find(s => s.id === shipId)
  if (!ship || !(x >= 0 && x <= layout.width)) return { kind: 'none' }
  const over = layout.fleets.find(f => y >= f.top && y < f.bottom)
  if (!over) return { kind: 'none' }
  if (over !== home) return { kind: 'foreign' }
  const jetty = home.jetties.find(j => Math.abs(x - j.cx) <= REACH && y >= j.y - QUAY_H && y <= j.y + j.h + ROW)
  if (jetty) {
    if (jetty.pierId === ship.pierId) return { kind: 'stay' }
    return { kind: 'pier', pierId: jetty.pierId, name: jetty.name, slot: nextBerth(home, jetty) }
  }
  if (home.quays.some(q => y >= q.y && y < q.y + q.h)) return { kind: 'none' }
  return ship.pierId == null ? { kind: 'stay' } : { kind: 'anchor' }
}

// The three kinds of ship, one per runtime, seen from above with the stern
// at x = 0 and the bow to the right, inside a berth of SHIP_L × SHIP_B: how
// long it is, its hull, the deck inside its rail, and where its lamp sits.
// What stands on the deck is drawn by components/HarborShip.vue.
export const SHIP_KINDS = {
  // a container ship: bridge aft, three stacks, a hatch on the foredeck
  container: {
    label: 'container',
    note: 'a stack per third of its memory in use',
    L: 120,
    lamp: 11.5,
    hull: 'M4.5 1.5 H84 C102 1.5 116 7.5 119.5 13 C116 18.5 102 24.5 84 24.5 H4.5 Q1 24.5 1 21 V5 Q1 1.5 4.5 1.5 Z',
    deck: 'M6 4.5 H83.5 C98 4.5 109 8.5 114 13 C109 17.5 98 21.5 83.5 21.5 H6 Q4 21.5 4 19.5 V6.5 Q4 4.5 6 4.5 Z',
  },
  // a sailing boat: slim, a narrow transom, its light at the masthead
  static: {
    label: 'static site',
    L: 100,
    lamp: 52,
    hull: 'M2 7 Q2 4 6 3.5 C38 0 75 3 99.5 13 C75 23 38 26 6 22.5 Q2 22 2 19 Z',
    deck: 'M5 8 Q5 6.5 8 6.2 C38 3.2 72 5.5 93 13 C72 20.5 38 22.8 8 19.8 Q5 19.5 5 18 Z',
  },
  // a tug: short and round, fendered all the way, its light on the wheelhouse
  pm2: {
    label: 'host process',
    L: 84,
    lamp: 38.5,
    hull: 'M6 1.5 H50 C66 1.5 79 7 83.5 13 C79 19 66 24.5 50 24.5 H6 Q1 24.5 1 20 V6 Q1 1.5 6 1.5 Z',
    deck: 'M7 4.5 H50 C63 4.5 73 8.5 78 13 C73 17.5 63 21.5 50 21.5 H7 Q4 21.5 4 19 V7 Q4 4.5 7 4.5 Z',
  },
}

// Anything that is neither a container nor a static site is a host process: a tug.
export const shipKind = runtime => (Object.hasOwn(SHIP_KINDS, runtime) ? runtime : 'pm2')

// How laden a container ship is, 0 to 3 stacks: one per third of its memory
// limit that it uses (of half a gigabyte where it has no limit), and none
// while it is not running.
const NO_LIMIT_MB = 512
export function cargoStacks(live) {
  const used = live?.pm2?.status === 'online' ? live.pm2.memory : null
  if (!(used > 0)) return 0
  const limit = (live.info?.memory_mb || NO_LIMIT_MB) * 1024 * 1024
  return Math.min(3, Math.floor((used / limit) * 3) + 1)
}

// Worn: a container the engine has had to restart after crashes, this many
// times since it was created (a deploy creates it anew). Only containers —
// pm2's counter also counts every deploy's reload, so it says nothing.
export const WORN_RESTARTS = 3
export function isWorn(live) {
  const runtime = live?.info?.deployed_runtime || live?.info?.runtime
  return runtime === 'container' && (live?.pm2?.restarts ?? 0) >= WORN_RESTARTS
}

// A name cut to what fits under a ship (or, shorter or longer, on a shed).
export function shipName(name, max = 19) {
  const s = String(name ?? '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
