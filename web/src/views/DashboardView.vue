<template>
  <div class="container">
    <div class="row" style="justify-content: space-between; margin-bottom: 16px">
      <h1 style="margin: 0">Projects</h1>
      <router-link to="/projects/new"><button>+ New project</button></router-link>
    </div>
    <div v-if="projects.length" class="grid">
      <ProjectCard v-for="p in projects" :key="p.id" :project="p" />
    </div>
    <div v-else-if="ready" class="panel">
      <p>No projects yet.</p>
      <p class="hint">
        Configure the <router-link to="/settings">GitHub App</router-link> first, then
        <router-link to="/projects/new">add your first project</router-link>.
      </p>
    </div>
  </div>
</template>

<script>
import ProjectCard from '../components/ProjectCard.vue'
import { store } from '../store.js'

export default {
  name: 'DashboardView',
  components: { ProjectCard },
  computed: {
    // Rendered straight from the LiveState mirror — no API round-trip when
    // navigating here, and cards update live as projects change.
    projects() {
      return Object.values(store.live.projects ?? {})
        .map(p => p.info)
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    ready() {
      return store.ready
    },
  },
}
</script>
