<template>
  <div class="container">
    <div class="row" style="justify-content: space-between; margin-bottom: 16px">
      <h1 style="margin: 0">Projects</h1>
      <router-link to="/projects/new"><button>+ New project</button></router-link>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="projects.length" class="grid">
      <ProjectCard v-for="p in projects" :key="p.id" :project="p" />
    </div>
    <div v-else-if="loaded" class="panel">
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
import { api } from '../api.js'

export default {
  name: 'DashboardView',
  components: { ProjectCard },
  data() {
    return { projects: [], loaded: false, error: '' }
  },
  async created() {
    try {
      this.projects = await api.get('/api/projects')
    } catch (err) {
      this.error = err.message
    } finally {
      this.loaded = true
    }
  },
}
</script>
