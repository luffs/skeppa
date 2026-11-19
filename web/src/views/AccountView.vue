<template>
  <div class="container mid">
    <div class="page-head">
      <h1 style="margin: 0">Account</h1>
    </div>
    <div class="panel" style="max-width: 680px">
      <AccountFields />
    </div>
  </div>
</template>

<script>
import AccountFields from '../components/AccountFields.vue'

// A tenant's own page — the one place they manage anything about
// themselves. An admin's account lives under Rigging instead (the router
// sends /account there).
export default {
  name: 'AccountView',
  components: { AccountFields },
}
</script>
