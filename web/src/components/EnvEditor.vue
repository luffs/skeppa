<template>
  <div>
    <p class="hint" style="font-size: 13.5px; margin: 0 0 16px; max-width: 640px">
      Values are AES-256-GCM encrypted at rest and masked until revealed. They are injected into
      the deploy script and the pm2 process, decrypted only in memory — press <em>Restart</em>
      to apply saved changes to the running process. Saving replaces the whole set.
    </p>

    <!-- The whole Manifest as .env text: for editing many at once, renaming,
         copying out, or multi-line values. It shows every value. -->
    <template v-if="mode === 'text'">
      <textarea
        v-model="text"
        class="code env-text"
        :rows="Math.min(24, Math.max(8, text.split('\n').length + 1))"
        spellcheck="false"
        autocomplete="off"
        placeholder="KEY=value"
      ></textarea>
      <ul class="env-preview">
        <li v-for="(item, i) in textPreview" :key="i" :class="item.kind">{{ item.text }}</li>
      </ul>
    </template>

    <template v-else>
      <div v-if="rows.length" class="env-rows">
        <div v-for="(row, i) in rows" :key="i" class="env-row">
          <input v-model="row.key" class="code key" placeholder="KEY" />
          <!-- A line break cannot live in a single-line input: the browser
               strips it, and editing there would save the value without it. -->
          <textarea
            v-if="isMultiline(row) && revealed"
            v-model="row.value"
            class="code value multiline"
            :rows="Math.min(8, row.value.split('\n').length)"
            spellcheck="false"
            @input="row.masked = false"
          ></textarea>
          <input
            v-else-if="isMultiline(row)"
            class="code value"
            disabled
            :value="`(multi-line value, ${row.value.split('\n').length} lines — reveal to see or edit)`"
          />
          <input
            v-else
            v-model="row.value"
            class="code value"
            :type="revealed ? 'text' : 'password'"
            :placeholder="row.masked ? '(unchanged)' : 'value'"
            @input="row.masked = false"
          />
          <button class="secondary small" style="padding: 8px 12px" @click="rows.splice(i, 1)">✕</button>
        </div>
      </div>
      <p v-else class="hint">Nothing on the manifest — no ENV variables yet.</p>

      <!-- Adding many at once without seeing (or retyping) what is already there. -->
      <div v-if="pasting" class="env-paste">
        <label>
          Paste variables <span class="soft">(.env lines — added to the list; a key already there gets the new value)</span>
        </label>
        <textarea
          v-model="pasteText"
          class="code"
          rows="6"
          spellcheck="false"
          autocomplete="off"
          :placeholder="'DATABASE_URL=postgres://…\nAPI_KEY=…'"
        ></textarea>
        <ul v-if="pasteText.trim()" class="env-preview">
          <li v-for="(item, i) in pastePreview" :key="i" :class="item.kind">{{ item.text }}</li>
        </ul>
        <div class="row" style="margin-top: 10px">
          <button class="small" :disabled="!pasteReady" @click="mergePaste">Add to the list</button>
          <button class="secondary small" @click="closePaste">Cancel</button>
        </div>
      </div>
    </template>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="hint">{{ notice }}</p>
    <div class="row" style="margin-top: 18px">
      <template v-if="mode === 'text'">
        <button class="secondary" :disabled="textParsed.problems.length > 0" @click="toRows">Back to rows</button>
      </template>
      <template v-else>
        <button class="secondary" @click="addRow">+ Add variable</button>
        <button class="secondary" :disabled="pasting" @click="openPaste">Paste variables</button>
        <button class="secondary" :disabled="busy" @click="toText">Edit as text</button>
        <button class="secondary" @click="toggleReveal">{{ revealed ? 'Hide values' : 'Reveal values' }}</button>
      </template>
      <button :disabled="busy || (mode === 'text' && textParsed.problems.length > 0)" @click="save">
        {{ busy ? 'Saving…' : 'Save all' }}
      </button>
    </div>
  </div>
</template>

<script>
import { api } from '../api.js'
import { parseDotenv, serializeDotenv, diffVars } from '../lib/dotenv.js'

const list = keys => keys.join(', ')

// What a parse found, as lines for a preview: problems first (they block),
// then what the change would do.
function describeParse(parsed) {
  const items = parsed.problems.map(p => ({ kind: 'error', text: `Line ${p.line} ${p.reason}.` }))
  for (const key of parsed.duplicates) items.push({ kind: 'hint', text: `${key} appears more than once — the last one is used.` })
  if (parsed.comments) {
    items.push({ kind: 'hint', text: `Comments are not saved (${parsed.comments}) — only names and values are stored.` })
  }
  return items
}

export default {
  name: 'EnvEditor',
  props: { projectId: { type: [Number, String], required: true } },
  data() {
    return {
      rows: [],
      revealed: false,
      busy: false,
      error: '',
      notice: '',
      mode: 'rows', // 'rows' | 'text'
      text: '',
      saved: new Map(), // what is stored, in plaintext — the text view's diff baseline
      pasting: false,
      pasteText: '',
    }
  },
  computed: {
    textParsed() {
      return parseDotenv(this.text)
    },
    textPreview() {
      const parsed = this.textParsed
      const items = describeParse(parsed)
      if (parsed.problems.length) return items
      const { added, changed, removed } = diffVars(this.saved, parsed.vars)
      if (added.length) items.push({ kind: '', text: `New: ${list(added)}` })
      if (changed.length) items.push({ kind: '', text: `Changed: ${list(changed)}` })
      if (removed.length) items.push({ kind: 'warn', text: `Removed: ${list(removed)}` })
      if (!added.length && !changed.length && !removed.length) items.push({ kind: 'hint', text: 'No changes.' })
      return items
    },
    pasteParsed() {
      return parseDotenv(this.pasteText)
    },
    pasteReady() {
      return this.pasteParsed.vars.length > 0 && this.pasteParsed.problems.length === 0
    },
    pastePreview() {
      const parsed = this.pasteParsed
      const items = describeParse(parsed)
      if (parsed.problems.length) return items
      const listed = new Set(this.rows.map(r => r.key.trim()))
      const fresh = parsed.vars.filter(v => !listed.has(v.key)).map(v => v.key)
      const replacing = parsed.vars.filter(v => listed.has(v.key)).map(v => v.key)
      if (fresh.length) items.push({ kind: '', text: `New: ${list(fresh)}` })
      if (replacing.length) items.push({ kind: 'warn', text: `Replaces the value of: ${list(replacing)}` })
      if (!parsed.vars.length) items.push({ kind: 'hint', text: 'No variables found yet.' })
      return items
    },
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
    isMultiline(row) {
      return row.value.includes('\n')
    },
    addRow() {
      this.rows.push({ key: '', value: '', masked: false })
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
    // The text view starts from the list as it is now (unsaved edits too) and
    // diffs against what is stored.
    async toText() {
      this.error = ''
      this.notice = ''
      try {
        await this.fillMasked()
        const stored = await api.get(`/api/projects/${this.projectId}/env?reveal=1`)
        this.saved = new Map(stored.map(v => [v.key, v.value]))
        this.revealed = true
        this.text = serializeDotenv(this.rows.filter(r => r.key.trim()).map(r => ({ key: r.key.trim(), value: r.value })))
        this.closePaste()
        this.mode = 'text'
      } catch (err) {
        this.error = err.message
      }
    },
    toRows() {
      const { vars, problems } = this.textParsed
      if (problems.length) return
      this.rows = vars.map(v => ({ key: v.key, value: v.value, masked: false }))
      this.mode = 'rows'
      this.error = ''
    },
    openPaste() {
      this.pasting = true
      this.pasteText = ''
      this.notice = ''
    },
    closePaste() {
      this.pasting = false
      this.pasteText = ''
    },
    mergePaste() {
      if (!this.pasteReady) return
      let added = 0
      let replaced = 0
      for (const { key, value } of this.pasteParsed.vars) {
        const row = this.rows.find(r => r.key.trim() === key)
        if (row) {
          row.value = value
          row.masked = false
          replaced++
        } else {
          this.rows.push({ key, value, masked: false })
          added++
        }
      }
      this.closePaste()
      this.notice = `${added} added${replaced ? `, ${replaced} replaced` : ''} — press Save all to store them.`
    },
    async save() {
      this.busy = true
      this.error = ''
      this.notice = ''
      try {
        let payload
        if (this.mode === 'text') {
          if (this.textParsed.problems.length) throw new Error('Fix the lines marked above first.')
          payload = this.textParsed.vars.map(({ key, value }) => ({ key, value }))
        } else {
          await this.fillMasked()
          payload = this.rows
            .filter(r => r.key.trim())
            .map(r => ({ key: r.key.trim(), value: r.value }))
        }
        await api.put(`/api/projects/${this.projectId}/env`, payload)
        if (this.mode === 'text') {
          // Back as stored: sorted, comments gone — what the panel now holds.
          await this.load(true)
          this.saved = new Map(this.rows.map(r => [r.key, r.value]))
          this.text = serializeDotenv(this.rows)
        } else {
          await this.load(this.revealed)
        }
        this.notice = 'Saved ✔'
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
