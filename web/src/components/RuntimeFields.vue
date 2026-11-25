<template>
  <!-- What runs, then — for a container — what it may use, reach and see,
       each under a small heading. The build image lives under Build (it is
       the deploy script's), the gate's files under Routing. -->
  <section class="section-part">
    <h3 v-if="runtime === 'container'" class="section-part-title">What runs</h3>
    <RuntimeChoice :runtime="runtime" :tenant="tenant" :existing="existing" @update:runtime="$emit('update:runtime', $event)" />
    <FieldError :errors="errors" name="runtime" />
    <!-- Read from the repository: no start script, a site builder — a static site. -->
    <p v-if="staticSuggestion && runtime !== 'static'" class="suggest">
      <button type="button" class="secondary small" @click="$emit('use-static')">
        Looks like a static site — use it, publishing <span class="mono">{{ staticSuggestion.publish_dir }}</span>
      </button>
    </p>

    <template v-if="runtime === 'static'">
      <PublishDirField :model-value="publishDir" :errors="errors" @update:model-value="$emit('update:publishDir', $event)" />
      <label class="check-label">
        <input type="checkbox" :checked="spaFallback" @change="$emit('update:spaFallback', $event.target.checked)" />
        Single-page app — answer unknown paths with <span class="mono">index.html</span>
      </label>
      <p class="hint">For client-side routers: a reload on <span class="mono">/about</span> loads the app instead of a 404.</p>
    </template>

    <template v-else>
      <label>Start command <span v-if="!existing" class="soft">(optional — empty for build-only)</span></label>
      <input :value="startCommand" class="code" :placeholder="suggestedStart" @input="$emit('update:startCommand', $event.target.value)" />
      <p v-if="suggestedStart && !startCommand.trim()" class="suggest">
        <button type="button" class="secondary small" @click="$emit('update:startCommand', suggestedStart)">
          Use <span class="mono">{{ suggestedStart }}</span>
        </button>
      </p>
      <FieldError :errors="errors" name="start_command" />

      <template v-if="runtime === 'container'">
        <label>Image</label>
        <ImagePicker
          :model-value="runImage"
          :fallback="buildImage"
          fallback-label="same as build image"
          @update:model-value="$emit('update:runImage', $event)"
        />
        <FieldError :errors="errors" name="run_image" />
      </template>
      <template v-else>
        <label>pm2 process name</label>
        <input :value="pm2Name" class="code" @input="$emit('update:pm2Name', $event.target.value)" />
        <FieldError :errors="errors" name="pm2_name" />
      </template>
    </template>
  </section>

  <template v-if="runtime === 'container'">
    <section class="section-part">
      <h3 class="section-part-title">Resources</h3>
      <label>Memory limit <span class="soft">(MB, blank = unlimited)</span></label>
      <input :value="memoryMb" class="code narrow-input" placeholder="unlimited" @input="$emit('update:memoryMb', $event.target.value)" />
      <FieldError :errors="errors" name="memory_mb" />
      <p class="hint">A hard cap: past it the app is killed and restarted, instead of starving the server.</p>
    </section>

    <section class="section-part">
      <h3 class="section-part-title">Network</h3>
      <div class="row field-row">
        <div style="flex: 1 1 220px">
          <label>Profile</label>
          <select :value="networkProfile" class="code" @change="$emit('update:networkProfile', $event.target.value)">
            <option value="open">open — internet and LAN</option>
            <option value="restricted">restricted — only its shared networks</option>
          </select>
          <FieldError :errors="errors" name="network_profile" />
        </div>
        <div style="flex: 1 1 220px">
          <label>Shared networks <span class="soft">(space-separated)</span></label>
          <input :value="networks" class="code" placeholder="db-net" @input="$emit('update:networks', $event.target.value)" />
          <FieldError :errors="errors" name="networks" />
        </div>
      </div>
      <p v-if="networkProfile === 'restricted'" class="hint">
        No internet, LAN or host — only its shared networks, or a private one of its own. The app port stays routable.
      </p>
      <p class="hint">
        Projects listing the same name reach each other by container name<template v-if="slug"> — this one is
        <span class="mono">skeppa-app-{{ slug }}</span></template><template v-else>, <span class="mono">skeppa-app-&lt;slug&gt;</span></template>.
      </p>
      <label v-if="!tenant && networkProfile === 'open' && !networks.trim()" class="check-label">
        <input type="checkbox" :checked="hostAccess" @change="$emit('update:hostAccess', $event.target.checked)" />
        Host access — reach services on the server's own 127.0.0.1
      </label>
      <FieldError :errors="errors" name="host_access" />
    </section>

    <section class="section-part">
      <h3 class="section-part-title">Storage</h3>
      <!-- What the container sees, a row per path: what it is, and — for an
           admin, who can go and look — where it is on the server. -->
      <dl class="container-paths">
        <div v-for="p in containerPaths" :key="p.path">
          <dt class="mono">{{ p.path }}</dt>
          <dd>{{ p.what }}<template v-if="p.env">, holds <span class="mono">.env</span></template></dd>
          <!-- cut short where it is long, so it is copied whole with the button -->
          <dd v-if="p.host" class="container-path-host" :title="p.title || p.host">
            <span class="mono container-path-text">{{ p.host }}</span>
            <CopyButton :text="p.title || p.host" :label="`Copy ${p.title || p.host}`" />
          </dd>
        </div>
      </dl>
      <!-- Server directories in the container: an admin's to set (the server enforces it). -->
      <template v-if="!tenant">
        <!-- the format only where there is a field to write it in -->
        <label>Host mounts<span v-if="mountable" class="soft"> (one per line — <span class="mono">host:container</span>, <span class="mono">:ro</span> for read-only)</span></label>
        <template v-if="mountable">
          <textarea
            :value="mounts"
            class="code"
            rows="2"
            :placeholder="`${mountRoots[0] || '/mnt/nas'}/media:/media:ro`"
            @input="$emit('update:mounts', $event.target.value)"
          ></textarea>
          <FieldError :errors="errors" name="mounts" />
          <p class="hint">
            Server directories, a network share say.<template v-if="mountRoots.length"> Only from under
            <span class="mono">{{ mountRoots.join(', ') }}</span>.</template><template v-else> Nothing is mountable:
            <span class="mono">MOUNT_ROOTS</span> is not set.</template> Never seen by the deploy script; a tenant cannot change them.
          </p>
        </template>
        <p v-else class="hint">
          Off — set <span class="mono">MOUNT_ROOTS=/mnt/nas</span> in the panel config, and restart the panel, to allow server directories.
        </p>
      </template>
      <p v-else-if="mountList.length" class="hint">The server directories were given to this project by an admin; only an admin can change them.</p>
    </section>
  </template>
</template>

<script>
import ImagePicker from './ImagePicker.vue'
import FieldError from './FieldError.vue'
import RuntimeChoice from './RuntimeChoice.vue'
import PublishDirField from './PublishDirField.vue'
import CopyButton from './CopyButton.vue'
import { shipInject } from '../lib/ship.js'

// The Runtime section's body: the runtime (RuntimeChoice) and what runs —
// the start command and image, the pm2 process name, or a static site's
// publish directory — then, for a container, its resources, network and
// storage. Shared by the mooring form and Rigging (ProjectFields). No
// wrapper element: the parts are siblings in the section, so they keep its
// rhythm and the rule between parts.
export default {
  name: 'RuntimeFields',
  inject: shipInject, // which server (lib/ship.js)
  components: { ImagePicker, FieldError, RuntimeChoice, PublishDirField, CopyButton },
  props: {
    runtime: { type: String, default: 'container' },
    startCommand: { type: String, default: '' },
    // A start command read from the repository, offered as one click.
    suggestedStart: { type: String, default: '' },
    // The repository looks like a static site: { publish_dir }.
    staticSuggestion: { type: Object, default: null },
    // The build image, which the run image falls back to.
    buildImage: { type: String, default: '' },
    runImage: { type: String, default: '' },
    pm2Name: { type: String, default: '' },
    memoryMb: { type: [String, Number], default: '' },
    networkProfile: { type: String, default: 'open' },
    hostAccess: { type: Boolean, default: false },
    networks: { type: String, default: '' },
    // Host directories in the container, as the server stores them (lib/mounts.js).
    mounts: { type: String, default: '' },
    publishDir: { type: String, default: 'dist' },
    spaFallback: { type: Boolean, default: false },
    // Tenant projects never run as a host process and get no host access or
    // mounts of their own — those controls disappear (the server enforces it).
    tenant: { type: Boolean, default: false },
    // Wording differs slightly for a project that already exists.
    existing: { type: Boolean, default: false },
    // Its slug, once it has one: names its container (skeppa-app-<slug>) and its directories.
    slug: { type: String, default: '' },
    // A plaintext .env is written into shared/ — so into /data.
    writeEnvFile: { type: Boolean, default: false },
    // The server's field errors, each shown under its field (FieldError).
    errors: { type: Object, default: () => ({}) },
  },
  emits: ['update:runtime', 'update:startCommand', 'update:runImage', 'update:pm2Name', 'update:memoryMb',
    'update:networkProfile', 'update:hostAccess', 'update:networks', 'update:mounts', 'update:publishDir',
    'update:spaFallback', 'use-static'],
  computed: {
    // Where the panel allows host mounts from (MOUNT_ROOTS) — admins see the panel store.
    mountRoots() {
      const roots = this.ship.live?.system?.mountRoots
      return Array.isArray(roots) ? roots : []
    },
    // A field to write mounts in: the panel allows some, or the project has some to edit.
    mountable() {
      return this.mountRoots.length > 0 || this.mounts.trim() !== ''
    },
    // The lines that read as mounts: { host, target, readOnly } — what is
    // being typed shows as it becomes one.
    mountList() {
      return this.mounts.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const [host = '', target = '', mode = ''] = line.split(':')
        return { host, target, readOnly: mode === 'ro' }
      }).filter(m => m.host.startsWith('/') && m.target.startsWith('/') && m.target !== '/')
    },
    // Every path in the container: { path, what, host?, env? }. The server
    // side only for an admin (the panel store's appsDir) — a tenant can do
    // nothing with it — and the project's directory once it has a slug.
    containerPaths() {
      const appsDir = this.tenant ? '' : (this.ship.live?.system?.appsDir ?? '').replace(/[\\/]+$/, '')
      // Shown from the apps directory's own name down (apps/api/source) — the
      // part that says which project; the whole path is the tooltip.
      const own = sub => {
        if (!appsDir) return {}
        const tail = `${this.slug || '<slug>'}/${sub}`
        const name = appsDir.split(/[\\/]/).pop()
        return { host: name ? `${name}/${tail}` : tail, title: `${appsDir}/${tail}` }
      }
      return [
        { path: '/app', what: 'the source, read-only — replaced on every deploy', ...own('source') },
        { path: '/data', what: 'writable, kept between deploys', ...own('shared'), env: this.writeEnvFile },
        ...this.mountList.map(m => ({
          path: m.target,
          what: `server directory${m.readOnly ? ', read-only' : ''}`,
          host: m.host,
        })),
      ]
    },
  },
}
</script>
