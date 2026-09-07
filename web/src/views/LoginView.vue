<template>
  <div class="login-wrap">
    <button
      type="button"
      class="secondary small theme-toggle"
      :title="theme === 'dark' ? 'Switch to day watch' : 'Switch to night watch'"
      @click="flipTheme"
    >{{ theme === 'dark' ? '☀' : '☾' }}</button>
    <form class="login-box" @submit.prevent="submit">
      <div class="sail">⛵</div>
      <h1>Skeppa</h1>
      <div class="tagline">deploy panel · come aboard</div>
      <div class="waves">
        <div>～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～～</div>
      </div>
      <label>Username</label>
      <input v-model="username" autocomplete="username" autofocus />
      <label style="margin-top: 14px">Password</label>
      <input v-model="password" type="password" autocomplete="current-password" />
      <p v-if="error" class="error">{{ error }}</p>
      <p style="margin: 20px 0 0">
        <button :disabled="busy || !username || !password" style="width: 100%; padding: 12px; font-size: 14px; letter-spacing: 0.04em">
          {{ busy ? 'Boarding…' : 'Come aboard' }}
        </button>
      </p>
      <p v-if="firebase" style="margin: 12px 0 0">
        <button type="button" class="secondary" :disabled="busy" style="width: 100%; padding: 11px; font-size: 14px" @click="googleSignIn">
          Sign in with Google
        </button>
      </p>
    </form>
  </div>
</template>

<script>
import { api } from '../api.js'
import { store } from '../store.js'
import { connectLive } from '../live.js'
import { currentTheme, toggleTheme } from '../lib/theme.js'

// Firebase is loaded from Google's CDN only when a config exists and the
// button is clicked — it is deliberately not an npm dependency. Cached so a
// retried sign-in doesn't call initializeApp twice (which throws).
let firebasePromise = null
function loadFirebase(firebaseConfig) {
  if (!firebasePromise) {
    firebasePromise = (async () => {
      const appUrl = 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js'
      const authUrl = 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js'
      const [{ initializeApp }, { getAuth, GoogleAuthProvider, signInWithPopup }] = await Promise.all([
        import(/* @vite-ignore */ appUrl),
        import(/* @vite-ignore */ authUrl),
      ])
      const firebaseApp = initializeApp(firebaseConfig)
      const firebaseAuth = getAuth(firebaseApp)
      return { firebaseAuth, GoogleAuthProvider, signInWithPopup }
    })()
  }
  return firebasePromise
}

export default {
  name: 'LoginView',
  data() {
    return { username: '', password: '', error: '', busy: false, theme: currentTheme(), firebase: null }
  },
  async created() {
    try {
      this.firebase = await api.get('/api/auth/firebase-config')
    } catch {
      this.firebase = null
    }
  },
  methods: {
    flipTheme() {
      this.theme = toggleTheme()
    },
    async submit() {
      this.busy = true
      this.error = ''
      try {
        store.user = await api.post('/api/auth/login', {
          username: this.username,
          password: this.password,
        })
        connectLive()
        this.$router.push('/')
      } catch (err) {
        this.error = err.message
      } finally {
        this.busy = false
      }
    },
    async googleSignIn() {
      this.busy = true
      this.error = ''
      try {
        const { firebaseAuth, GoogleAuthProvider, signInWithPopup } = await loadFirebase(this.firebase)
        const result = await signInWithPopup(firebaseAuth, new GoogleAuthProvider())
        const idToken = await result.user.getIdToken()
        store.user = await api.post('/api/auth/firebase', { idToken })
        connectLive()
        this.$router.push('/')
      } catch (err) {
        // Closing the popup is not an error worth surfacing.
        if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
          this.error = err.message
        }
      } finally {
        this.busy = false
      }
    },
  },
}
</script>
