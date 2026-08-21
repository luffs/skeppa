<template>
  <div class="container mid">
    <div class="page-head">
      <h1 style="margin: 0">Shipyard</h1>
      <span class="mono" style="font-size: 12px; color: var(--dim)">container images</span>
    </div>
    <Shipyard />
  </div>
</template>

<script>
import Shipyard from '../components/Shipyard.vue'

export default {
  name: 'ShipyardView',
  components: { Shipyard },
}
</script>
