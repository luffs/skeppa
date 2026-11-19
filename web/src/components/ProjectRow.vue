<template>
  <div class="vessel-row" :class="'state-' + state" :title="repoTitle" @click="openProject">
    <div class="vessel-main">
      <div class="vessel-l1">
        <span class="dot" :class="dot" aria-hidden="true"></span>
        <router-link :to="`/projects/${project.id}`" class="vessel-name" @click.stop>{{ project.name }}</router-link>
        <span class="vessel-status">{{ statusText }}</span>
        <span v-if="branchChip" class="vessel-branch" title="Deploys this branch">{{ branchChip }}</span>
      </div>
      <!-- a sentence, the commit ids in it set as code -->
      <div v-if="detail.length" class="vessel-l2"><template v-for="(seg, i) in detail" :key="i"><code v-if="seg.code">{{ seg.text }}</code><template v-else>{{ seg.text }}</template></template></div>
    </div>
    <!-- in the same place on every row: by the button, or under the name where it is narrow -->
    <a v-if="appUrl" :href="appUrl" target="_blank" rel="noopener" class="vessel-addr vessel-row-addr" :title="appUrl" @click.stop>
      {{ appHost }}<span aria-hidden="true"> ↗</span>
    </a>
    <div class="vessel-actions" @click.stop>
      <button v-if="action" type="button" class="small secondary" :disabled="busy" @click="run(action.key)">
        {{ busy ? 'Working…' : action.label }}
      </button>
      <ActionMenu :label="`Vessel ${project.name}`" :items="menu" @select="run" />
    </div>
  </div>
</template>

<script>
import ActionMenu from './ActionMenu.vue'
import { liveProject, appUrlFor } from '../store.js'
import { primaryAction, actionMenu, performAction, lastVoyageId } from '../lib/vesselActions.js'
import { timeAgo, uptimeSince } from '../lib/format.js'
import { vesselState, statusWord, VESSEL_STATES } from '../lib/vessels.js'

const short = sha => (sha ? sha.slice(0, 7) : '')
const firstLine = text => (text ?? '').split('\n')[0].trim()
// The branches nearly every project deploys: not worth a mark on the row.
const USUAL_BRANCHES = new Set(['main', 'master'])
const text = t => ({ text: t, code: false })
const code = t => ({ text: t, code: true })

// One project in the harbor, as a row: a state dot (the same states a folded
// pier sums up — lib/vessels.js), the name, what it is doing, and its branch
// when that is not main; below, in a sentence, what happened last; its
// address on the right, where it is the same place on every row. A button only when something wants doing —
// deploy what is new, retry what failed, start what is down — and the rest
// in the ⋮ menu, moving it between piers included. The whole row opens the
// project; its links and buttons do their own thing.
export default {
  name: 'ProjectRow',
  components: { ActionMenu },
  props: { project: { type: Object, required: true } },
  data() {
    return { busy: false }
  },
  computed: {
    live() {
      return liveProject(this.project.id)
    },
    state() {
      return vesselState(this.live)
    },
    dot() {
      return VESSEL_STATES.find(s => s.key === this.state)?.dot ?? ''
    },
    // What is being served right now, not what the form says next.
    isStatic() {
      return (this.project.deployed_runtime || this.project.runtime) === 'static'
    },
    status() {
      return this.live?.pm2?.status ?? 'unknown'
    },
    // The same word the project page's badge shows.
    word() {
      return statusWord(this.live)
    },
    last() {
      return this.live?.lastDeployment ?? null
    },
    appUrl() {
      return appUrlFor(this.project)
    },
    appHost() {
      return this.appUrl.replace(/^https?:\/\//, '')
    },
    repoTitle() {
      const repo = this.project.repo_full_name || (this.project.git_url ?? '').replace(/^https:[/][/]/, '')
      return `${repo} @ ${this.project.branch}`
    },
    statusText() {
      switch (this.state) {
        case 'underway':
          return this.live.currentDeployment.status === 'queued' ? 'waiting to depart' : 'voyage under way…'
        case 'down':
          return this.word
        case 'failed':
          return 'voyage failed'
        case 'ahead':
          return 'new commits'
        case 'running':
          return this.word
        default:
          return this.word === 'unknown' ? 'status unknown' : this.word
      }
    },
    branchChip() {
      const b = this.project.branch ?? ''
      return b && !USUAL_BRANCHES.has(b) ? b : ''
    },
    // The second line, as a sentence — [{ text, code }] pieces, a commit id
    // set as code: what came in, what went wrong, or what was deployed when.
    detail() {
      const head = this.live?.headCommit
      const last = this.last
      if (this.state === 'ahead' && head?.sha) {
        const message = firstLine(head.message)
        return [code(short(head.sha)), ...(message ? [text(` ${message}`)] : [])]
      }
      if (this.state === 'failed') {
        // A failed deploy leaves what served before untouched.
        const serving = this.status === 'online' || this.status === 'published'
        return [
          text('Failed'),
          ...(last?.commitSha ? [text(' on '), code(short(last.commitSha))] : []),
          text(` ${timeAgo(last?.finishedAt)}${serving ? ' — the previous build is still serving' : ''}`),
        ]
      }
      const up = this.state === 'running' && this.status === 'online' ? `Up ${uptimeSince(this.live.pm2.uptime)} · ` : ''
      const deployed = this.lastDeployed
      if (deployed) {
        return [
          text(`${up}${up ? 'deployed' : 'Deployed'} `),
          ...(deployed.commitSha ? [code(short(deployed.commitSha)), text(' ')] : []),
          text(timeAgo(deployed.finishedAt)),
        ]
      }
      if (last) return [text(`Last voyage ${last.status} ${timeAgo(last.finishedAt)}`)]
      if (up) return [text(up.slice(0, -3))]
      // nothing deployed yet: where it comes from
      const repo = this.project.repo_full_name || (this.project.git_url ?? '').replace(/^https?:[/][/]/, '').replace(/\.git$/, '')
      return repo ? [text(repo)] : []
    },
    // The last voyage that made port, if that is the last one.
    lastDeployed() {
      return this.last?.status === 'success' ? this.last : null
    },
    // The one button on the row, and the rest in ⋮ — decided in
    // lib/vesselActions.js, so the project page offers exactly the same.
    action() {
      return primaryAction(this.project, this.live)
    },
    menu() {
      return actionMenu(this.project, this.live, { exclude: this.action?.key, goto: true, piers: true })
    },
  },
  methods: {
    openProject(event) {
      // A selection being made is not a click to open.
      if (window.getSelection?.()?.toString()) return
      if (event.target.closest('a, button')) return
      this.$router.push(`/projects/${this.project.id}`)
    },
    async run(key) {
      const page = query => this.$router.push({ path: `/projects/${this.project.id}`, query })
      if (key === 'voyage') return page({ deployment: String(lastVoyageId(this.live)) })
      if (key === 'logbook') return page({ tab: 'logs' })
      if (key === 'rigging') return page({ tab: 'settings' })
      this.busy = true
      try {
        await performAction(this.project, key)
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
