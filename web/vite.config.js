import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// The browser always talks to the Vite dev server (same-origin), which proxies
// /api and /ws to the backend. Keeping it same-origin means the SameSite=Lax
// session cookie is sent on every request and the /ws upgrade — a cross-site
// target (e.g. a deployed VPS) would drop the Lax cookie and 401 everything.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_SKEPPA_API || 'http://localhost:3000'
  const proxy = { target, changeOrigin: true }

  return {
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        '/api': proxy,
        '/ws': { ...proxy, ws: true },
      },
    },
  }
})
