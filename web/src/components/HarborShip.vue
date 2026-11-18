<template>
  <g class="hm-ship-art">
    <path class="hm-cast" :d="shape.hull" transform="translate(2.5 3.5)" />
    <path class="hm-hull" :d="shape.hull" />
    <path class="hm-deck" :d="shape.deck" />
    <template v-if="kind === 'container'">
      <rect class="hm-hatch" x="76" y="8.5" width="11" height="9" rx="1" /><circle class="hm-fitting" cx="97" cy="13" r="2.2" />
      <!-- three places on deck, a stack on as many as it is laden -->
      <g class="hm-cargo">
        <template v-for="i in 3" :key="i">
          <rect :class="{ laden: i <= stacks }" :x="5.5 + 17 * i" y="6" width="15" height="14" rx="1" />
          <path v-if="i <= stacks" :d="`M${13 + 17 * i} 6 v14 M${5.5 + 17 * i} 13 h15`" />
        </template>
      </g>
      <!-- knocked about: scrapes along the rail, a plate over the bow -->
      <g v-if="worn" class="hm-scuffs">
        <path d="M27 2.6 l9 0.9 M41 2.4 l6 1.1 M58 23.6 l10 -1 M73 23.4 l5 -0.9" />
        <rect x="101" y="10" width="7" height="6" rx="0.8" transform="rotate(-14 104.5 13)" />
      </g>
      <rect class="hm-house" x="6.5" y="6" width="12" height="14" rx="1.5" /><rect class="hm-glass" x="15.6" y="7.5" width="1.8" height="11" rx="0.9" />
    </template>
    <template v-else-if="kind === 'static'">
      <rect class="hm-well" x="9" y="9" width="13" height="8" rx="2.5" />
      <rect class="hm-house" x="26" y="8" width="20" height="10" rx="3.5" /><rect class="hm-glass" x="42.4" y="9.6" width="1.8" height="6.8" rx="0.9" />
      <!-- seen from above: the mainsail bellied out over its boom, the jib ahead of the mast -->
      <path class="hm-sail" d="M52 13 L21 9.5 Q38 2 52 13 Z" /><path class="hm-sail" d="M94 13 L55 12 Q76 4.5 94 13 Z" />
    </template>
    <template v-else>
      <path class="hm-fender" d="M58 2.6 C70 4.5 79 9 82.6 13 C79 17 70 21.5 58 23.4" />
      <g class="hm-tyres">
        <circle cx="12" cy="1.6" r="1.9" /><circle cx="26" cy="1.6" r="1.9" /><circle cx="40" cy="1.6" r="1.9" />
        <circle cx="12" cy="24.4" r="1.9" /><circle cx="26" cy="24.4" r="1.9" /><circle cx="40" cy="24.4" r="1.9" />
      </g>
      <rect class="hm-fitting" x="6" y="10.5" width="4.5" height="5" rx="1" />
      <circle class="hm-funnel" cx="20" cy="13" r="4.6" /><circle class="hm-funnel-in" cx="20" cy="13" r="2.2" />
      <rect class="hm-house" x="30" y="5.5" width="19" height="15" rx="3.5" /><rect class="hm-glass" x="45.4" y="7.5" width="1.8" height="11" rx="0.9" />
    </template>
    <!-- its lamp shows the state -->
    <circle class="hm-lamp-glow" :cx="shape.lamp" :cy="SHIP_B / 2" r="8" />
    <circle class="hm-lamp" :cx="shape.lamp" :cy="SHIP_B / 2" r="2.5" />
  </g>
</template>

<script>
import { SHIP_KINDS, SHIP_B, shipKind } from '../lib/harborMap.js'

// One ship of the harbor map, seen from above, stern at x = 0 and bow to the
// right — an SVG fragment, for the map and for its legend. What kind of ship
// tells the runtime: a container ship, a sailing boat (a static site), a tug
// (a host process). A container ship carries `stacks` of its three (how
// laden it is, lib/harborMap.js cargoStacks) and shows it when it is `worn`.
// Its colours come from `--c` on whatever holds it.
export default {
  name: 'HarborShip',
  props: {
    runtime: { type: String, default: 'container' },
    stacks: { type: Number, default: 3 },
    worn: { type: Boolean, default: false },
  },
  data() {
    return { SHIP_B }
  },
  computed: {
    kind() {
      return shipKind(this.runtime)
    },
    shape() {
      return SHIP_KINDS[this.kind]
    },
  },
}
</script>
