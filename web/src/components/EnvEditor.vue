<template>
  <div>
    <p class="hint">
      Values are AES-256-GCM encrypted at rest and masked here until revealed.
      Saving replaces the whole set and rewrites the app's <span class="mono">.env</span>
      immediately — press <em>Restart</em> to apply them to the running process.
    </p>
    <table v-if="rows.length">
      <thead>
        <tr><th style="width: 35%">Key</th><th>Value</th><th style="width: 40px"></th></tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td><input v-model="row.key" class="code" placeholder="KEY" /></td>
          <td>
            <input
              v-model="row.value"
              class="code"
              :type="revealed ? 'text' : 'password'"
              :placeholder="row.masked ? '(unchanged)' : 'value'"
              @input="row.masked = false"
            />
          </td>
          <td><button class="secondary small" @click="rows.splice(i, 1)">✕</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else class="hint">No ENV variables.</p>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row" style="margin-top: 12px">
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
