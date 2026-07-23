<template>
  <div class="container" v-if="project">
    <div class="row" style="justify-content: space-between">
      <div>
        <h1 style="margin-bottom: 4px">{{ project.name }}</h1>
        <span class="hint mono">{{ project.repo_full_name }} @ {{ project.branch }}</span>
        <div class="hint" v-if="live?.pm2?.status === 'online'" style="margin-top: 4px">
          pid {{ live.pm2.pid ?? '—' }} · up {{ uptimeSince(live.pm2.uptime) }} ·
          {{ live.pm2.cpu ?? 0 }}% cpu · {{ bytes(live.pm2.memory) }} ·
          {{ live.pm2.restarts ?? 0 }} restart{{ live.pm2.restarts === 1 ? '' : 's' }}
        </div>
      </div>
      <div class="row">
        <StatusBadge :status="live?.pm2?.status" />
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
          {{ live?.currentDeployment ? 'Deploying…' : '🚀 Deploy' }}
        </button>
      </div>
    </div>

    <div class="row" style="margin-top: 12px" v-if="undeployed">
      <span class="badge yellow">undeployed commits</span>
      <span class="hint">
        <span class="mono">{{ live.headCommit.sha.slice(0, 7) }}</span>
        {{ live.headCommit.message }} — pushed {{ timeAgo(live.headCommit.pushedAt) }}<template
          v-if="!project.auto_deploy"> · auto deploy is off</template>
      </span>
    </div>
    <p class="hint" v-else-if="checkResult" style="margin-top: 12px">{{ checkResult }}</p>
    <p class="error" v-if="checkError" style="margin-top: 12px">{{ checkError }}</p>

    <div class="tabs">
      <button :class="{ active: tab === 'deploys' }" @click="tab = 'deploys'">Deployments</button>
      <button :class="{ active: tab === 'env' }" @click="tab = 'env'">Environment</button>
      <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">Settings</button>
    </div>

    <div v-if="tab === 'deploys'">
      <p v-if="!deployments.length" class="hint">No deployments yet — press Deploy or push to {{ project.branch }}.</p>
      <table v-else>
        <thead>
          <tr><th>#</th><th>Status</th><th>Trigger</th><th>Commit</th><th>Started</th><th>Duration</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="d in deployments"
            :key="d.id"
            class="deploy-row"
            :class="{ selected: d.id === selectedId }"
            @click="selectedId = d.id"
          >
            <td>{{ d.id }}</td>
            <td><StatusBadge :status="liveStatusFor(d)" /></td>
            <td>{{ d.trigger }}</td>
            <td class="mono">
              {{ d.commit_sha ? d.commit_sha.slice(0, 7) : '—' }}
              <span class="hint">{{ d.commit_message }}</span>
            </td>
            <td class="hint">{{ timeAgo(d.started_at || d.created_at) }}</td>
            <td class="hint">{{ duration(d.started_at, d.finished_at) }}</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top: 16px" v-if="selectedId">
        <DeployLog :deployment-id="selectedId" :active="selectedId === live?.currentDeployment?.id" />
      </div>
    </div>

    <div v-else-if="tab === 'env'" class="panel">
      <EnvEditor :project-id="project.id" />
    </div>

    <div v-else-if="tab === 'settings'" class="panel">
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
      <p class="hint">When off, pushes only show up as "undeployed commits" — deploy manually.</p>
      <label>Deploy script</label>
      <textarea v-model="edit.deploy_script" class="code" rows="4"></textarea>
      <p class="hint">⚠ Runs as a shell script on the server — only trusted commands.</p>
      <label>Start command</label>
      <input v-model="edit.start_command" class="code" />
      <label>pm2 process name</label>
      <input v-model="edit.pm2_name" class="code" />
      <label>Working subdirectory</label>
      <input v-model="edit.cwd" class="code" />
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <p v-if="saved" class="hint">Saved ✔</p>
      <div class="row" style="margin-top: 12px; justify-content: space-between">
        <button :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save settings' }}</button>
        <button class="danger" @click="remove">Delete project</button>
      </div>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import DeployLog from '../components/DeployLog.vue'
import EnvEditor from '../components/EnvEditor.vue'
import { api } from '../api.js'
import { liveProject } from '../store.js'
import { timeAgo, duration, uptimeSince, bytes } from '../lib/format.js'

export default {
  name: 'ProjectView',
  components: { StatusBadge, DeployLog, EnvEditor },
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
    }
  },
  computed: {
    live() {
      return liveProject(Number(this.id))
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
          this.edit = { ...p, cwd: p.cwd ?? '', auto_deploy: !!p.auto_deploy }
          this.editLoaded = true
        }
      },
    },
  },
  async created() {
    await this.loadDeployments()
    this.selectedId = this.currentDeploymentId ?? this.deployments[0]?.id ?? null
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
    async save() {
      this.saving = true
      this.saveError = ''
      this.saved = false
      try {
        const updated = await api.patch(`/api/projects/${this.id}`, {
          ...this.edit,
          cwd: this.edit.cwd || null,
        })
        // LiveState carries the update to `project`; re-seed the form with the
        // server-normalized values.
        this.edit = { ...updated, cwd: updated.cwd ?? '', auto_deploy: !!updated.auto_deploy }
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
