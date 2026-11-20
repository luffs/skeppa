<template>
  <div ref="wrap" class="harbor-map" :class="{ asleep }">
    <div class="hm-stage">
      <!-- Each fleet folds to its quay (only where there is more than one).
           Buttons over the map rather than in it: before the ships in the
           tab order, so that Tab from a ship goes on to its card. -->
      <button
        v-for="f in foldable"
        :key="`fold-${f.key}`"
        type="button"
        class="hm-fold"
        :data-fold="f.key"
        :class="{ folded: f.folded }"
        :style="foldStyle(f)"
        :aria-expanded="f.folded ? 'false' : 'true'"
        :aria-label="`${f.folded ? 'Unfold' : 'Fold'} ${f.label}`"
        :title="foldTitle(f)"
        @click="toggleFleet(f.key)"
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5" /></svg>
      </button>
      <svg
        ref="svg"
        class="hm-svg"
        :class="{ dragging: drag }"
        :viewBox="`0 0 ${layout.width} ${layout.height}`"
        :width="layout.width"
        :height="layout.height"
        role="group"
        aria-label="The harbor as a map — each ship a project; the arrow keys go from ship to ship"
      >
        <defs>
          <linearGradient id="hm-depth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="hm-stop-shallow" /><stop offset="1" class="hm-stop-deep" />
          </linearGradient>
          <!-- the waves drift by a tile at a time: the pattern moves, not the water (the swell) -->
          <pattern id="hm-waves" width="56" height="28" patternUnits="userSpaceOnUse">
            <path class="hm-wave" d="M3 8 q5 -4 10 0 t10 0" /><path class="hm-wave" d="M31 22 q5 -4 10 0 t10 0" />
          </pattern>
          <pattern id="hm-stone" width="18" height="12" patternUnits="userSpaceOnUse">
            <path class="hm-stone-line" d="M0 0.5 H18 M0 6.5 H18 M5 0.5 V6.5 M14 6.5 V12" />
          </pattern>
          <radialGradient id="hm-glow">
            <stop offset="0" class="hm-stop-glow" stop-opacity="0.85" /><stop offset="1" class="hm-stop-glow" stop-opacity="0" />
          </radialGradient>
        </defs>

        <!-- the water: deeper further out, small waves drifting across -->
        <rect x="0" y="0" :width="layout.width" :height="layout.height" fill="url(#hm-depth)" />
        <rect class="hm-waves" x="0" y="0" :width="layout.width" :height="layout.height" fill="url(#hm-waves)" />

        <g v-if="layout.rose" class="hm-rose" :transform="`translate(${layout.rose.x} ${layout.rose.y})`">
          <circle :r="layout.rose.r" /><circle :r="layout.rose.r * 0.74" />
          <circle class="hm-rose-ticks" :r="layout.rose.r * 0.87" :stroke-width="layout.rose.r * 0.1" :stroke-dasharray="roseTicks" />
          <path class="hm-rose-minor" :d="rose.minor" /><path class="hm-rose-major" :d="rose.major" /><path class="hm-rose-shade" :d="rose.shade" />
          <text class="hm-rose-n" :y="-layout.rose.r - 5" text-anchor="middle">N</text>
        </g>

        <g v-for="f in layout.fleets" :key="f.key" class="hm-fleet" :data-fleet="f.key">
          <!-- the quay: the shore along the top, a mole further out -->
          <g v-for="(q, i) in f.quays" :key="`q${i}`" class="hm-quay-g">
            <rect class="hm-cast" :x="q.x + (q.shore ? 0 : 2)" :y="q.y + 4" :width="q.w" :height="q.h" :rx="q.shore ? 0 : 9" />
            <rect class="hm-quay" :x="q.x" :y="q.y" :width="q.w" :height="q.h" :rx="q.shore ? 0 : 9" />
            <rect :x="q.x" :y="q.y" :width="q.w" :height="q.h" :rx="q.shore ? 0 : 9" fill="url(#hm-stone)" />
            <line class="hm-quay-edge" :x1="q.x + (q.shore ? 0 : 8)" :x2="q.x + q.w - (q.shore ? 0 : 8)" :y1="q.y + q.h - 1.5" :y2="q.y + q.h - 1.5" />
            <line class="hm-bollards" :x1="q.x + 22" :x2="q.x + q.w - 22" :y1="q.y + q.h - 7" :y2="q.y + q.h - 7" />
          </g>
          <text class="hm-fleet-label" :x="f.labelX + (foldable.length ? 16 : 0)" :y="f.labelY">{{ f.label }}<tspan v-if="f.detail" class="hm-fleet-detail" dx="10">{{ f.detail }}</tspan><template v-if="f.folded"><tspan class="hm-fleet-summary" dx="12">{{ summaryOf(f).ships }}</tspan><tspan v-if="summaryOf(f).attention" class="hm-fleet-summary attention"> · {{ summaryOf(f).attention }}</tspan><tspan v-if="summaryOf(f).underway" class="hm-fleet-summary underway"> · {{ summaryOf(f).underway }}</tspan></template></text>

          <!-- while a ship is dragged, the piers it may moor at say so -->
          <g
            v-for="j in f.jetties"
            :key="`j${j.pierId}`"
            class="hm-jetty-g"
            :data-pier="j.pierId"
            :class="{ 'can-drop': canMoor(f, j), 'drop-on': canMoor(f, j) && drag.target.pierId === j.pierId }"
          >
            <rect class="hm-drop-halo" :x="j.x - 5" :y="j.y - 36" :width="j.w + 10" :height="j.h + 41" rx="7" />
            <rect class="hm-cast" :x="j.x + 3" :y="j.y" :width="j.w" :height="j.h + 3" rx="3" />
            <rect class="hm-jetty" :x="j.x" :y="j.y - 3" :width="j.w" :height="j.h + 3" rx="3" />
            <!-- planks across the jetty -->
            <line class="hm-planks" :x1="j.cx" :x2="j.cx" :y1="j.y + 1" :y2="j.y + j.h - 3" />
            <!-- a bollard at every berth, either side -->
            <template v-if="!j.empty">
              <line class="hm-piles" :x1="j.x" :x2="j.x" :y1="j.firstY" :y2="j.firstY + (j.berths - 1) * ROW + 0.01" />
              <line class="hm-piles" :x1="j.x + j.w" :x2="j.x + j.w" :y1="j.firstY" :y2="j.firstY + (j.berths - 1) * ROW + 0.01" />
            </template>
            <!-- the lantern at the jetty's head -->
            <circle class="hm-lantern-glow" :cx="j.cx" :cy="j.y + j.h - 7" r="22" fill="url(#hm-glow)" />
            <circle class="hm-lantern" :cx="j.cx" :cy="j.y + j.h - 7" r="2.6" />
            <!-- the pier's shed on the quay, its name on the roof -->
            <rect class="hm-shed" :x="j.cx - signWidth(j) / 2" :y="j.y - 31" :width="signWidth(j)" height="21" rx="3" />
            <text class="hm-pier-name" :x="j.cx" :y="j.y - 16.5" text-anchor="middle">{{ pierLabel(j) }}</text>
            <text v-if="j.empty" class="hm-empty" :x="j.cx" :y="j.y + j.h + 16" text-anchor="middle">nothing moored here yet</text>
          </g>

          <g v-if="f.anchorage" class="hm-anchorage" :class="{ 'can-drop': canAnchor(f), 'drop-on': canAnchor(f) && drag.target.kind === 'anchor' }">
            <rect class="hm-anchor-area" :x="f.anchorage.x" :y="f.anchorage.y" :width="f.anchorage.w" :height="f.anchorage.h" rx="14" />
            <!-- lateral marks at its corners: red to port, green to starboard -->
            <circle class="hm-mark port" :cx="f.anchorage.x" :cy="f.anchorage.y + 14" r="3.4" />
            <circle class="hm-mark port" :cx="f.anchorage.x" :cy="f.anchorage.y + f.anchorage.h - 14" r="3.4" />
            <circle class="hm-mark starboard" :cx="f.anchorage.x + f.anchorage.w" :cy="f.anchorage.y + 14" r="3.4" />
            <circle class="hm-mark starboard" :cx="f.anchorage.x + f.anchorage.w" :cy="f.anchorage.y + f.anchorage.h - 14" r="3.4" />
            <g class="hm-anchor-icon" :transform="`translate(${f.anchorage.x + 20} ${f.anchorage.labelY - 4})`">
              <circle cy="-5.5" r="1.6" /><path d="M0 -4 V5 M-3 -1.5 H3 M-5 1 Q-5 5 0 5 Q5 5 5 1" />
            </g>
            <text class="hm-anchor-label" :x="f.anchorage.x + 31" :y="f.anchorage.labelY">At anchor</text>
          </g>

          <a
            v-for="(s, i) in f.ships"
            :key="s.id"
            :href="`/projects/${s.id}`"
            :tabindex="s.id === tabStop ? 0 : -1"
            :data-ship="s.id"
            class="hm-ship"
            :class="shipClasses(s)"
            :style="{ '--i': i % 7, '--dir': s.dir, transform: shipTransform(s) }"
            :aria-label="`${s.project.name}, ${statusOf(s)}`"
            :aria-description="gaugeWords(s) || null"
            @click.prevent="onShipClick(s)"
            @keydown="onShipKey($event, s)"
            @pointerdown="onPress($event, s, f)"
            @dragstart.prevent
            @contextmenu="onContextMenu"
            @mouseenter="showCard(s)"
            @mouseleave="hideSoon"
            @focus="onShipFocus(s)"
            @blur="hideSoon"
          >
            <!-- at anchor the whole ship swings about its buoy (the swell, below) -->
            <g class="hm-sway" :data-phase="i % 7">
              <rect class="hm-hit" x="0" y="-2" :width="SHIP_L" :height="SHIP_B + NAME_H + 2" />
              <g v-if="s.side === 'anchor'" class="hm-chain">
                <path :d="`M${shape(s).L - 1} ${SHIP_B / 2} H${ANCHOR_X}`" />
                <circle class="hm-buoy" :cx="ANCHOR_X" :cy="SHIP_B / 2" r="3.6" />
              </g>
              <!-- under way a ship has cast off: it glides out from its jetty, and back in
                   (CSS, once each way); out there it makes headway as its voyage goes
                   on — an attribute, a fraction of a unit a second, never composited -->
              <g class="hm-berth" :style="{ transform: `translateX(${castOff(s)}px)` }">
                <g :transform="headway(s)">
                  <!-- afloat: every ship rides the swell a little, each to its own beat;
                       a voyage taking much longer than usual rides it uneasily (the swell, below) -->
                  <g class="hm-bob" :data-phase="i % 7" :data-cx="midship(s)" :data-uneasy="uneasy(s) ? 1 : 0">
                    <!-- drawn bow to the right; a ship on the jetty's left is mirrored -->
                    <g :transform="s.dir < 0 ? `translate(${SHIP_L} 0) scale(-1 1)` : null">
                      <!-- a wake behind the stern under way; otherwise made fast -->
                      <g v-if="stateOf(s) === 'underway'" class="hm-wake">
                        <path d="M-2 6 L-16 1" /><path d="M-3 13 H-18" /><path d="M-2 20 L-16 25" />
                      </g>
                      <path v-else-if="s.side !== 'anchor'" class="hm-lines" :d="`M2 6 L${-BERTH} ${SHIP_B / 2} L2 ${SHIP_B - 6}`" />
                      <HarborShip :runtime="runtimeOf(s)" :stacks="stacksOf(s)" :worn="wornOf(s)" />
                      <!-- new commits waiting: a pennant flying -->
                      <g v-if="stateOf(s) === 'ahead'" class="hm-pennant" :transform="`translate(${Math.round(shape(s).L * 0.7)} 2)`">
                        <path class="hm-staff" d="M0 0 V-8" />
                        <!-- run up (CSS, once), then flying: skewed about the staff at x = 0 (the swell) -->
                        <g class="hm-hoist">
                          <path class="hm-flag" d="M0 -8 L-11 -5.5 L0 -3 Z" />
                        </g>
                      </g>
                    </g>
                    <!-- under way, a ring about its lamp fills as the voyage goes on, against
                         how long the last good ones took; overdue, it is full and it says so -->
                    <g
                      v-if="voyageOf(s)"
                      class="hm-voyage"
                      :class="{ overdue: voyageOf(s).overdue, blind: voyageOf(s).expected == null }"
                      :transform="`translate(${lampX(s)} ${SHIP_B / 2})`"
                    >
                      <circle class="hm-voyage-track" r="6.5" />
                      <circle class="hm-voyage-done" r="6.5" pathLength="100" :stroke-dasharray="`${Math.round(voyageOf(s).p * 100)} 100`" transform="rotate(-90)" />
                    </g>
                  </g>
                  <text class="hm-name" :x="s.dir < 0 ? SHIP_L - 1 : 1" :y="SHIP_B + 11" :text-anchor="s.dir < 0 ? 'end' : 'start'">{{ shortName(s) }}</text>
                  <!-- what just happened to it, for a moment: rings on the water as it
                       makes port or new commits come in, a red flare when a voyage fails -->
                  <g
                    v-if="events[s.id]"
                    :key="events[s.id].n"
                    class="hm-event"
                    :class="events[s.id].kind"
                    :transform="`translate(${midship(s)} ${SHIP_B / 2})`"
                  >
                    <circle class="hm-ripple" r="18" /><circle class="hm-ripple late" r="18" />
                    <g v-if="events[s.id].kind === 'flare'" class="hm-flare">
                      <path class="hm-flare-trail" d="M0 -4 V-30" />
                      <path class="hm-flare-star" d="M0 -47 V-29 M-9 -38 H9 M-6.4 -44.4 L6.4 -31.6 M-6.4 -31.6 L6.4 -44.4" />
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </a>

          <!-- a fleet with nothing at anchor has no anchorage to point at: while
               one of its moored ships is dragged, its open water says what it is -->
          <g
            v-if="canAnchor(f) && !f.anchorage"
            class="hm-anchor-here"
            :class="{ 'drop-on': drag.target.kind === 'anchor' }"
            :transform="`translate(${layout.width / 2} ${f.water + 12})`"
          >
            <rect x="-84" y="-10" width="168" height="20" rx="10" /><text y="3.5" text-anchor="middle">Open water — at anchor</text>
          </g>
        </g>

        <!-- a ship gone from the harbor (its project scuttled) sinks where it lay -->
        <g
          v-for="w in wreckList"
          :key="`wreck-${w.id}-${w.n}`"
          class="hm-ship hm-wreck"
          :class="`side-${w.side}`"
          :style="{ transform: shipTransform(w) }"
          aria-hidden="true"
        >
          <g class="hm-event sunk" :transform="`translate(${midship(w)} ${SHIP_B / 2})`">
            <circle class="hm-ripple" r="18" /><circle class="hm-ripple late" r="18" />
          </g>
          <g class="hm-sink">
            <g :transform="w.dir < 0 ? `translate(${SHIP_L} 0) scale(-1 1)` : null">
              <HarborShip :runtime="runtimeOf(w)" :stacks="0" />
            </g>
          </g>
        </g>

        <!-- the lighthouse at the end of the shore (its beam sweeps the harbor
             from a layer of its own, over the map); a click puts it out, and
             lights it again -->
        <g
          v-if="layout.light"
          class="hm-light"
          :class="{ dark: !lit }"
          :transform="`translate(${layout.light.x} ${layout.light.y})`"
          role="button"
          tabindex="0"
          :aria-pressed="lit ? 'true' : 'false'"
          aria-label="Lighthouse"
          @click="toggleLight"
          @keydown="onLightKey"
        >
          <circle class="hm-cast" cx="2" cy="4" r="15" />
          <circle class="hm-quay" r="15" /><circle r="15" fill="url(#hm-stone)" />
          <circle class="hm-tower" r="8" /><circle class="hm-tower-band" r="5.2" /><circle class="hm-tower-lamp" r="2.6" />
        </g>

        <!-- A ship being dragged: the free berth at the pier under it, and the
             ship itself under the pointer, saying what letting go does. -->
        <template v-if="drag">
          <g v-if="drag.target.kind === 'pier'" class="hm-slot" :transform="`translate(${drag.target.slot.x} ${drag.target.slot.y})`">
            <path :d="shape(drag.ship).hull" :transform="drag.target.slot.dir < 0 ? `translate(${SHIP_L} 0) scale(-1 1)` : null" />
          </g>
          <g class="hm-ship hm-ghost" :class="[`state-${stateOf(drag.ship)}`, { refused: drag.target.kind === 'foreign' || drag.target.kind === 'none' }]" :transform="`translate(${drag.x - drag.gx} ${drag.y - drag.gy})`">
            <!-- lifted off the water: its shadow drawn below it, as the map
                 draws shadows (a filter would be recomputed on every move) -->
            <g transform="translate(0 8)">
              <path class="hm-lift" :d="shape(drag.ship).hull" :transform="drag.ship.dir < 0 ? `translate(${SHIP_L} 0) scale(-1 1)` : null" />
            </g>
            <g :transform="drag.ship.dir < 0 ? `translate(${SHIP_L} 0) scale(-1 1)` : null">
              <HarborShip :runtime="runtimeOf(drag.ship)" :stacks="stacksOf(drag.ship)" :worn="wornOf(drag.ship)" />
            </g>
            <text class="hm-name" :x="drag.ship.dir < 0 ? SHIP_L - 1 : 1" :y="SHIP_B + 11" :text-anchor="drag.ship.dir < 0 ? 'end' : 'start'">{{ shortName(drag.ship) }}</text>
            <text v-if="dragHint" class="hm-drop-hint" :x="SHIP_L / 2" :y="SHIP_B + 27" text-anchor="middle">{{ dragHint }}</text>
          </g>
        </template>
      </svg>

      <!-- The lighthouse's beam: HTML over the map, not SVG in it, so that its
           endless turn is the compositor's — smooth at the screen's rate and
           nothing for the main thread. Turned inside the SVG it would have
           Chrome record the whole harbor again every frame (or, done by the
           swell, judder). Clipped to the map's corners. -->
      <div v-if="layout.light && lit" class="hm-beam-clip" aria-hidden="true">
        <div class="hm-beam" :style="beamStyle"></div>
      </div>

      <!-- The row the list would show, over the ship pointed at or focused:
           its status, what happened, its one button and its ⋮ menu. -->
      <div
        v-if="card"
        class="harbor-card"
        :style="cardStyle"
        @mouseenter="keepCard"
        @mouseleave="hideSoon"
        @focusin="keepCard"
        @focusout="hideSoon"
        @keydown="onCardKey"
      >
        <div class="vessel-rows"><ProjectRow :project="card.project" /></div>
        <!-- the ship's instruments: what its drawing stands for, that the row does not say -->
        <div v-if="cardGauges.length" class="hm-gauges" aria-hidden="true">
          <div v-for="g in cardGauges" :key="g.key" class="hm-gauge" :class="[`g-${g.key}`, g.tone && `tone-${g.tone}`]">
            <span class="hm-gauge-label">{{ g.label }}</span>
            <span class="hm-gauge-value">{{ g.value }}</span>
            <span v-if="g.fill != null" class="hm-gauge-bar"><span :style="{ width: `${Math.round(g.fill * 100)}%` }"></span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- What the map's colours and ships mean. The colours are the state
         filter too: a click shows just those vessels, a second one all again. -->
    <div class="hm-legend">
      <div class="hm-keys" role="group" aria-label="Show only the vessels that">
        <button
          v-for="k in stateKeys"
          :key="k.key"
          type="button"
          class="hm-key"
          :class="[`state-${k.swatch}`, { active: k.active }]"
          :aria-pressed="k.active ? 'true' : 'false'"
          :disabled="!k.count && !k.active"
          :title="k.active ? 'Show every vessel again' : `Show only the vessels that ${k.that}`"
          @click="$emit('toggle-state', k.key)"
        ><span class="hm-key-hull"></span>{{ k.label }}<span class="hm-key-count">{{ k.count }}</span></button>
      </div>
      <!-- the kind of ship tells the runtime: only the kinds in this harbor -->
      <div class="hm-kinds">
        <span v-for="k in kinds" :key="k.runtime" class="hm-kind">
          <svg :viewBox="`-1 -1 ${k.L + 5} ${SHIP_B + 6}`" :width="(k.L + 5) / 2" :height="(SHIP_B + 6) / 2" aria-hidden="true"><HarborShip :runtime="k.runtime" /></svg>
          {{ k.label }}<span v-if="k.note" class="hm-kind-note">{{ k.note }}</span>
        </span>
      </div>
      <!-- only where there is somewhere to drag to -->
      <p v-if="hasPiers" class="hm-drag-tip">Drag a ship to another of its fleet's piers to moor it there, or out into open water to leave it at anchor.</p>
    </div>
  </div>
</template>

<script>
import ProjectRow from './ProjectRow.vue'
import HarborShip from './HarborShip.vue'
import { store, liveProject } from '../store.js'
import { vesselState, statusWord, voyage, usualVoyage } from '../lib/vessels.js'
import { STATE_FILTERS, LEGEND_FILTERS } from '../lib/harborFilter.js'
import { bytes } from '../lib/format.js'
import { performAction } from '../lib/vesselActions.js'
import { layoutHarbor, layoutShifts, anyShift, dropTarget, nearestShip, shipName, shipKind, cargoStacks, isWorn, SHIP_KINDS, SHIP_L, SHIP_B, NAME_H, BERTH, ROW, CHAIN } from '../lib/harborMap.js'

const CARD_W = 440
const CAST_OFF = 7 // how far a ship under way has left its berth
// and how much further it makes, out there, by the end of its voyage: with
// CAST_OFF, half the open water between two columns' bows (COL_GAP), so
// neighbours both under way still pass clear
const HEADWAY = 7
const ANCHOR_X = SHIP_L + CHAIN // an anchored ship's buoy, ahead of its berth
const BEAM = 340 // how far the lighthouse reaches
const EVENT_MS = 3400 // how long what just happened to a ship stays on the water
const DRAG_START = 6 // how far a pressed ship is moved before that is a drag and not a click
const HOLD_MS = 320 // how long a finger rests on a ship before it is picked up — sooner, it is a scroll
// How often the swell moves the harbor (the ships' bob and swing, the
// pennants, the wakes, the lamps, the waves): 15 times a second, which the
// eye cannot tell from more at a pixel's motion.
const SWELL_MS = 1000 / 15
const HOLD_SLACK = 10 // how far that finger may wander meanwhile
const FLIP_MS = 700 // how long what a change of the harbor's shape moved takes to glide there
const FLIP_EASE = 'cubic-bezier(0.3, 0, 0.2, 1)'
const ARRIVE_MS = 1800 // how long a new ship takes to back in to its berth
const WRECK_MS = 2600 // how long a ship gone from the harbor takes to sink
const FOLD_H = 26 // the strip of a quay its fleet's name is on, and its fold button
const FOLDED_KEY = 'skeppa.foldedFleets'
const ATTENTION = new Set(STATE_FILTERS.attention.states)

// A span of time to the second, the way the ship's log has it: "54s", "1m 30s".
function roughly(ms) {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`
}

// How full a gauge may get before it is a worry, and before it is trouble.
const toneOf = (fill, warn = 2 / 3, bad = 0.9) => (fill >= bad ? 'bad' : fill >= warn ? 'warn' : '')

// The fleets folded to their quays, by key, kept in the browser.
function loadFolded() {
  try {
    const keys = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return Object.fromEntries((Array.isArray(keys) ? keys : []).map(k => [String(k), true]))
  } catch {
    return {}
  }
}
function saveFolded(folded) {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify(Object.keys(folded)))
  } catch { /* storage refused: folded for this visit only */ }
}

// Whether the lighthouse is lit (a click on it puts it out, and lights it
// again), kept in the browser; lit unless put out.
const LIGHT_KEY = 'skeppa.lighthouseOff'
function loadLit() {
  try {
    return localStorage.getItem(LIGHT_KEY) !== '1'
  } catch {
    return true
  }
}
function saveLit(lit) {
  try {
    if (lit) localStorage.removeItem(LIGHT_KEY)
    else localStorage.setItem(LIGHT_KEY, '1')
  } catch { /* storage refused: for this visit only */ }
}

// A four-pointed star about the origin, turned `turn` degrees: its outline,
// and the half of every point that a compass rose fills in.
function star(tip, waist, turn) {
  const at = (deg, r) => {
    const a = ((deg + turn - 90) * Math.PI) / 180
    return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`
  }
  let outline = ''
  let shade = ''
  for (let k = 0; k < 4; k++) {
    outline += `${k ? 'L' : 'M'}${at(k * 90, tip)} L${at(k * 90 + 45, waist)} `
    shade += `M0 0 L${at(k * 90, tip)} L${at(k * 90 + 45, waist)} Z `
  }
  return { outline: `${outline}Z`, shade }
}

// The harbor as a map (lib/harborMap.js lays it out): the quay along the
// top, a jetty per pier reaching down from it, the projects moored on both
// sides as ships — the kind of ship telling the runtime, its colour and lamp
// the state — and the projects at no pier at anchor. A ship is a link to its
// project; a pointer or focus on it brings up the row the list would show.
// Search and the state filter dim what does not match rather than take it
// away, so the harbor keeps its shape. What changes while the map is open
// shows as it happens: a ship glides out as its deploy starts and back in
// when it ends — rings on the water if it made port, a red flare if not —
// and a pennant goes up on one with new commits. A ship can be dragged to
// another pier of its own fleet, or out into its open water to leave it at
// anchor — the move the ⋮ menu offers too, which is what the keyboard has
// (a pier is its owner's, so another fleet's refuses it). The ships are one
// stop in the tab order: the arrow keys go from ship to ship, Tab on into
// the card of the one focused and Escape back out of it. A finger has no
// hover: its first tap on a ship brings up the card, a second opens the
// project. Where there is more than one fleet, each folds to its quay,
// saying how many ships it holds and how many need attention; a search
// opens the folded ones with a ship it finds. Nothing moves while the map
// is out of sight. Under it a legend: what the colours
// mean — each one a state filter, asked for with `toggle-state` — and what
// the kinds of ship mean.
export default {
  name: 'HarborMap',
  components: { ProjectRow, HarborShip },
  props: {
    // The whole harbor, unfiltered: [{ key, label, detail, piers, loose }].
    fleets: { type: Array, required: true },
    // Ids the search and filter let through; null when nothing filters.
    matches: { type: Object, default: null },
    // The state filter in force ('' for none), and how many vessels each
    // filter would show (lib/harborFilter.js stateCounts).
    stateFilter: { type: String, default: '' },
    counts: { type: Object, default: () => ({}) },
  },
  emits: ['toggle-state'],
  data() {
    return {
      SHIP_L, SHIP_B, NAME_H, BERTH, ROW, ANCHOR_X, BEAM,
      width: 900,
      card: null,
      hideTimer: null,
      // What just happened to a ship: { <id>: { kind: 'arrived' | 'flare' | 'hail', n } }.
      events: {},
      // The ship being dragged: { ship, fleet (its fleet's key), x, y (the
      // pointer, in map units), gx, gy (where on its berth it was taken
      // hold of), target (lib/harborMap.js dropTarget) }.
      drag: null,
      // The id of a ship whose move is being saved.
      moving: null,
      // Ships on their way, for a moment (the layout watcher): backing in
      // new { <id>: { n } }, and gone, sinking where they lay
      // { <id>: { ...the ship as it was laid out, n } }.
      arrivals: {},
      wrecks: {},
      // the ship the tab order stops at (roving tabindex), and the one a
      // finger has tapped once — its card is up, a second tap opens it
      focusId: null,
      tapped: null,
      // fleets folded to their quays: { <key>: true }
      folded: loadFolded(),
      // the lighthouse lit, its beam sweeping (a click on it toggles)
      lit: loadLit(),
      // the animations pause while the map is scrolled away or the tab hidden
      inView: true,
      pageHidden: false,
      // prefers-reduced-motion: the ships lie still (the swell is script: it does not hear the CSS media query)
      still: false,
    }
  },
  computed: {
    layout() {
      return layoutHarbor(this.fleets.map(f => (this.isFolded(f) ? { ...f, folded: true } : f)), this.width)
    },
    ships() {
      return this.layout.fleets.flatMap(f => f.ships)
    },
    // The one ship in the tab order: the last one focused while it is still
    // on the map, the first one otherwise.
    tabStop() {
      return this.ships.some(s => s.id === this.focusId) ? this.focusId : (this.ships[0]?.id ?? null)
    },
    foldable() {
      return this.layout.fleets.length > 1 ? this.layout.fleets : []
    },
    asleep() {
      return !this.inView || this.pageHidden
    },
    // The rose's stars: a large one to the cardinal points, a small one between.
    rose() {
      const r = this.layout.rose?.r ?? 0
      const major = star(r * 0.98, r * 0.15, 0)
      return { major: major.outline, shade: major.shade, minor: star(r * 0.56, r * 0.12, 45).outline }
    },
    // 72 marks around the rose, one every five degrees.
    roseTicks() {
      const step = (2 * Math.PI * (this.layout.rose?.r ?? 0) * 0.87) / 72
      return `0.9 ${(step - 0.9).toFixed(3)}`
    },
    cardGauges() {
      return this.card ? this.gaugesOf(this.card) : []
    },
    wreckList() {
      return Object.values(this.wrecks)
    },
    // Where the beam's layer lies over the map, in fractions of it — so it
    // follows the map when it is drawn smaller than 1:1 — centred on the
    // lighthouse, BEAM every way.
    beamStyle() {
      const { width, height, light } = this.layout
      const pct = (n, of) => `${(n / of) * 100}%`
      return { left: pct(light.x - BEAM, width), top: pct(light.y - BEAM, height), width: pct(2 * BEAM, width), height: pct(2 * BEAM, height) }
    },
    // What the events are read from: every ship's state, and how its last
    // voyage ended.
    signals() {
      const out = {}
      for (const f of this.layout.fleets) {
        for (const s of f.ships) out[s.id] = { state: this.stateOf(s), outcome: this.live(s)?.lastDeployment?.status ?? '' }
      }
      return out
    },
    // The legend's colours, each a state filter with its count.
    stateKeys() {
      return LEGEND_FILTERS.map(key => ({ key, ...STATE_FILTERS[key], count: this.counts[key] ?? 0, active: this.stateFilter === key }))
    },
    // The kinds of ship in this harbor, for the legend.
    kinds() {
      const here = new Set(this.layout.fleets.flatMap(f => f.ships.map(s => shipKind(this.runtimeOf(s)))))
      return Object.keys(SHIP_KINDS).filter(k => here.has(k)).map(k => ({ runtime: k, label: SHIP_KINDS[k].label, note: SHIP_KINDS[k].note ?? '', L: SHIP_KINDS[k].L }))
    },
    hasPiers() {
      return this.layout.fleets.some(f => f.jetties.length)
    },
    // What letting go of the dragged ship would do, in words.
    dragHint() {
      const t = this.drag?.target
      if (!t) return ''
      if (t.kind === 'pier') return `Moor at ${shipName(t.name, 26)}`
      if (t.kind === 'anchor') return 'Leave at anchor'
      if (t.kind === 'foreign') return 'Not its fleet — only its own piers'
      return ''
    },
    cardStyle() {
      const s = this.card
      if (!s) return {}
      const w = Math.min(CARD_W, this.layout.width - 16)
      const left = Math.max(8, Math.min(s.x - 10, this.layout.width - w - 8))
      // under the ship and its name, unless that runs off the bottom of the map
      const below = s.y + SHIP_B + NAME_H + 6
      return below + 90 > this.layout.height
        ? { left: `${left}px`, width: `${w}px`, bottom: `${this.layout.height - s.y + 10}px` }
        : { left: `${left}px`, width: `${w}px`, top: `${below}px` }
    },
  },
  watch: {
    // The swell stops out of sight, and for good with reduced motion.
    asleep() {
      this.tendSwell()
    },
    still() {
      this.tendSwell()
    },
    // a card that went away, or moved to another ship, takes the first tap with it
    card(now) {
      if (now?.id !== this.tapped) this.tapped = null
    },
    // A change of state since the last look is an event. The first look
    // (created) is only the baseline: a harbor opened on a failed project
    // fires no flare.
    signals: {
      handler(now) {
        for (const [id, sig] of Object.entries(now)) {
          const before = this.seen[id]
          this.seen[id] = sig
          if (!before || before.state === sig.state) continue
          if (before.state === 'underway') this.signal(id, sig.outcome === 'failed' ? 'flare' : sig.outcome === 'success' ? 'arrived' : '')
          else if (sig.state === 'ahead') this.signal(id, 'hail')
        }
        for (const id of Object.keys(this.seen)) if (!(id in now)) delete this.seen[id]
      },
    },
    // Ships come and go, and the harbor changes shape. A project new to the
    // harbor (or new to this fleet) backs in to its berth from open water;
    // one gone from every fleet sinks where it lay. Everything else the new
    // shape moves glides there rather than jumps — a fleet under a jetty that
    // grew, an anchorage under it, a ship to another berth, a jetty when a
    // pier is added beside it (flip). Not when the window was resized: then
    // everything is laid out anew at once. Folding and the filters say nothing
    // about coming and going: `whereabouts` counts every project in every
    // fleet, folded or not.
    layout(now, before) {
      const known = this.known
      this.known = this.whereabouts()
      if (!before || this.still) return
      for (const f of now.fleets) {
        for (const s of f.ships) if (known[s.id] !== f.key) this.mark('arrivals', s.id, ARRIVE_MS)
      }
      for (const f of before.fleets) {
        for (const s of f.ships) if (!(s.id in this.known)) this.mark('wrecks', s.id, WRECK_MS, s)
      }
      for (const id of Object.keys(this.wrecks)) if (id in this.known) delete this.wrecks[id]
      if (now.width !== before.width || this.drag) return
      const shifts = layoutShifts(before, now)
      if (anyShift(shifts)) this.$nextTick(() => this.flip(shifts))
    },
  },
  created() {
    // not reactive: bookkeeping for the watcher above, which starts from how things are now
    this.seen = { ...this.signals }
    this.eventTimers = new Set()
    this.eventCount = 0
    // a press on a ship that may become a drag, and the click to ignore after one
    this.press = null
    this.swallowClick = false
    // which fleet every project is in, for the layout watcher: the first look is the baseline
    this.known = this.whereabouts()
    this.flipTimers = new Set()
    this.swellTimer = null
  },
  mounted() {
    this.measure()
    // not passive: a finger dragging a ship must not scroll the page under it
    this.$refs.svg.addEventListener('touchmove', this.onTouchMove, { passive: false })
    document.addEventListener('pointerdown', this.onPointerAnywhere, true)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.onVisibility()
    this.calm = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : null
    if (this.calm) {
      this.onCalm()
      this.calm.addEventListener?.('change', this.onCalm)
    }
    this.tendSwell()
    if (typeof IntersectionObserver !== 'undefined') {
      this.sight = new IntersectionObserver(entries => { this.inView = entries.at(-1).isIntersecting })
      this.sight.observe(this.$refs.wrap)
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.measure())
      this.observer.observe(this.$refs.wrap)
    }
  },
  unmounted() {
    this.observer?.disconnect()
    this.sight?.disconnect()
    document.removeEventListener('pointerdown', this.onPointerAnywhere, true)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.calm?.removeEventListener?.('change', this.onCalm)
    clearTimeout(this.hideTimer)
    clearInterval(this.swellTimer)
    for (const t of this.flipTimers) clearTimeout(t)
    for (const t of this.eventTimers) clearTimeout(t)
    this.endPress()
    this.$refs.svg?.removeEventListener('touchmove', this.onTouchMove)
  },
  methods: {
    // Shows `kind` at a ship for a moment; a newer event there replaces it.
    signal(id, kind) {
      if (kind) this.mark('events', id, EVENT_MS, { kind })
    },
    // Puts `value` at `id` in this[map] (events, arrivals, wrecks) for `ms`,
    // stamped `n`; a newer one at the same id replaces it, and outlives it.
    mark(map, id, ms, value = {}) {
      const n = ++this.eventCount
      this[map][id] = { ...value, n }
      const timer = setTimeout(() => {
        this.eventTimers.delete(timer)
        if (this[map][id]?.n === n) delete this[map][id]
      }, ms)
      this.eventTimers.add(timer)
    },
    // The other half of a FLIP: the DOM already shows the harbor's new
    // shape; each thing that moved (layoutShifts, in map units) is put back
    // where it was with the CSS `translate` property — which goes outside
    // the `transform` that places a ship, so the two never fight — and then
    // let go to glide home. A fleet's ships and jetties move against their
    // fleet, which moves on its own; a fold button, over the map in CSS
    // pixels, goes with its fleet. Wherever something was mid-glide, it
    // starts from there.
    flip(shifts) {
      const svg = this.$refs.svg
      if (!svg) return
      const scale = (svg.getBoundingClientRect().width || this.layout.width) / this.layout.width
      const moves = []
      const put = (el, dx, dy, k = 1) => { if (el) moves.push({ el, dx: dx * k, dy: dy * k }) }
      const fleet = key => svg.querySelector(`[data-fleet="${key}"]`)
      for (const [key, dy] of Object.entries(shifts.fleets)) {
        put(fleet(key), 0, dy)
        put(this.$el.querySelector(`[data-fold="${key}"]`), 0, dy, scale)
      }
      for (const [id, d] of Object.entries(shifts.jetties)) put(svg.querySelector(`[data-pier="${id}"]`), d.dx, d.dy)
      for (const [key, d] of Object.entries(shifts.anchorages)) put(fleet(key)?.querySelector('.hm-anchorage'), d.dx, d.dy)
      for (const [id, d] of Object.entries(shifts.ships)) put(svg.querySelector(`[data-ship="${id}"]`), d.dx, d.dy)
      if (shifts.rose) put(svg.querySelector('.hm-rose'), shifts.rose.dx, shifts.rose.dy)
      if (!moves.length) return
      for (const m of moves) {
        const [x = 0, y = 0] = (String(getComputedStyle(m.el).translate ?? '').match(/-?[\d.]+/g) ?? []).map(Number)
        m.el.style.transition = 'none'
        m.el.style.translate = `${x - m.dx}px ${y - m.dy}px`
      }
      svg.getBoundingClientRect() // the start, laid down before the glide
      for (const { el } of moves) {
        el.style.transition = `${el.matches('.hm-ship') ? 'opacity 0.25s, ' : ''}translate ${FLIP_MS}ms ${FLIP_EASE}`
        el.style.translate = '0px 0px'
        const timer = setTimeout(() => {
          this.flipTimers.delete(timer)
          if (el.style.translate !== '0px 0px') return // a later glide has it now
          el.style.translate = ''
          el.style.transition = ''
        }, FLIP_MS + 50)
        this.flipTimers.add(timer)
      }
    },
    // Which fleet each project is in: { <id>: <fleet key> }, folded or not.
    whereabouts() {
      const out = {}
      for (const f of this.fleets) for (const p of this.projectsOf(f)) out[p.id] = f.key
      return out
    },
    // Laid out for the width it has, at 1:1.
    measure() {
      const w = this.$refs.wrap?.clientWidth
      if (w) this.width = w
    },
    live(s) {
      return liveProject(s.id)
    },
    stateOf(s) {
      return vesselState(this.live(s))
    },
    statusOf(s) {
      return statusWord(this.live(s))
    },
    runtimeOf(s) {
      return s.project.deployed_runtime || s.project.runtime
    },
    shape(s) {
      return SHIP_KINDS[shipKind(this.runtimeOf(s))]
    },
    shipClasses(s) {
      return [
        `state-${this.stateOf(s)}`,
        `rt-${this.runtimeOf(s)}`,
        `side-${s.side}`,
        {
          dim: this.matches && !this.matches.has(s.id),
          pointed: this.card?.id === s.id,
          lifted: this.drag?.ship.id === s.id,
          pending: this.moving === s.id,
          arriving: !!this.arrivals[s.id],
        },
      ]
    },
    // Where a ship lies, as a CSS transform rather than an attribute, so that
    // it can back in when new (.arriving, with the `translate` property, as
    // flip glides it); a ship at anchor is swung about its buoy.
    shipTransform(s) {
      const swing = s.rot
        ? ` translate(${ANCHOR_X}px, ${SHIP_B / 2}px) rotate(${s.rot}deg) translate(${-ANCHOR_X}px, ${-SHIP_B / 2}px)`
        : ''
      return `translate(${s.x}px, ${s.y}px)${swing}`
    },
    // The middle of a ship's hull along its berth, which way round it lies.
    midship(s) {
      return s.dir < 0 ? SHIP_L - this.shape(s).L / 2 : this.shape(s).L / 2
    },
    // How far along the voyage under way is (lib/vessels.js voyage), by the
    // store's clock, which ticks every second; null when there is none.
    voyageOf(s) {
      return voyage(this.live(s), store.now)
    },
    uneasy(s) {
      return !!this.voyageOf(s)?.overdue
    },
    // Out at its berth, how much further a ship under way has gone: up to
    // HEADWAY as its voyage goes on (along the map, as an SVG attribute).
    headway(s) {
      const v = s.side === 'anchor' ? null : this.voyageOf(s)
      return v ? `translate(${(s.dir * HEADWAY * v.p).toFixed(2)} 0)` : null
    },
    // Where its lamp is along the berth, which way round it lies.
    lampX(s) {
      return s.dir < 0 ? SHIP_L - this.shape(s).lamp : this.shape(s).lamp
    },
    // A ship under way has cast off: a little out from its jetty, bow first.
    castOff(s) {
      return this.stateOf(s) === 'underway' && s.side !== 'anchor' ? s.dir * CAST_OFF : 0
    },
    // How many of a container ship's three stacks are on deck: its memory in use.
    stacksOf(s) {
      return cargoStacks(this.live(s))
    },
    wornOf(s) {
      return isWorn(this.live(s))
    },
    // The ship's instruments: what its drawing stands for and the row in its
    // card does not say — the voyage under way (or how long one usually
    // takes), its cargo (memory against its limit), its engine (CPU), its
    // hull (a container's restarts since its deploy). Each { key, label,
    // value (short: a reading that fits its column), said (the reading in
    // words, for the ship's aria-description), fill (0..1, a bar; null for
    // none), tone ('' | 'warn' | 'bad' | 'blind') }. Under the row in the
    // card — never a native tooltip, which would come up over the card.
    gaugesOf(s) {
      const live = this.live(s)
      if (!live) return []
      const out = []
      const gauge = (key, label, value, said, fill = null, tone = '') => out.push({ key, label, value, said, fill, tone })
      const cur = live.currentDeployment
      const v = this.voyageOf(s)
      if (cur && cur.status === 'queued') {
        gauge('voyage', 'Voyage', 'queued', 'in the queue')
      } else if (v && v.expected == null) {
        gauge('voyage', 'Voyage', `${roughly(v.elapsed)} out`, `${roughly(v.elapsed)} out, none to go by`, v.p, 'blind')
      } else if (v?.overdue) {
        gauge('voyage', 'Voyage', `+${roughly(v.elapsed - v.expected)}`, `${roughly(v.elapsed - v.expected)} over, usually ${roughly(v.expected)}`, 1, 'warn')
      } else if (v) {
        gauge('voyage', 'Voyage', `${roughly(v.expected - v.elapsed)} left`, `${roughly(v.expected - v.elapsed)} to go of ${roughly(v.expected)}`, v.p)
      }
      const online = live.pm2?.status === 'online'
      const used = live.pm2?.memory
      if (online && used > 0) {
        const mb = live.info?.memory_mb || 0
        const fill = mb ? Math.min(1, used / (mb * 1024 * 1024)) : null
        const value = mb ? `${Math.round(used / (1024 * 1024))}/${mb} MB` : bytes(used)
        gauge('cargo', 'Cargo', value, mb ? `${bytes(used)} of ${mb} MB` : `${bytes(used)}, no limit`, fill, fill == null ? '' : toneOf(fill))
      }
      if (online && typeof live.pm2?.cpu === 'number') {
        const fill = Math.min(1, live.pm2.cpu / 100)
        gauge('engine', 'Engine', `${Math.round(live.pm2.cpu)}%`, `${Math.round(live.pm2.cpu)}% CPU`, fill, toneOf(fill, 0.75, 0.95))
      }
      if (shipKind(this.runtimeOf(s)) === 'container' && typeof live.pm2?.restarts === 'number') {
        const n = live.pm2.restarts
        gauge('hull', 'Hull', n ? `${n} restart${n === 1 ? '' : 's'}` : 'sound', n ? `${n} restart${n === 1 ? '' : 's'} since its deploy` : 'sound, no restarts', null, this.wornOf(s) ? 'warn' : '')
      }
      if (!cur) {
        const usual = usualVoyage(live)
        if (usual != null) gauge('usual', 'Voyages', `~${roughly(usual)}`, `usually ${roughly(usual)}`)
      }
      return out
    },
    // The gauges in words, for the ship's aria-description.
    gaugeWords(s) {
      return this.gaugesOf(s).map(g => `${g.label}: ${g.said}`).join(' · ')
    },
    // What fits under the ship, along its berth.
    shortName(s) {
      return shipName(s.project.name)
    },
    // The pier's name as its shed carries it, and a roof wide enough for it.
    pierLabel(j) {
      return shipName(j.name, 26)
    },
    signWidth(j) {
      return Math.max(58, Math.round(this.pierLabel(j).length * 7.6 + 24))
    },
    openProject(s) {
      this.$router.push(`/projects/${s.id}`)
    },
    // A click opens the project — except the one that ends a drag, and a
    // finger's first tap, which brings up the card instead.
    onShipClick(s) {
      if (this.swallowClick) return
      const touch = this.lastPointer === 'touch'
      this.lastPointer = ''
      if (touch && this.tapped !== s.id) {
        this.showCard(s)
        this.tapped = s.id
        return
      }
      this.openProject(s)
    },
    // A finger on anything but a ship or its card puts the card away.
    onPointerAnywhere(event) {
      if (event.pointerType !== 'touch' || !this.card) return
      if (!event.target?.closest?.('.harbor-card, .hm-ship')) this.card = null
    },
    onShipFocus(s) {
      this.focusId = s.id
      this.showCard(s)
    },
    onShipKey(event, s) {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'Escape') {
        this.card = null
        return
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = nearestShip(this.ships, s.id, event.key)
      if (next) this.focusShip(next.id)
    },
    // Escape in the card (unless its menu took it) goes back to the ship.
    onCardKey(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || !this.card) return
      event.preventDefault()
      this.focusShip(this.card.id)
    },
    focusShip(id) {
      this.focusId = id
      this.$nextTick(() => this.$refs.svg?.querySelector(`[data-ship="${id}"]`)?.focus())
    },
    onCalm() {
      this.still = !!this.calm?.matches
    },
    // The swell: everything on the map that moves all the time — the ships
    // riding it (uneasily on an overdue voyage), swinging at anchor, the
    // pennants, the wakes, the lamps pulsing, the waves drifting — moved
    // together, SWELL_MS apart, by writing SVG attributes. Not SMIL and not
    // CSS animations: either of those changes the SVG every frame, and Chrome
    // then records all of it again every frame (with a full harbor, nearly
    // the whole main thread); a CSS transform animation is composited
    // instead, but turns a bitmap of the ship, soft at every edge. Fifteen
    // redraws a second keep it sharp and cheap. Runs while the map is in
    // sight and motion is welcome. The one exception is the lighthouse's
    // beam: a soft gradient, which a composited bitmap cannot blur, turned
    // by CSS at the screen's own rate — fifteen steps a second of a sweep
    // that wide show as judder.
    tendSwell() {
      const run = !this.still && !this.asleep
      if (run && !this.swellTimer) {
        this.swellTimer = setInterval(() => this.swellTick(), SWELL_MS)
        this.swellTick()
      } else if (!run && this.swellTimer) {
        clearInterval(this.swellTimer)
        this.swellTimer = null
      }
      if (this.still) this.calmSwell()
    },
    // One beat of the swell, at `ms` (performance.now()).
    swellTick(ms = performance.now()) {
      const svg = this.$refs.svg
      if (!svg) return
      const t = ms / 1000
      // 0 → 1 → 0 over `period` seconds, eased at either end; `lead` puts a
      // ship ahead of the others in it
      const wave = (period, lead = 0) => (1 - Math.cos((2 * Math.PI * (t + lead)) / period)) / 2
      const f = (n, d = 2) => n.toFixed(d)
      for (const g of svg.querySelectorAll('.hm-bob')) {
        const uneasy = g.dataset.uneasy === '1'
        const v = wave(uneasy ? 1.7 : 5.5, Number(g.dataset.phase) * 0.8)
        const roll = uneasy ? -1.6 + 3.2 * v : 0.5 * v
        g.setAttribute('transform', `translate(0 ${f((uneasy ? 1.5 : 1) * v)}) rotate(${f(roll)} ${g.dataset.cx} ${SHIP_B / 2})`)
      }
      for (const g of svg.querySelectorAll('.side-anchor > .hm-sway')) {
        g.setAttribute('transform', `rotate(${f(-1.2 + 2.4 * wave(9, Number(g.dataset.phase) * 1.3))} ${ANCHOR_X} ${SHIP_B / 2})`)
      }
      for (const flag of svg.querySelectorAll('.hm-flag')) flag.setAttribute('transform', `skewY(${f(-7 + 14 * wave(2.6), 1)})`)
      const dash = f(-((t % 0.8) / 0.8) * 8, 1)
      for (const p of svg.querySelectorAll('.hm-wake path')) p.setAttribute('stroke-dashoffset', dash)
      // under way a lamp breathes; down or failed it blinks
      const breathe = f(1 - 0.8 * wave(1.3))
      const blink = Math.floor(t / 0.45) % 2 ? '0.2' : '1'
      for (const glow of svg.querySelectorAll('.state-underway .hm-lamp-glow')) glow.style.setProperty('--pulse', breathe)
      for (const glow of svg.querySelectorAll('.state-down .hm-lamp-glow, .state-failed .hm-lamp-glow')) glow.style.setProperty('--pulse', blink)
      svg.querySelector('#hm-waves')?.setAttribute('patternTransform', `translate(${f((t * 4) % 56, 1)} 0)`)
    },
    // Reduced motion: everything the swell moved, back at rest.
    calmSwell() {
      const svg = this.$refs.svg
      if (!svg) return
      for (const el of svg.querySelectorAll('.hm-bob, .hm-sway, .hm-flag')) el.removeAttribute('transform')
      for (const p of svg.querySelectorAll('.hm-wake path')) p.removeAttribute('stroke-dashoffset')
      for (const glow of svg.querySelectorAll('.hm-lamp-glow')) glow.style.removeProperty('--pulse')
      svg.querySelector('#hm-waves')?.removeAttribute('patternTransform')
    },
    onVisibility() {
      this.pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    },

    // --- folding a fleet to its quay ---
    // Folded, unless a search finds something in it.
    isFolded(f) {
      if (!this.folded[String(f.key)] || this.fleets.length < 2) return false
      return !(this.matches && this.projectsOf(f).some(p => this.matches.has(p.id)))
    },
    projectsOf(f) {
      return [...f.piers.flatMap(p => p.projects), ...f.loose]
    },
    // Folds or unfolds a fleet; one a search has opened is unfolded for good.
    // A click on the lighthouse puts it out, and lights it again.
    toggleLight() {
      this.lit = !this.lit
      saveLit(this.lit)
    },
    onLightKey(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      this.toggleLight()
    },
    toggleFleet(key) {
      const k = String(key)
      if (this.folded[k]) delete this.folded[k]
      else this.folded[k] = true
      saveFolded(this.folded)
      if (this.card && !this.ships.some(s => s.id === this.card.id)) this.card = null
    },
    foldStyle(f) {
      const q = f.quays[0]
      return { left: `${q.x}px`, top: `${q.y}px`, width: `${q.w}px`, height: `${FOLD_H}px` }
    },
    foldTitle(f) {
      if (f.folded) return `Show ${f.label}'s piers and ships`
      if (this.folded[String(f.key)]) return 'Opened for the search — click to keep it open'
      return `Fold ${f.label} to its quay`
    },
    // What a folded quay says: how many ships, and how many of them need
    // attention or are under way.
    summaryOf(f) {
      const fleet = this.fleets.find(x => x.key === f.key)
      const states = (fleet ? this.projectsOf(fleet) : []).map(p => vesselState(liveProject(p.id)))
      const n = states.length
      const attention = states.filter(st => ATTENTION.has(st)).length
      const underway = states.filter(st => st === 'underway').length
      return {
        ships: n === 1 ? '1 ship' : `${n} ships`,
        attention: attention ? `${attention} ${STATE_FILTERS.attention.that}` : '',
        underway: underway ? `${underway} under way` : '',
      }
    },
    showCard(s) {
      if (this.drag) return
      clearTimeout(this.hideTimer)
      this.card = s
    },

    // --- dragging a ship to another pier ---
    // A pointer event's place on the map, in the layout's units (the map is
    // drawn 1:1, but narrower than its least width it is scaled down).
    mapPoint(event) {
      const box = this.$refs.svg.getBoundingClientRect()
      const scale = box.width ? this.layout.width / box.width : 1
      return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale }
    },
    canMoor(fleet, jetty) {
      return Boolean(this.drag) && this.drag.fleet === fleet.key && jetty.pierId !== this.drag.ship.pierId
    },
    canAnchor(fleet) {
      return Boolean(this.drag) && this.drag.fleet === fleet.key && this.drag.ship.pierId != null
    },
    // A press on a ship may become a drag: with a mouse or a pen once it has
    // moved a little, with a finger once it has rested there (a finger that
    // moves at once is scrolling the page).
    onPress(event, ship, fleet) {
      this.lastPointer = event.pointerType
      if ((event.button ?? 0) !== 0 || this.press || this.moving != null) return
      const at = this.mapPoint(event)
      const touch = event.pointerType === 'touch'
      this.press = { ship, fleet: fleet.key, x0: at.x, y0: at.y, touch, timer: null }
      if (touch) this.press.timer = setTimeout(() => this.press && this.pickUp(at), HOLD_MS)
      window.addEventListener('pointermove', this.onPointerMove)
      window.addEventListener('pointerup', this.onRelease)
      window.addEventListener('pointercancel', this.endPress)
      window.addEventListener('keydown', this.onDragKey)
    },
    pickUp(at) {
      const { ship, fleet, x0, y0 } = this.press
      clearTimeout(this.hideTimer)
      this.card = null
      this.drag = { ship, fleet, x: at.x, y: at.y, gx: x0 - ship.x, gy: y0 - ship.y, target: dropTarget(this.layout, ship.id, at.x, at.y) }
    },
    onPointerMove(event) {
      if (!this.press) return
      const at = this.mapPoint(event)
      if (!this.drag) {
        const far = Math.hypot(at.x - this.press.x0, at.y - this.press.y0)
        if (this.press.touch) {
          if (far > HOLD_SLACK) this.endPress() // not resting: a scroll
          return
        }
        if (far < DRAG_START) return
        this.pickUp(at)
      }
      this.drag.x = at.x
      this.drag.y = at.y
      this.drag.target = dropTarget(this.layout, this.drag.ship.id, at.x, at.y)
    },
    onTouchMove(event) {
      if (this.drag && event.cancelable) event.preventDefault()
    },
    // A long press on a link brings up the browser's menu for it; not while
    // a finger is picking a ship up.
    onContextMenu(event) {
      if (this.drag || this.press?.touch) event.preventDefault()
    },
    onRelease() {
      const drag = this.drag
      this.endPress()
      if (!drag) return
      this.swallow()
      if (drag.target.kind === 'pier') this.moveTo(drag.ship, drag.target.pierId)
      else if (drag.target.kind === 'anchor') this.moveTo(drag.ship, null)
    },
    // Escape puts the ship back.
    onDragKey(event) {
      if (event.key !== 'Escape' || !this.drag) return
      this.endPress()
      this.swallow(true)
    },
    endPress() {
      clearTimeout(this.press?.timer)
      this.press = null
      this.drag = null
      window.removeEventListener('pointermove', this.onPointerMove)
      window.removeEventListener('pointerup', this.onRelease)
      window.removeEventListener('pointercancel', this.endPress)
      window.removeEventListener('keydown', this.onDragKey)
    },
    // The click the browser sends after a drag's release would open the
    // project: let it pass unanswered. `held`: the button is still down
    // (Escape), so the release — and its click — is yet to come.
    swallow(held = false) {
      this.swallowClick = true
      const done = () => setTimeout(() => { this.swallowClick = false }, 0)
      if (held) window.addEventListener('pointerup', done, { once: true })
      else done()
    },
    // Saves the move (null: to no pier) the way the ⋮ menu does — a refusal
    // is said in a dialog there. The harbor's new shape comes with the live
    // state, and the ships that change berth glide there (the layout watcher).
    async moveTo(ship, pierId) {
      this.moving = ship.id
      try {
        await performAction(ship.project, `pier:${pierId ?? ''}`)
      } finally {
        this.moving = null
      }
    },
    keepCard() {
      clearTimeout(this.hideTimer)
    },
    // A moment's grace, so the pointer can travel from the ship to its card.
    hideSoon() {
      clearTimeout(this.hideTimer)
      this.hideTimer = setTimeout(() => {
        if (!this.$el?.querySelector?.('.harbor-card .action-menu-list')) this.card = null
      }, 250)
    },
  },
}
</script>
