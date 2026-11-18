<template>
  <div class="container" v-if="project">
    <router-link to="/" class="mono" style="font-size: 12px; color: var(--dim)">← back to harbor</router-link>
    <div class="project-head">
      <div class="project-title">
        <div class="project-title-line">
          <h1 style="margin: 0">{{ project.name }}</h1>
          <StatusBadge :status="statusWord" />
          <!-- Where it is listed in the harbor; the pier is changed in Rigging, so that is where it leads. -->
          <button
            v-if="pierName"
            type="button"
            class="chip pier-chip"
            title="Moored at this pier in the harbor — change it under Rigging"
            @click="setTab('settings')"
          >
            <span class="pier-chip-label">pier</span>{{ pierName }}
          </button>
        </div>
        <!-- Where it comes from and where it is served, both one click away. -->
        <div class="project-where">
          <a v-if="repoHref" :href="repoHref" target="_blank" rel="noopener" class="repo-link" :title="repoTitle">
            {{ repoLabel }} @ {{ project.branch }}
          </a>
          <span v-else class="repo-link" :title="repoTitle">{{ repoLabel }} @ {{ project.branch }}</span>
          <a v-if="appUrl" :href="appUrl" target="_blank" rel="noopener" class="vessel-addr">{{ appHost }}<span aria-hidden="true"> ↗</span></a>
        </div>
        <div class="mono" v-if="live?.pm2?.status === 'online'" style="font-size: 12px; color: var(--dim); margin-top: 6px">
          pid {{ live.pm2.pid ?? '—' }} · up {{ uptimeSince(live.pm2.uptime) }} ·
          {{ live.pm2.cpu ?? 0 }}% cpu · {{ bytes(live.pm2.memory) }} ·
          {{ live.pm2.restarts ?? 0 }} {{ restartNoun }}
        </div>
      </div>
      <div class="row">
        <!-- Until the code is on the server, the first thing to do is to get it
             there — without a deploy, so it can be read under Freight first.
             One button either way, labelled for both, so it never resizes. -->
        <button
          class="secondary"
          :disabled="checking || (needsClone && !!live?.currentDeployment)"
          :title="needsClone
            ? 'Fetch the code onto the server without deploying it — then read it under Freight'
            : 'Ask the remote for the latest commit on the branch'"
          @click="needsClone ? cloneNow() : checkHead()"
        >
          <StableLabel :text="headLabel" :variants="headLabels" />
        </button>
        <!-- The same action the harbor row offers, and the rest in ⋮ (lib/vesselActions.js). -->
        <button :disabled="busy || primary.disabled" @click="run(primary.key)">
          <StableLabel :text="primary.label" :variants="PRIMARY_LABELS" />
        </button>
        <ActionMenu label="Project actions" :items="menu" @select="run" />
      </div>
    </div>

    <p class="hint" v-if="pendingRuntime" style="margin-top: 12px">
      Runtime change pending: still served as {{ runtimeLabel(liveRuntime) }}. It becomes
      {{ pendingRuntime }} on the next successful deploy — until then nothing moves.
    </p>
    <div class="ahead-banner" v-if="undeployed">
      <span class="chip amber">commits ahead</span>
      <span class="commit">
        <span class="sha">{{ live.headCommit.sha.slice(0, 7) }}</span>{{ ' ' }}
        <span :title="live.headCommit.message">{{ brief(live.headCommit.message) }}</span><template v-if="live.headCommit.pushedAt"> — pushed
        {{ timeAgo(live.headCommit.pushedAt) }}</template><template
          v-if="!project.auto_deploy && !project.git_url"> · auto deploy is off</template>
      </span>
    </div>
    <p class="hint" v-else-if="checkResult" style="margin-top: 12px">{{ checkResult }}</p>
    <p class="hint" v-if="cloneResult" style="margin-top: 12px">{{ cloneResult }}</p>
    <p class="error" v-if="checkError" style="margin-top: 12px">{{ checkError }}</p>

    <div class="tabs">
      <button :class="{ active: tab === 'deploys' }" @click="setTab('deploys')">Voyages</button>
      <button v-if="!isStatic" :class="{ active: tab === 'logs' }" @click="setTab('logs')">Logbook</button>
      <button :class="{ active: tab === 'env' }" @click="setTab('env')">Manifest (env)</button>
      <button :class="{ active: tab === 'files' }" @click="setTab('files')">Freight (files)</button>
      <button :class="{ active: tab === 'settings' }" @click="setTab('settings')">
        Rigging<span v-if="dirtyFields.length" class="tab-dirty" title="Unsaved changes"> •</span>
      </button>
    </div>

    <div v-if="tab === 'deploys'">
      <p v-if="!deployments.length" class="hint">
        No voyages yet — press <em>Set sail</em> or push to {{ project.branch }}.
      </p>
      <div v-else class="panel flush">
        <div class="table-scroll capped">
          <table class="voyages">
            <thead>
              <tr><th>Voyage</th><th>Status</th><th>Trigger</th><th>Commit</th><th>Departed</th><th>Passage</th><th></th></tr>
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
                <td class="commit-cell">
                  <CommitMessage :sha="d.commit_sha ?? ''" :message="d.commit_message ?? ''" />
                </td>
                <td class="hint" style="font-size: 14px">{{ timeAgo(d.started_at || d.created_at) }}</td>
                <td class="mono" style="color: var(--dim)">{{ duration(d.started_at, d.finished_at) }}</td>
                <td class="voyage-actions">
                  <!-- Back to a commit that worked: the quickest way out of a bad release. -->
                  <button
                    v-if="canRedeploy(d)"
                    type="button"
                    class="small secondary"
                    :disabled="busy || !!live?.currentDeployment"
                    :title="`Deploy ${d.commit_sha.slice(0, 7)} again`"
                    @click.stop="redeploy(d)"
                  >Redeploy</button>
                  <span v-else-if="d.commit_sha && d.commit_sha === live?.deployedSha && liveStatusFor(d) === 'success'" class="hint voyage-current">deployed</span>
                </td>
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
      <Pm2Logs
        :url="`/api/projects/${project.id}/logs`"
        :name="project.pm2_name"
        :prev-url="project.runtime === 'container' ? `/api/projects/${project.id}/logs/previous` : ''"
      />
    </div>

    <div v-else-if="tab === 'env'" class="panel">
      <EnvEditor :project-id="project.id" />
    </div>

    <div v-else-if="tab === 'files'">
      <!-- Remounted when a checkout appears, so a Clone shows up here at once. -->
      <SourceFiles :key="String(live?.checkedOut)" :project-id="project.id" />
    </div>

    <!-- Rigging: one form in sections, saved together. v-show inside the
         sections keeps half-typed fields when one is folded. -->
    <div v-else-if="tab === 'settings'" class="rigging">
      <ProjectFields
        ref="fields"
        :form="edit"
        existing
        :external="Boolean(project.git_url)"
        :tenant="isTenant"
        :owner-id="project.owner_id"
        :handle="project.owner_role === 'tenant' ? project.owner_handle : ''"
        :domain="project.owner_role === 'tenant' ? project.owner_domain : ''"
        :route-label="appHost"
        :errors="fieldErrors"
        @set="(key, value) => (edit[key] = value)"
      />

      <p v-if="saveError" class="error">{{ saveError }}</p>
      <p v-if="saved && !dirtyFields.length" class="hint" style="margin: 0">Saved ✔</p>

      <!-- Only while something is unsaved, and always in reach at the bottom of
           the screen. Most settings only take effect when the project next sets
           sail: then saving and deploying is one click. -->
      <div v-if="dirtyFields.length" class="save-bar">
        <span>
          {{ dirtyFields.length }} unsaved change{{ dirtyFields.length === 1 ? '' : 's' }}<template v-if="deployFields.length">
            <span class="save-bar-note"> · {{ deployFields.length === dirtyFields.length ? (dirtyFields.length === 1 ? 'takes' : 'take') : `${deployFields.length} take` }} effect on the next deploy</span></template>
        </span>
        <span class="spacer"></span>
        <button type="button" class="small secondary" :disabled="!!saving" @click="discard">Discard</button>
        <button type="button" class="small" :class="{ secondary: deployFields.length }" :disabled="!!saving" @click="save()">
          <StableLabel :text="saving === 'save' ? 'Saving…' : 'Save'" :variants="['Saving…', 'Save']" />
        </button>
        <button v-if="deployFields.length" type="button" class="small" :disabled="!!saving || !!live?.currentDeployment" @click="save({ deploy: true })">
          <StableLabel :text="saving === 'deploy' ? 'Setting sail…' : 'Save and deploy'" :variants="['Setting sail…', 'Save and deploy']" />
        </button>
      </div>

      <CollapseSection title="Clone manually">
        <p class="hint" v-if="project.git_url">The repository is public — the command is just the URL.</p>
        <p class="hint" v-else>
          Generates a git clone command with a short-lived GitHub App installation token, to run on
          another server. The token expires after about an hour, grants access to every repo of the
          installation covering this one, and ends up in the clone's <span class="mono">.git/config</span> — after
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
      </CollapseSection>

      <CollapseSection title="Scuttle">
        <p class="hint" style="margin-top: 0">
          Removes the project from the panel and its process or container from the server. The files under
          its apps directory are kept.
        </p>
        <button class="danger" @click="remove">Scuttle project</button>
      </CollapseSection>
    </div>
  </div>
</template>

<script>
import StatusBadge from '../components/StatusBadge.vue'
import DeployLog from '../components/DeployLog.vue'
import EnvEditor from '../components/EnvEditor.vue'
import Pm2Logs from '../components/Pm2Logs.vue'
import CommitMessage from '../components/CommitMessage.vue'
import SourceFiles from '../components/SourceFiles.vue'
import StableLabel from '../components/StableLabel.vue'
import ActionMenu from '../components/ActionMenu.vue'
import CollapseSection from '../components/CollapseSection.vue'
import ProjectFields from '../components/ProjectFields.vue'
import { api } from '../api.js'
import { confirmDialog } from '../lib/dialog.js'
import { store, liveProject, appUrlFor } from '../store.js'
import { statusWord, vesselState } from '../lib/vessels.js'
import { primaryAction, actionMenu, performAction } from '../lib/vesselActions.js'
import { timeAgo, duration, uptimeSince, bytes } from '../lib/format.js'

const RUNTIME_LABEL = { pm2: 'a pm2 process', container: 'a container', static: 'a static site' }
const TABS = ['deploys', 'logs', 'env', 'files', 'settings']
// Every label the header's main button can show (StableLabel sizes it to the widest).
const PRIMARY_LABELS = ['Set sail — deploy', 'Deploy latest', 'Retry deploy', 'Start', 'Deploy', 'Under way…']
// What the Rigging form edits — what "unsaved changes" counts.
const FORM_FIELDS = [
  'name', 'group_id', 'git_url', 'repo_full_name', 'branch', 'auto_deploy', 'runtime', 'start_command',
  'build_image', 'run_image', 'pm2_name', 'memory_mb', 'network_profile', 'host_access', 'networks',
  'publish_dir', 'spa_fallback', 'gate_files', 'deploy_script', 'cwd', 'build_env', 'write_env_file',
  'subdomain', 'port',
]
const DISCARD = 'You have unsaved changes in Rigging. Leave them behind?'
// What a save alone does not put into effect — the next deploy does. The
// rest (name, pier, auto deploy, routing, the .env toggle) applies on save.
const DEPLOY_FIELDS = [
  'git_url', 'repo_full_name', 'branch', 'runtime', 'start_command', 'build_image', 'run_image', 'pm2_name',
  'memory_mb', 'network_profile', 'host_access', 'networks', 'publish_dir', 'gate_files', 'deploy_script', 'cwd',
  'build_env', 'port',
]

const positiveInt = v => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null)

export default {
  name: 'ProjectView',
  components: {
    StatusBadge, DeployLog, CommitMessage, EnvEditor, Pm2Logs, SourceFiles,
    StableLabel, ActionMenu, CollapseSection, ProjectFields,
  },
  props: { id: { type: String, required: true } },
  // Leaving the page (another route, or the browser) with unsaved Rigging asks first.
  async beforeRouteLeave() {
    if (this.dirtyFields.length) return confirmDialog(DISCARD, { confirmLabel: 'Leave', danger: true })
    return true
  },
  // The same page with another query: the back and forward buttons between
  // tabs. Our own setTab got there already; anything else moves the tab.
  async beforeRouteUpdate(to) {
    const tab = TABS.includes(to.query.tab) ? to.query.tab : 'deploys'
    if (tab === this.tab) return true
    if (this.tab === 'settings' && this.dirtyFields.length &&
        !(await confirmDialog(DISCARD, { confirmLabel: 'Leave', danger: true }))) return false
    if (this.tab === 'settings') this.discard()
    this.tab = tab
    return true
  },
  data() {
    const query = this.$route?.query ?? {}
    return {
      PRIMARY_LABELS,
      deployments: [],
      editLoaded: false,
      // The tab and the selected voyage live in the URL (?tab=, ?deployment=),
      // so a reload, the back button and a link from the ship's log all land
      // where they mean to; this is where the page starts.
      tab: TABS.includes(query.tab) ? query.tab : 'deploys',
      selectedId: positiveInt(query.deployment),
      edit: {},
      pristine: {}, // the form as last loaded or saved — what "unsaved" is measured against
      saving: '', // 'save' | 'deploy' while under way
      saveError: '',
      fieldErrors: {}, // the server's `fields` map, shown under each field
      saved: false,
      busy: false,
      checking: false,
      checkResult: '',
      cloneResult: '', // said whatever banner shows: the one answer a Clone gives
      checkError: '',
      tokenBusy: false,
      tokenError: '',
      cloneCommand: '',
      cloneExpiresAt: null,
      copiedCommand: false,
    }
  },
  computed: {
    // Templates only see what the instance exposes — raw store reads in the
    // template throw, so the role check lives here.
    isTenant() {
      return store.user?.role === 'tenant'
    },
    // What the project is being served as right now: the runtime of its
    // last successful deploy, or the configured one before any deploy.
    liveRuntime() {
      return this.project?.deployed_runtime || this.project?.runtime
    },
    isStatic() {
      return this.liveRuntime === 'static'
    },
    // A runtime saved in Rigging but not deployed yet: nothing has moved.
    pendingRuntime() {
      const p = this.project
      return p?.deployed_runtime && p.deployed_runtime !== p.runtime ? RUNTIME_LABEL[p.runtime] ?? p.runtime : ''
    },
    live() {
      return liveProject(Number(this.id))
    },
    // No checkout on the server yet (false, not merely unknown): offer Clone.
    needsClone() {
      return this.live?.checkedOut === false
    },
    checkLabel() {
      return this.project?.git_url ? '↻ Check remote' : '↻ Check GitHub'
    },
    headLabel() {
      if (this.checking) return this.needsClone ? 'Cloning…' : 'Checking…'
      return this.needsClone ? '⤓ Clone' : this.checkLabel
    },
    headLabels() {
      return ['⤓ Clone', 'Cloning…', this.checkLabel, 'Checking…']
    },
    // The same word the harbor row shows ("never deployed" before the first voyage).
    statusWord() {
      return statusWord(this.live)
    },
    // The row's action when its state asks for one; deploying otherwise —
    // on its own page, setting sail is always the main verb.
    primary() {
      if (vesselState(this.live) === 'underway') return { key: 'deploy', label: 'Under way…', disabled: true }
      return primaryAction(this.project, this.live) ?? { key: 'deploy', label: 'Set sail — deploy' }
    },
    // Everything else, without repeating the button next to it.
    menu() {
      return actionMenu(this.project, this.live, { exclude: this.primary.key })
    },
    // '' at no pier, or while the pier has not reached the store yet.
    pierName() {
      const id = this.project?.group_id
      return id == null ? '' : store.live.groups?.[id]?.name ?? ''
    },
    // pm2 counts every restart, the container engine counts only the ones its
    // own on-failure policy performed — a crash counter. Restarting a
    // container from the panel recreates it, so that count starts over.
    restartNoun() {
      const n = this.live?.pm2?.restarts ?? 0
      if (this.project?.runtime === 'container') return n === 1 ? 'crash' : 'crashes'
      return n === 1 ? 'restart' : 'restarts'
    },
    // The saved routing (what is actually live); RoutingFields previews
    // whatever is currently typed in the form.
    appUrl() {
      return appUrlFor(this.project)
    },
    appHost() {
      return this.appUrl.replace(/^https?:\/\//, '')
    },
    // owner/repo for GitHub, the URL without scheme and .git otherwise.
    repoLabel() {
      const p = this.project
      return p.repo_full_name || (p.git_url ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, '')
    },
    repoTitle() {
      return this.project.git_url || `https://github.com/${this.project.repo_full_name}`
    },
    // The branch on GitHub, or the remote itself when it is a web address.
    repoHref() {
      const p = this.project
      if (p.repo_full_name && !p.git_url) {
        const branch = p.branch.split('/').map(encodeURIComponent).join('/')
        return `https://github.com/${p.repo_full_name}/tree/${branch}`
      }
      return /^https:\/\//.test(p.git_url ?? '') ? p.git_url.replace(/\.git$/, '') : ''
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
    // The Rigging fields that differ from what was loaded or last saved.
    dirtyFields() {
      if (!this.editLoaded) return []
      return FORM_FIELDS.filter(k => String(this.edit[k] ?? '') !== String(this.pristine[k] ?? ''))
    },
    // Of those, the ones that wait for the next deploy.
    deployFields() {
      return this.dirtyFields.filter(k => DEPLOY_FIELDS.includes(k))
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
          this.seed(p)
          this.editLoaded = true
        }
      },
    },
    selectedId() {
      this.syncQuery()
    },
  },
  async created() {
    await this.loadDeployments()
    // A ?deployment= from a link wins, if it is one of this project's.
    if (!this.deployments.some(d => d.id === this.selectedId)) {
      this.selectedId = this.currentDeploymentId ?? this.deployments[0]?.id ?? null
    }
  },
  mounted() {
    window.addEventListener('beforeunload', this.onBeforeUnload)
  },
  unmounted() {
    window.removeEventListener('beforeunload', this.onBeforeUnload)
  },
  methods: {
    timeAgo,
    duration,
    uptimeSince,
    bytes,
    onBeforeUnload(event) {
      if (!this.dirtyFields.length) return
      event.preventDefault()
      event.returnValue = '' // what makes the browser ask
    },
    // A tab click: leaving Rigging with unsaved changes asks first, and the
    // tab goes into the URL as its own history entry, so Back returns to it.
    async setTab(tab) {
      if (tab === this.tab) return
      if (this.tab === 'settings' && this.dirtyFields.length) {
        if (!(await confirmDialog(DISCARD, { confirmLabel: 'Leave', danger: true }))) return
        this.discard()
      }
      this.tab = tab
      this.syncQuery({ push: true })
    },
    // The tab and the selected voyage into the URL. The voyage only replaces
    // the entry — clicking down the list is not history worth going back through.
    syncQuery({ push = false } = {}) {
      const query = { ...(this.$route?.query ?? {}) }
      if (this.tab === 'deploys') delete query.tab
      else query.tab = this.tab
      if (this.tab === 'deploys' && this.selectedId) query.deployment = String(this.selectedId)
      else delete query.deployment
      const now = this.$route?.query ?? {}
      const same = Object.keys({ ...query, ...now }).every(k => String(query[k] ?? '') === String(now[k] ?? ''))
      if (same) return
      this.$router?.[push ? 'push' : 'replace']?.({ query })
    },
    // The banner is one flowing sentence, so a paragraph-long subject is cut
    // in the text itself; the whole of it is in the title.
    brief(message) {
      const text = message ?? ''
      return text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text
    },
    async loadDeployments() {
      this.deployments = await api.get(`/api/projects/${this.id}/deployments`)
    },
    liveStatusFor(d) {
      if (d.id === this.currentDeploymentId) return this.live.currentDeployment.status
      if (d.id === this.live?.lastDeployment?.id) return this.live.lastDeployment.status
      return d.status
    },
    // A commit that deployed fine once, and is not what is deployed now.
    canRedeploy(d) {
      return this.liveStatusFor(d) === 'success' && Boolean(d.commit_sha) && d.commit_sha !== this.live?.deployedSha
    },
    async redeploy(d) {
      const sha = d.commit_sha.slice(0, 7)
      const what = d.commit_message ? ` — ${d.commit_message.split('\n')[0]}` : ''
      const ok = await confirmDialog(
        `Redeploy ${sha}${what}? This deploys an earlier commit; the branch head stays undeployed until the next deploy` +
          (this.project.auto_deploy && !this.project.git_url ? ', which the next push starts on its own.' : '.'),
        { confirmLabel: 'Redeploy' }
      )
      if (!ok) return
      this.busy = true
      try {
        const { id } = await api.post(`/api/projects/${this.id}/deploy`, { sha: d.commit_sha })
        this.selectedId = id
        await this.loadDeployments()
      } catch (err) {
        this.checkError = `Redeploy failed: ${err.fields?.sha || err.message}`
      } finally {
        this.busy = false
      }
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
    // The code onto the server, nothing deployed (POST /clone runs only git).
    async cloneNow() {
      this.checking = true
      this.cloneResult = ''
      this.checkError = ''
      try {
        const { sha, message } = await api.post(`/api/projects/${this.id}/clone`)
        this.cloneResult = `Cloned ${sha.slice(0, 7)} — ${message}. Nothing is deployed; the code is under Freight.`
      } catch (err) {
        this.checkError = `Clone failed: ${err.message}`
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
    // The header's button and menu (lib/vesselActions.js does the work).
    async run(key) {
      this.busy = true
      try {
        const result = await performAction(this.project, key)
        if (key === 'deploy' && result?.id) {
          this.selectedId = result.id
          await this.loadDeployments()
        }
      } finally {
        this.busy = false
      }
    },
    runtimeLabel(runtime) {
      return RUNTIME_LABEL[runtime] ?? runtime
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
        build_env: !!p.build_env,
        subdomain: p.subdomain ?? '',
        port: p.port ?? '',
        memory_mb: p.memory_mb ?? '',
        git_url: p.git_url ?? '',
        network_profile: p.network_profile ?? 'open',
        host_access: !!p.host_access,
        networks: p.networks ?? '',
        publish_dir: p.publish_dir ?? 'dist',
        spa_fallback: !!p.spa_fallback,
        gate_files: !!p.gate_files,
        group_id: p.group_id ?? '', // absent on the wire when at no pier
      }
    },
    // The form and its baseline, from a project row.
    seed(p) {
      this.edit = this.editable(p)
      this.pristine = this.editable(p)
    },
    discard() {
      if (this.project) this.seed(this.project)
      this.saveError = ''
      this.fieldErrors = {}
    },
    // `deploy` sets sail right after a good save, and shows the voyage.
    async save({ deploy = false } = {}) {
      this.saving = deploy ? 'deploy' : 'save'
      this.saveError = ''
      this.fieldErrors = {}
      this.saved = false
      try {
        const updated = await api.patch(`/api/projects/${this.id}`, {
          ...this.edit,
          cwd: this.edit.cwd || null,
          build_image: this.edit.build_image || null,
          run_image: this.edit.run_image || null,
          subdomain: this.edit.subdomain || null,
          port: String(this.edit.port ?? '').trim() || null,
          memory_mb: String(this.edit.memory_mb ?? '').trim() || null,
        })
        // LiveState carries the update to `project`; re-seed the form with the
        // server-normalized values.
        this.seed(updated)
        this.saved = true
      } catch (err) {
        this.fieldErrors = err.fields ?? {}
        this.saveError = err.fields ? 'Some fields need a look — they are marked above.' : err.message
        if (err.fields) this.$refs.fields?.revealErrors()
        this.saving = ''
        return
      }
      if (deploy) {
        const result = await performAction(this.project, 'deploy')
        if (result?.id) {
          await this.setTab('deploys')
          this.selectedId = result.id
          await this.loadDeployments()
        }
      }
      this.saving = ''
    },
    async remove() {
      if (!(await confirmDialog(`Delete project "${this.project.name}"? The pm2 process is removed; files on disk are kept.`, { confirmLabel: 'Delete', danger: true }))) return
      this.pristine = { ...this.edit } // nothing left to lose: no leave prompt
      await api.del(`/api/projects/${this.id}`)
      this.$router.push('/')
    },
  },
}
</script>
