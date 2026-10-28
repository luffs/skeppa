<template>
  <span class="hint" v-if="!counts.total">—</span>
  <button v-else class="used-by" :class="{ open }" @click="$emit('toggle')">
    {{ counts.total }} {{ counts.total === 1 ? 'project' : 'projects' }}
    <span v-if="counts.outdated" class="outdated">{{ counts.outdated }} outdated</span>
    <span class="caret">{{ open ? '▾' : '▸' }}</span>
  </button>
</template>

<script>
// The row's stand-in for the list of projects: how many there are, and how
// many of them a restart would move onto the image now in the store. The list
// itself (ImageUsers) opens elsewhere — in a row of its own under the table,
// or under an image card — where it has the width to say something per
// project instead of crowding one cell.
export default {
  name: 'UsedBySummary',
  props: {
    counts: { type: Object, required: true },
    open: { type: Boolean, default: false },
  },
  emits: ['toggle'],
}
</script>

<style scoped>
.used-by {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--dim);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  cursor: pointer;
  white-space: nowrap;
}
.used-by:hover, .used-by.open { color: var(--ink); border-color: var(--line-strong); }

/* The only number here anything can act on, so it is the only one coloured. */
.outdated {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--amber-tint);
  color: var(--amber);
  font-size: 11px;
  font-weight: 700;
}

.caret { color: var(--dim); font-size: 10px; }
</style>
