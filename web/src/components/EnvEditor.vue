<template>
  <div>
    <p class="hint" style="font-size: 13.5px; margin: 0 0 16px; max-width: 640px">
      Values are AES-256-GCM encrypted at rest and masked until revealed. They are injected into
      the deploy script and the pm2 process, decrypted only in memory — press <em>Restart</em>
      to apply saved changes to the running process. Saving replaces the whole set.
    </p>
    <div v-if="rows.length" class="env-rows">
      <div v-for="(row, i) in rows" :key="i" class="env-row">
        <input v-model="row.key" class="code key" placeholder="KEY" />
        <input
          v-model="row.value"
          class="code value"
          :type="revealed ? 'text' : 'password'"
          :placeholder="row.masked ? '(unchanged)' : 'value'"
          @input="row.masked = false"
        />
        <button class="secondary small" style="padding: 8px 12px" @click="rows.splice(i, 1)">✕</button>
      </div>
    </div>
    <p v-else class="hint">No cargo aboard — no ENV variables yet.</p>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row" style="margin-top: 18px">
      <button class="secondary" @click="rows.push({ key: '', value: '', masked: false })">+ Add variable</button>
      <button class="secondary" @click="toggleReveal">{{ revealed ? 'Hide values' : 'Reveal values' }}</button>
      <button :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save all' }}</button>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'

export default {
  name: 'EnvEditor',
  props: { projectId: { type: [Number, String], required: true } },
  data() {
    return { rows: [], revealed: false, busy: false, error: '' }
  },
  async created() {
    await this.load(false)
  },
  methods: {
    async load(reveal) {
      const vars = await api.get(`/api/projects/${this.projectId}/env${reveal ? '?reveal=1' : ''}`)
      this.rows = vars.map(v => ({ key: v.key, value: v.value ?? '', masked: v.masked }))
      this.revealed = reveal
    },
    async toggleReveal() {
      if (this.revealed) {
        this.revealed = false
      } else {
        await this.fillMasked()
        this.revealed = true
      }
    },
    // Masked rows have empty values client-side; fetch plaintext for the ones
    // the user hasn't edited before saving or revealing.
    async fillMasked() {
      if (!this.rows.some(r => r.masked)) return
      const revealed = await api.get(`/api/projects/${this.projectId}/env?reveal=1`)
      const byKey = new Map(revealed.map(v => [v.key, v.value]))
      for (const row of this.rows) {
        if (row.masked && byKey.has(row.key)) {
          row.value = byKey.get(row.key)
          row.masked = false
        }
      }
    },
    async save() {
      this.busy = true
      this.error = ''
      try {
        await this.fillMasked()
        const payload = this.rows
          .filter(r => r.key.trim())
          .map(r => ({ key: r.key.trim(), value: r.value }))
        await api.put(`/api/projects/${this.projectId}/env`, payload)
        await this.load(this.revealed)
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
