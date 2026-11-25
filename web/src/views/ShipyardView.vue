<template>
  <div class="container mid">
    <!-- Another server's page, run through the fleet (lib/ship.js). -->
    <router-link v-if="ship.node" to="/fleet" class="mono" style="font-size: 12px; color: var(--dim)">← back to the fleet</router-link>
    <ShipOffline />
    <div class="page-head">
      <h1 style="margin: 0">Shipyard</h1>
      <span v-if="ship.node" class="chip blue">on {{ ship.name }}</span>
      <span class="mono" style="font-size: 12px; color: var(--dim)">container images</span>
    </div>
    <Shipyard />
  </div>
</template>

<script>
import Shipyard from '../components/Shipyard.vue'
import ShipOffline from '../components/ShipOffline.vue'
import { shipProvider } from '../lib/ship.js'

export default {
  name: 'ShipyardView',
  mixins: [shipProvider], // this panel's Shipyard, or a fleet server's
  components: { Shipyard, ShipOffline },
}
</script>
