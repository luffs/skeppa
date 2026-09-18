<template>
  <div class="source-files">
    <div class="log-toolbar">
      <div class="file-crumbs mono">
        <template v-for="(crumb, i) in crumbs" :key="crumb.path">
          <span v-if="i" class="sep">/</span>
          <a v-if="i < crumbs.length - 1" href="#" @click.prevent="open(crumb.path)">{{ crumb.name }}</a>
          <span v-else>{{ crumb.name }}</span>
        </template>
      </div>
      <span class="spacer"></span>
      <template v-if="file">
        <span class="log-meta">{{ fileSize(file.size) }}</span>
        <div class="log-streams" v-if="isMarkdown(file)">
          <button :class="{ active: !showSource }" @click="showSource = false">Rendered</button>
          <button :class="{ active: showSource }" @click="showSource = true">Source</button>
        </div>
        <button class="secondary small" @click="download(file.path)">Download</button>
      </template>
      <button class="secondary small" :disabled="busy" title="Read again from disk" @click="open(path)">↻</button>
    </div>

    <p v-if="error" class="error" style="margin: 0 0 8px">{{ error }}</p>

    <p v-if="missing" class="hint">
      No freight aboard yet — the files appear here once the first voyage has checked the repository out.
    </p>

    <template v-else-if="file">
      <p v-if="file.binary || file.tooLarge" class="hint">
        {{ file.binary ? 'A binary file' : 'Too large to show here' }} ({{ fileSize(file.size) }}) — download it to look inside.
      </p>
      <div v-else-if="isMarkdown(file) && !showSource" class="panel markdown" v-html="markdownOf(file)" @click="followLink"></div>
      <pre v-else class="logview fileview" v-html="codeOf(file)"></pre>
    </template>

    <template v-else-if="dir">
      <div class="panel flush">
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>Name</th><th style="text-align: right">Size</th></tr>
            </thead>
            <tbody>
              <tr v-if="dir.path" class="deploy-row" @click="open(parentOf(dir.path))">
                <td class="mono" colspan="2">..</td>
              </tr>
              <tr
                v-for="entry in dir.entries"
                :key="entry.name"
                :class="{ 'deploy-row': entry.type !== 'other' }"
                @click="entry.type !== 'other' && open(join(dir.path, entry.name))"
              >
                <td class="mono" :style="entry.type === 'other' ? 'color: var(--dim)' : ''">
                  {{ entry.name }}<template v-if="entry.type === 'dir'">/</template>
                  <span v-if="entry.locked" class="hint" style="margin-left: 8px">kept in the Manifest</span>
                  <span v-else-if="entry.type === 'other'" class="hint" style="margin-left: 8px">not a file in this checkout</span>
                </td>
                <td class="mono" style="text-align: right; color: var(--dim)">
                  {{ entry.type === 'file' ? fileSize(entry.size) : '' }}
                </td>
              </tr>
              <tr v-if="!dir.entries.length">
                <td class="hint" colspan="2">(empty)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p v-if="dir.truncated" class="hint">Only the first {{ dir.entries.length }} entries are listed.</p>

      <template v-if="readme">
        <h2 class="mono" style="font-weight: 600; letter-spacing: 0">{{ readme.name }}</h2>
        <div v-if="isMarkdown(readme)" class="panel markdown" v-html="markdownOf(readme)" @click="followLink"></div>
        <pre v-else class="logview fileview">{{ readme.text }}</pre>
      </template>
    </template>

    <p v-else-if="busy" class="hint">Loading…</p>
  </div>
</template>

<script>
import { api } from '../api.js'
import { bytes } from '../lib/format.js'
import { renderMarkdown } from '../lib/markdown.js'
import { highlight, languageFor } from '../lib/highlight.js'

const README = /^readme(\.(md|markdown|txt))?$/i

// A read-only look into the project's source/ checkout: one folder at a
// time, a file in place of the listing when one is opened, and the folder's
// README under its listing. The server decides what may be read (and answers
// for folders and files on one route, so a README's relative links can simply
// be opened); nothing here can change a file. The two v-html bindings take
// only the output of lib/markdown.js and lib/highlight.js, which escape every
// character they are given.
export default {
  name: 'SourceFiles',
  props: { projectId: { type: [Number, String], required: true } },
  data() {
    return { path: '', dir: null, file: null, readme: null, missing: false, showSource: false, busy: false, error: '' }
  },
  computed: {
    crumbs() {
      const shown = this.file?.path ?? this.dir?.path ?? ''
      const crumbs = [{ name: 'source', path: '' }]
      for (const name of shown.split('/').filter(Boolean)) {
        crumbs.push({ name, path: this.join(crumbs.at(-1).path, name) })
      }
      return crumbs
    },
  },
  watch: {
    projectId: { immediate: true, handler() { this.open('') } },
  },
  methods: {
    // bytes() counts in kB from zero, fine for memory — a 300-byte dotfile is not "0 kB".
    fileSize: n => (n != null && n < 1024 ? `${n} B` : bytes(n)),
    join: (dir, name) => (dir ? `${dir}/${name}` : name),
    parentOf: path => path.split('/').slice(0, -1).join('/'),
    isMarkdown: file => /\.(md|markdown)$/i.test(file.name),
    markdownOf(file) {
      return renderMarkdown(file.text, { baseDir: this.parentOf(file.path) })
    },
    codeOf(file) {
      return highlight(file.text, languageFor(file.name))
    },
    url(path, raw = false) {
      return `/api/projects/${this.projectId}/files${raw ? '/raw' : ''}?path=${encodeURIComponent(path)}`
    },
    async open(path) {
      if (this.busy) return
      this.busy = true
      this.error = ''
      try {
        const found = await api.get(this.url(path))
        this.missing = found.type === 'missing'
        this.showSource = false
        this.readme = null
        if (found.type === 'file') {
          this.file = found
          this.path = found.path
        } else if (found.type === 'dir') {
          this.file = null
          this.dir = found
          this.path = found.path
          this.loadReadme(found)
        }
      } catch (err) {
        // Whatever was on screen stays; the message says why the rest did not come.
        this.error = `Could not open ${path || 'the source folder'}: ${err.message}`
      } finally {
        this.busy = false
      }
    },
    // Best-effort: a folder without a readable README is just a listing.
    async loadReadme(dir) {
      const entry = dir.entries.find(e => e.type === 'file' && README.test(e.name))
      if (!entry) return
      try {
        const found = await api.get(this.url(this.join(dir.path, entry.name)))
        // still the folder on screen? (this.dir is a reactive proxy — compare by path)
        if (this.dir?.path === dir.path && !this.file && found.type === 'file' && !found.binary && !found.tooLarge) this.readme = found
      } catch {
        // the listing already shows the file; opening it will say what is wrong
      }
    },
    // Relative links in a rendered document carry data-path (lib/markdown.js).
    followLink(event) {
      const link = event.target.closest?.('a[data-path]')
      if (!link) return
      event.preventDefault()
      this.open(link.dataset.path)
    },
    // A plain link click, so the browser streams it to disk; the server sends
    // every file as an attachment, whatever it is.
    download(path) {
      const link = document.createElement('a')
      link.href = this.url(path, true)
      link.download = path.split('/').pop()
      document.body.appendChild(link)
      link.click()
      link.remove()
    },
  },
}
</script>
