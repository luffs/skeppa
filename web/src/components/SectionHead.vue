<template>
  <!-- The heading over a stretch of the harbor list: a server, or whose fleet
       on it. Folded, it says what its vessels would: how many, in what state. -->
  <div class="fleet-head" :class="[`${level}-head`, { nested, folded: collapsed }]">
    <button
      v-if="foldable"
      type="button"
      class="section-toggle"
      :aria-expanded="collapsed ? 'false' : 'true'"
      :aria-label="`${collapsed ? 'Unfold' : 'Fold'} ${label}`"
      :title="collapsed ? `Show ${label}'s vessels` : `Fold ${label} away`"
      @click="$emit('toggle')"
    >
      <span class="pier-chevron" :class="{ open: !collapsed }" aria-hidden="true">▸</span>
      <span class="section-label">{{ label }}</span>
    </button>
    <span v-else class="section-label">{{ label }}</span>
    <span v-if="detail" class="fleet-detail">{{ detail }}</span>
    <span v-if="online !== null" class="chip" :class="online ? 'green' : 'red'">{{ online ? 'online' : 'offline' }}</span>
    <span class="fleet-detail">{{ count }} vessel{{ count === 1 ? '' : 's' }}</span>
    <span v-if="collapsed && summary.length" class="pier-summary">
      <span v-for="s in summary" :key="s.key" class="pier-state" :class="'state-' + s.key">
        <span class="dot" :class="s.dot"></span>{{ s.text }}
      </span>
    </span>
    <span v-if="to" class="spacer"></span>
    <router-link v-if="to" :to="to" class="fleet-detail section-link" :title="`${label}: its overview, Engine room, Shipyard and Rigging`">server ↗</router-link>
  </div>
</template>

<script>
import { localShip } from '../lib/ship.js'
import { summarizeVessels } from '../lib/vessels.js'

export default {
  name: 'SectionHead',
  props: {
    // 'server' (a server of the fleet, this one included) or 'owner' (whose
    // projects, on this server)
    level: { type: String, default: 'owner' },
    label: { type: String, required: true },
    detail: { type: String, default: '' },
    // The project infos under it, for the count and the folded roll call.
    projects: { type: Array, default: () => [] },
    // whose live state those are (lib/ship.js)
    ship: { type: Object, default: () => localShip },
    // how many there are, when that is more than `projects` (a search thins those)
    total: { type: Number, default: null },
    foldable: { type: Boolean, default: true },
    collapsed: { type: Boolean, default: false },
    // A server's: whether it reports, and its page.
    online: { type: Boolean, default: null },
    to: { type: String, default: '' },
    // an owner's heading under a server's: one level down
    nested: { type: Boolean, default: false },
  },
  emits: ['toggle'],
  computed: {
    count() {
      return this.total ?? this.projects.length
    },
    summary() {
      return summarizeVessels(this.projects.map(p => this.ship.live.projects?.[p.id] ?? null))
    },
  },
}
</script>
