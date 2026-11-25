<template>
  <!-- On a fleet server's pages while it is not reporting: what they show is
       what it last said, and nothing asked of it gets through until it is back. -->
  <div v-if="ship.node && !ship.online" class="ship-offline" role="status">
    <span class="chip red">offline</span>
    <span>
      {{ ship.name }} is not reporting<template v-if="ship.lastSeenAt"> — last seen {{ timeAgo(ship.lastSeenAt) }}</template>.
      This is what it last reported; its apps keep running, and changes wait until it is back.
    </span>
  </div>
</template>

<script>
import { shipInject } from '../lib/ship.js'
import { timeAgo } from '../lib/format.js'

export default {
  name: 'ShipOffline',
  inject: shipInject, // which server (lib/ship.js)
  methods: { timeAgo },
}
</script>

<style scoped>
.ship-offline {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--line-soft, rgba(127, 127, 127, 0.25));
  border-left: 3px solid var(--red, #f85149);
  border-radius: 6px;
  font-size: 13.5px;
}
</style>
