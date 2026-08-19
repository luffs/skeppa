<template>
  <div class="container" v-if="project">
    <router-link to="/" class="mono" style="font-size: 12px; color: var(--dim)">← back to harbor</router-link>
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-top: 12px">
      <div>
        <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap">
          <h1 style="margin: 0">{{ project.name }}</h1>
          <StatusBadge :status="live?.pm2?.status" :href="appUrl" />
        </div>
        <div class="mono" style="color: var(--dim); margin-top: 6px">
          {{ project.repo_full_name }} @ {{ project.branch }}
        </div>
        <div class="mono" v-if="live?.pm2?.status === 'online'" style="font-size: 12px; color: var(--dim); margin-top: 6px">
          pid {{ live.pm2.pid ?? '—' }} · up {{ uptimeSince(live.pm2.uptime) }} ·
          {{ live.pm2.cpu ?? 0 }}% cpu · {{ bytes(live.pm2.memory) }} ·
          {{ live.pm2.restarts ?? 0 }} restart{{ live.pm2.restarts === 1 ? '' : 's' }}
        </div>
      </div>
      <div class="row">
        <button
          class="secondary"
          :disabled="checking"
          title="Ask GitHub for the latest commit on the branch"
          @click="checkHead"
        >
          {{ checking ? 'Checking…' : '↻ Check GitHub' }}
        </button>
        <button class="secondary" :disabled="pm2Busy" @click="pm2('start')">Start</button>
        <button class="secondary" :disabled="pm2Busy" @click="confirmPm2('stop')">Stop</button>
        <button class="secondary" :disabled="pm2Busy" @click="confirmPm2('restart')">Restart</button>
        <button :disabled="!!live?.currentDeployment" @click="deployNow">
          {{ live?.currentDeployment ? 'Under way…' : 'Set sail — deploy' }}
        </button>
      </div>
    </div>

    <div class="ahead-banner" v-if="undeployed">
      <span class="chip amber">commits ahead</span>
      <span class="commit">
        <span class="sha">{{ live.headCommit.sha.slice(0, 7) }}</span>
        {{ live.headCommit.message }} — pushed {{ timeAgo(live.headCommit.pushedAt) }}<template
          v-if="!project.auto_deploy"> · auto deploy is off</template>
      </span>
    </div>
    <p class="hint" v-else-if="checkResult" style="margin-top: 12px">{{ checkResult }}</p>
    <p class="error" v-if="checkError" style="margin-top: 12px">{{ checkError }}</p>

    <div class="tabs">
      <button :class="{ active: tab === 'deploys' }" @click="tab = 'deploys'">Voyages</button>
      <button :class="{ active: tab === 'logs' }" @click="tab = 'logs'">Logbook</button>
      <button :class="{ active: tab === 'env' }" @click="tab = 'env'">Cargo (env)</button>
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">Rigging</button>
    </div>

    <div v-if="tab === 'deploys'">
      <p v-if="!deployments.length" class="hint">
        No voyages yet — press <em>Set sail</em> or push to {{ project.branch }}.
      </p>
      <div v-else class="panel flush">
        <div class="table-scroll capped">
          <table style="min-width: 640px">
            <thead>
              <tr><th>Voyage</th><th>Status</th><th>Trigger</th><th>Commit</th><th>Departed</th><th>Passage</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="d in deployments"
                :key="d.id"
                class="deploy-row"
                :class="{ selected: d.id === selectedId }"
                @click="selectedId = d.id"
              >
                <td class="mono">#{{ d.id }}</td>
                <td><StatusBadge :status="liveStatusFor(d)" /></td>
                <td class="hint" style="font-size: 14px">{{ d.trigger }}</td>
                <td>
                  <span class="mono">{{ d.commit_sha ? d.commit_sha.slice(0, 7) : '—' }}</span>
                  <span class="hint" style="margin-left: 6px">{{ d.commit_message }}</span>
                </td>
                <td class="hint" style="font-size: 14px">{{ timeAgo(d.started_at || d.created_at) }}</td>
                <td class="mono" style="color: var(--dim)">{{ duration(d.started_at, d.finished_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div style="margin-top: 20px" v-if="selectedId">
        <DeployLog :deployment-id="selectedId" :active="selectedId === live?.currentDeployment?.id" />
      </div>
    </div>

    <div v-else-if="tab === 'logs'" class="panel">
      <Pm2Logs :url="`/api/projects/${project.id}/logs`" :name="project.pm2_name" />
    </div>

    <div v-else-if="tab === 'env'" class="panel">
      <EnvEditor :project-id="project.id" />
    </div>

    <div v-else-if="tab === 'settings'" class="panel" style="max-width: 680px">
      <label>Name</label>
      <input v-model="edit.name" />
      <label>Repository (owner/repo)</label>
      <input v-model="edit.repo_full_name" class="code" />
      <label>Branch</label>
      <input v-model="edit.branch" class="code" />
      <label class="check-label">
        <input type="checkbox" v-model="edit.auto_deploy" />
        Auto deploy on push to {{ edit.branch || project.branch }}
      </label>
      <p class="hint">When off, pushes only show up as "commits ahead" — deploy manually.</p>
      <label>Deploy script</label>
      <textarea v-model="edit.deploy_script" class="code" rows="4"></textarea>
      <p class="hint">⚠ Runs as a shell script on the server — only trusted commands.</p>
      <label>Build image</label>
      <input v-model="edit.build_image" class="code" list="skeppa-images" placeholder="panel default" />
      <p class="hint">
        OCI image the deploy script runs in when the podman build sandbox is enabled
        (<span class="mono">SKEPPA_SANDBOX=podman</span>). Empty = panel default. Ignored in host mode.
        Managed images from the Shipyard are suggested.
      </p>
      <datalist id="skeppa-images">
        <option v-for="ref in imageRefs" :key="ref" :value="ref" />
      </datalist>
      <label>Start command</label>
      <input v-model="edit.start_command" class="code" />
      <label>Runtime</label>
      <select v-model="edit.runtime" class="code">
        <option value="pm2">pm2 — host process</option>
        <option value="container">container — rootless podman</option>
      </select>
      <p class="hint" v-if="edit.runtime === 'container'">
        The start command runs in a disposable container: source read-only at
        <span class="mono">/app</span>, <span class="mono">shared/</span> writable at
        <span class="mono">/data</span>, the app port published on localhost. Takes effect on the
        next deploy or restart.
      </p>
      <template v-if="edit.runtime === 'container'">
        <label>Run image</label>
        <input v-model="edit.run_image" class="code" list="skeppa-images" placeholder="same as build image" />
      </template>
      <label>pm2 process name</label>
      <input v-model="edit.pm2_name" class="code" />
      <label>Working subdirectory</label>
      <input v-model="edit.cwd" class="code" />
      <label class="check-label">
        <input type="checkbox" v-model="edit.write_env_file" />
        Write a plaintext <span class="mono">.env</span> file into the app
      </label>
      <p class="hint">
        ENV vars are always injected into the deploy script and the pm2 process — decrypted only in
        memory. Turn this on only if something reads <span class="mono">.env</span> from disk itself
        (e.g. Vite at build time); it writes <span class="mono">shared/.env</span> plus a copy in
        the working directory. Turning it off deletes those files.
      </p>
      <div class="row">
        <div style="flex: 1 1 160px">
          <label>Subdomain</label>
          <input v-model="edit.subdomain" class="code" placeholder="myapp" />
        </div>
        <div style="flex: 1 1 120px">
          <label>App port</label>
          <input v-model="edit.port" class="code" placeholder="4001" />
        </div>
      </div>
      <p class="hint" v-if="routedUrl">
        Routed: <a :href="routedUrl" target="_blank" rel="noopener" class="mono" style="font-size: 12.5px">{{ routedUrl }}</a>
        → localhost:{{ edit.port }} · the app gets <span class="mono" style="font-size: 12px">PORT={{ edit.port }}</span>
      </p>
      <p class="hint" v-else-if="edit.subdomain && gate && !gate.base_domain">
        Set a base domain under Rigging → Harbor gate to route this subdomain.
      </p>
      <p class="hint" v-else>
        Optional: route <span class="mono" style="font-size: 12px">subdomain.&lt;base domain&gt;</span>
        to this app through the harbor gate proxy.
      </p>
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <p v-if="saved" class="hint">Saved ✔</p>
      <div class="row" style="margin-top: 22px; justify-content: space-between">
        <button :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save settings' }}</button>
        <button class="danger" @click="remove">Scuttle project</button>
      </div>

      <div style="margin-top: 24px; border-top: 1px solid var(--line); padding-top: 16px">
        <h2 style="margin: 0 0 8px">Clone manually</h2>
        <p class="hint">
          Generates a git clone command with a short-lived GitHub App installation token, to run on
          another server. The token expires after about an hour, grants access to every repo the app
          is installed on, and ends up in the clone's <span class="mono">.git/config</span> — after
          cloning, reset the remote with
          <span class="mono">git remote set-url origin https://github.com/{{ project.repo_full_name }}.git</span>.
        </p>
        <button class="secondary" :disabled="tokenBusy" @click="getCloneCommand">
          {{ tokenBusy ? 'Fetching token…' : 'Get clone command' }}
        </button>
        <p v-if="tokenError" class="error">{{ tokenError }}</p>
        <template v-if="cloneCommand">
          <textarea
            class="code"
            readonly
            rows="3"
            style="margin-top: 12px"
            :value="cloneCommand"
            @focus="$event.target.select()"
          ></textarea>
          <div class="row" style="margin-top: 8px; justify-content: space-between">
            <button class="secondary small" @click="copyCloneCommand">
              {{ copiedCommand ? 'Copied ✔' : 'Copy' }}
            </button>
            <span class="hint" v-if="cloneExpiresIn">token expires {{ cloneExpiresIn }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import DeployLog from '../components/DeployLog.vue'
import EnvEditor from '../components/EnvEditor.vue'
import Pm2Logs from '../components/Pm2Logs.vue'
import { api } from '../api.js'
import { store, liveProject, loadGate, appUrlFor } from '../store.js'
import { timeAgo, duration, uptimeSince, bytes } from '../lib/format.js'

export default {
  name: 'ProjectView',
  components: { StatusBadge, DeployLog, EnvEditor, Pm2Logs },
  props: { id: { type: String, required: true } },
  data() {
    return {
      deployments: [],
      editLoaded: false,
      tab: 'deploys',
      selectedId: null,
      edit: {},
      saving: false,
      saveError: '',
      saved: false,
      pm2Busy: false,
      checking: false,
      checkResult: '',
      checkError: '',
      tokenBusy: false,
      tokenError: '',
      cloneCommand: '',
      cloneExpiresAt: null,
      copiedCommand: false,
      imageRefs: [],
    }
  },
  computed: {
    live() {
      return liveProject(Number(this.id))
    },
    gate() {
      return store.gate
    },
    // The saved routing (what is actually live), unlike routedUrl below which
    // previews whatever is currently typed in the settings form.
    appUrl() {
      return appUrlFor(this.project)
    },
    // The project row comes from LiveState, so the view renders instantly on
    // navigation and follows edits made in any session.
    project() {
      return this.live?.info ?? null
    },
    undeployed() {
      const live = this.live
      return !!live?.headCommit?.sha &&
        !live.currentDeployment &&
        live.headCommit.sha !== live.deployedSha
    },
    currentDeploymentId() {
      return this.live?.currentDeployment?.id ?? null
    },
    cloneExpiresIn() {
      if (!this.cloneExpiresAt) return ''
      const min = Math.round((this.cloneExpiresAt - Date.now()) / 60000)
      return min > 0 ? `in ~${min} min` : 'soon — fetch a fresh one'
    },
    routedUrl() {
      if (!this.edit.subdomain || !this.edit.port || !this.gate?.base_domain) return ''
      return `https://${this.edit.subdomain}.${this.gate.base_domain}`
    },
  },
  watch: {
    // A deploy starting or finishing changes the list — refresh it.
    currentDeploymentId(now, before) {
      this.loadDeployments()
      if (now) this.selectedId = now
      else if (before && this.selectedId === before) this.selectedId = before // keep showing the finished log
    },
    // Seed the settings form once the project info is available (immediately
    // when the snapshot is already in the store, or as soon as it arrives).
    project: {
      immediate: true,
      handler(p) {
        if (p && !this.editLoaded) {
          this.edit = this.editable(p)
          this.editLoaded = true
        }
      },
    },
  },
  async created() {
    await this.loadDeployments()
    this.selectedId = this.currentDeploymentId ?? this.deployments[0]?.id ?? null
    loadGate()
    // Shipyard images as datalist suggestions for the image fields.
    api.get('/api/images')
      .then(d => {
        this.imageRefs = [...new Set([...d.managed.map(m => m.ref), d.default_image].filter(Boolean))]
      })
      .catch(() => {})
  },
  methods: {
    timeAgo,
    duration,
    uptimeSince,
    bytes,
    async loadDeployments() {
      this.deployments = await api.get(`/api/projects/${this.id}/deployments`)
    },
    liveStatusFor(d) {
      if (d.id === this.currentDeploymentId) return this.live.currentDeployment.status
      if (d.id === this.live?.lastDeployment?.id) return this.live.lastDeployment.status
      return d.status
    },
    async checkHead() {
      this.checking = true
      this.checkResult = ''
      this.checkError = ''
      try {
        const head = await api.post(`/api/projects/${this.id}/refresh-head`)
        // If there are new commits, the badge appears via the LiveState diff;
        // only "nothing new" needs saying out loud.
        if (head.sha && head.sha === this.live?.deployedSha) {
          this.checkResult = `Up to date — ${head.sha.slice(0, 7)} is deployed ✔`
        } else if (!head.sha) {
          this.checkError = 'GitHub returned no commit for this branch'
        }
      } catch (err) {
        this.checkError = `GitHub check failed: ${err.message}`
      } finally {
        this.checking = false
      }
    },
    async getCloneCommand() {
      this.tokenBusy = true
      this.tokenError = ''
      this.copiedCommand = false
      try {
        const { command, expiresAt } = await api.post(`/api/projects/${this.id}/clone-command`)
        this.cloneCommand = command
        this.cloneExpiresAt = expiresAt
      } catch (err) {
        this.tokenError = `Could not get a token: ${err.message}`
      } finally {
        this.tokenBusy = false
      }
    },
    async copyCloneCommand() {
      try {
        await navigator.clipboard.writeText(this.cloneCommand)
        this.copiedCommand = true
        setTimeout(() => (this.copiedCommand = false), 2000)
      } catch {
        // Clipboard API unavailable (http, permissions) — the textarea
        // selects itself on focus, so manual copy still works.
        this.tokenError = 'Clipboard unavailable — select the command and copy it manually'
      }
    },
    async deployNow() {
      const { id } = await api.post(`/api/projects/${this.id}/deploy`)
      this.selectedId = id
      await this.loadDeployments()
    },
    confirmPm2(action) {
      if (confirm(`Really ${action} "${this.project.pm2_name}"?`)) this.pm2(action)
    },
    async pm2(action) {
      this.pm2Busy = true
      try {
        await api.post(`/api/projects/${this.id}/pm2/${action}`)
      } catch (err) {
        alert(`pm2 ${action} failed: ${err.message}`)
      } finally {
        this.pm2Busy = false
      }
    },
    editable(p) {
      return {
        ...p,
        cwd: p.cwd ?? '',
        build_image: p.build_image ?? '',
        run_image: p.run_image ?? '',
        runtime: p.runtime ?? 'pm2',
        auto_deploy: !!p.auto_deploy,
        write_env_file: !!p.write_env_file,
        subdomain: p.subdomain ?? '',
        port: p.port ?? '',
      }
    },
    async save() {
      this.saving = true
      this.saveError = ''
      this.saved = false
      try {
        const updated = await api.patch(`/api/projects/${this.id}`, {
          ...this.edit,
          cwd: this.edit.cwd || null,
          build_image: this.edit.build_image || null,
          run_image: this.edit.run_image || null,
          subdomain: this.edit.subdomain || null,
          port: this.edit.port === '' ? null : Number(this.edit.port),
        })
        // LiveState carries the update to `project`; re-seed the form with the
        // server-normalized values.
        this.edit = this.editable(updated)
        this.saved = true
      } catch (err) {
        const fields = err.fields ? ' — ' + Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join(', ') : ''
        this.saveError = err.message + fields
      } finally {
        this.saving = false
      }
    },
    async remove() {
      if (!confirm(`Delete project "${this.project.name}"? The pm2 process is removed; files on disk are kept.`)) return
      await api.del(`/api/projects/${this.id}`)
      this.$router.push('/')
    },
  },
}
</script>
