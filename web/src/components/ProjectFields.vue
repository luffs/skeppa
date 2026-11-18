<template>
  <!-- The project's settings, in the same sections and the same order when
       mooring and in Rigging, so what is set up front is what is found later.
       Every edit goes up as `set` (key, value); the parent owns the form. -->
  <div class="project-fields">
    <CollapseSection title="Source" start-open :reveal="hasErrors(SOURCE)">
      <template #meta><span class="mono">{{ form.branch || 'main' }}</span></template>
      <!-- How the repository is chosen differs: a picker when mooring, the
           stored reference in Rigging. -->
      <slot name="source">
        <template v-if="external">
          <label>Git URL</label>
          <input :value="form.git_url" @input="set('git_url', $event.target.value)" class="code" />
          <FieldError :errors="shown" name="git_url" />
          <p class="hint">External repository — no webhook; use the ↻ Check remote button up top to look for new commits.</p>
        </template>
        <template v-else>
          <label>Repository (owner/repo)</label>
          <input :value="form.repo_full_name" @input="set('repo_full_name', $event.target.value)" class="code" />
          <FieldError :errors="shown" name="repo_full_name" />
        </template>
      </slot>
      <label>Branch</label>
      <input :value="form.branch" @input="set('branch', $event.target.value)" class="code" placeholder="main" />
      <FieldError :errors="shown" name="branch" />
      <template v-if="!external">
        <label class="check-label">
          <input type="checkbox" :checked="form.auto_deploy" @change="set('auto_deploy', $event.target.checked)" />
          Auto deploy on push to {{ form.branch || 'main' }}
        </label>
        <p class="hint">When off, pushes only show up as "commits ahead" — deploy manually.</p>
      </template>
      <label>Name</label>
      <input :value="form.name" placeholder="My app" @input="set('name', $event.target.value); $emit('name-input')" />
      <FieldError :errors="shown" name="name" />
      <FieldError :errors="shown" name="slug" />
      <PierPicker :model-value="form.group_id" :owner-id="ownerId" @update:model-value="set('group_id', $event)" />
      <FieldError :errors="shown" name="group_id" />
    </CollapseSection>

    <CollapseSection title="Runtime" start-open :reveal="hasErrors(RUNTIME)">
      <template #meta><span class="mono">{{ RUNTIME_NAME[form.runtime] ?? form.runtime }}</span></template>
      <RuntimeChoice :runtime="form.runtime" :tenant="tenant" :existing="existing" @update:runtime="pickRuntime" />
      <FieldError :errors="shown" name="runtime" />
      <!-- Read from the repository: no start script, a site builder — a static site. -->
      <p v-if="suggestion?.runtime === 'static' && form.runtime !== 'static'" class="suggest">
        <button type="button" class="secondary small" @click="useStatic">
          Looks like a static site — use it, publishing <span class="mono">{{ suggestion.publish_dir }}</span>
        </button>
      </p>
      <template v-if="form.runtime !== 'static'">
        <label>Start command <span v-if="!existing" class="soft">(optional — empty for build-only)</span></label>
        <input :value="form.start_command" @input="set('start_command', $event.target.value)" class="code" :placeholder="suggested?.start || ''" />
        <p v-if="suggested?.start && !form.start_command.trim()" class="suggest">
          <button type="button" class="secondary small" @click="set('start_command', suggested.start)">
            Use <span class="mono">{{ suggested.start }}</span>
          </button>
        </p>
        <FieldError :errors="shown" name="start_command" />
      </template>
      <RuntimeFields
        :runtime="form.runtime"
        :build-image="form.build_image" @update:build-image="set('build_image', $event)"
        :run-image="form.run_image" @update:run-image="set('run_image', $event)"
        :pm2-name="form.pm2_name" @update:pm2-name="set('pm2_name', $event)"
        :memory-mb="form.memory_mb" @update:memory-mb="set('memory_mb', $event)"
        :network-profile="form.network_profile" @update:network-profile="set('network_profile', $event)"
        :host-access="form.host_access" @update:host-access="set('host_access', $event)"
        :networks="form.networks" @update:networks="set('networks', $event)"
        :publish-dir="form.publish_dir" @update:publish-dir="set('publish_dir', $event)"
        :spa-fallback="form.spa_fallback" @update:spa-fallback="set('spa_fallback', $event)"
        :gate-files="form.gate_files" @update:gate-files="set('gate_files', $event)"
        :tenant="tenant"
        :existing="existing"
        :errors="shown"
      />
    </CollapseSection>

    <CollapseSection title="Build" start-open :reveal="hasErrors(BUILD)">
      <template #meta><span class="mono">{{ form.build_env ? 'ENV in the build' : 'no ENV in the build' }}</span></template>
      <p v-if="suggestion?.notes?.length" class="hint repo-read">
        Read from the repository: {{ suggestion.notes.join(' · ') }}
      </p>
      <label>Deploy script</label>
      <textarea :value="form.deploy_script" @input="set('deploy_script', $event.target.value)" class="code" rows="4" :placeholder="suggested?.deploy || ''"></textarea>
      <!-- The placeholder is a suggestion, not a default: nothing runs that was
           not chosen. One click makes it the value. -->
      <p v-if="suggested?.deploy && !form.deploy_script.trim()" class="suggest">
        <button type="button" class="secondary small" @click="set('deploy_script', suggested.deploy)">
          Use <span class="mono">{{ suggested.deploy }}</span>
        </button>
      </p>
      <FieldError :errors="shown" name="deploy_script" />
      <p class="hint">⚠ Runs as a shell script on the server — only trusted commands.</p>
      <label>Working subdirectory <span class="soft">(optional, relative to the repository root)</span></label>
      <input :value="form.cwd" @input="set('cwd', $event.target.value)" class="code" placeholder="apps/api" />
      <FieldError :errors="shown" name="cwd" />
      <label class="check-label">
        <input type="checkbox" :checked="form.build_env" @change="set('build_env', $event.target.checked)" />
        Inject ENV into the deploy script
      </label>
      <p class="hint">
        On, the build sees every ENV var — needed for generated clients, <span class="mono">VITE_*</span>
        config or private registries. Off, it gets only a minimal environment and no
        <span class="mono">.env</span> in the working tree, so a poisoned dependency's postinstall has
        nothing to take. The running app gets its ENV either way.
      </p>
      <label class="check-label">
        <input type="checkbox" :checked="form.write_env_file" @change="set('write_env_file', $event.target.checked)" />
        Write a plaintext <span class="mono">.env</span> file into the app
      </label>
      <p class="hint">
        ENV vars are injected into the running process (and, with the toggle above on, the deploy script) — decrypted only in
        memory. Turn this on only if something reads <span class="mono">.env</span> from disk itself
        (e.g. Vite at build time); it writes <span class="mono">shared/.env</span> plus a copy in
        the working directory. Turning it off deletes those files.
      </p>
    </CollapseSection>

    <CollapseSection title="Routing" start-open :reveal="hasErrors(ROUTING)">
      <template #meta><span class="mono">{{ routeLabel || 'not routed' }}</span></template>
      <RoutingFields
        :subdomain="form.subdomain" @update:subdomain="set('subdomain', $event)"
        :port="form.port" @update:port="set('port', $event)"
        :handle="handle"
        :domain="domain"
        :static-site="form.runtime === 'static'"
        :gate-files="form.runtime !== 'static' && form.gate_files"
        :existing="existing"
        :errors="shown"
      />
    </CollapseSection>

    <!-- Anything the server said about a field no section shows. -->
    <p v-for="(message, key) in otherErrors" :key="key" class="field-error">{{ key }}: {{ message }}</p>
  </div>
</template>

<script>
import CollapseSection from './CollapseSection.vue'
import FieldError from './FieldError.vue'
import PierPicker from './PierPicker.vue'
import RuntimeChoice from './RuntimeChoice.vue'
import RuntimeFields from './RuntimeFields.vue'
import RoutingFields from './RoutingFields.vue'

// Which section shows which field's error — and opens for it.
const SOURCE = ['repo_full_name', 'git_url', 'branch', 'name', 'slug', 'group_id']
const RUNTIME = ['runtime', 'start_command', 'build_image', 'run_image', 'pm2_name', 'memory_mb', 'network_profile', 'networks', 'host_access', 'publish_dir']
const BUILD = ['deploy_script', 'cwd']
const ROUTING = ['subdomain', 'port']
const KNOWN = new Set([...SOURCE, ...RUNTIME, ...BUILD, ...ROUTING])
const RUNTIME_NAME = { pm2: 'pm2 process', container: 'container', static: 'static site' }

// One project's settings, as the mooring form and Rigging both show them.
// Errors are the server's `fields` map; each one shows under its field until
// that field is edited, and a folded section holding one opens.
export default {
  name: 'ProjectFields',
  components: { CollapseSection, FieldError, PierPicker, RuntimeChoice, RuntimeFields, RoutingFields },
  props: {
    form: { type: Object, required: true },
    // Rigging (an existing project) rather than the mooring form.
    existing: { type: Boolean, default: false },
    // A plain git URL rather than a GitHub repository.
    external: { type: Boolean, default: false },
    tenant: { type: Boolean, default: false },
    ownerId: { type: Number, default: null },
    // The owner's routing namespace (tenants): their handle or own domain.
    handle: { type: String, default: '' },
    domain: { type: String, default: '' },
    // The Routing section's summary while folded.
    routeLabel: { type: String, default: '' },
    errors: { type: Object, default: () => ({}) },
    // One-click values: { deploy, start }.
    suggested: { type: Object, default: null },
    // What was read from the repository: { notes, runtime?, publish_dir? }.
    suggestion: { type: Object, default: null },
  },
  // `set` (key, value) is every edit: the parent owns the form and applies it.
  emits: ['set', 'runtime', 'name-input'],
  data() {
    return { SOURCE, RUNTIME, BUILD, ROUTING, RUNTIME_NAME, errorValues: {} }
  },
  computed: {
    // The errors whose field still holds what the server refused.
    shown() {
      const out = {}
      for (const [key, message] of Object.entries(this.errors ?? {})) {
        if (!(key in this.errorValues) || String(this.form[key] ?? '') === this.errorValues[key]) out[key] = message
      }
      return out
    },
    otherErrors() {
      return Object.fromEntries(Object.entries(this.shown).filter(([key]) => !KNOWN.has(key)))
    },
  },
  watch: {
    // A new set of errors: remember what each field held when it was refused.
    errors: {
      immediate: true,
      handler(errors) {
        this.errorValues = Object.fromEntries(Object.keys(errors ?? {}).map(k => [k, String(this.form[k] ?? '')]))
      },
    },
  },
  methods: {
    hasErrors(keys) {
      return keys.some(k => k in this.shown)
    },
    set(key, value) {
      this.$emit('set', key, value)
    },
    pickRuntime(runtime) {
      this.set('runtime', runtime)
      this.$emit('runtime', runtime)
    },
    useStatic() {
      this.pickRuntime('static')
      this.set('publish_dir', this.suggestion.publish_dir)
    },
    // After a refused save: the first error into view, its section open.
    revealErrors() {
      this.$nextTick(() => this.$el.querySelector?.('.field-error')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }))
    },
  },
}
</script>
