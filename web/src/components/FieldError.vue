<template>
  <p v-if="message" class="field-error" role="alert">{{ message }}</p>
</template>

<script>
// The server's word on one field, right under it. `errors` is the `fields`
// map a 400 carries ({ subdomain: 'subdomain already routed', … }).
export default {
  name: 'FieldError',
  props: {
    errors: { type: Object, default: () => ({}) },
    name: { type: String, required: true },
  },
  computed: {
    message() {
      return this.errors?.[this.name] ?? ''
    },
  },
}
</script>
