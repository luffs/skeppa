import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// The browser always talks to the Vite dev server (same-origin), which proxies
// /api and /live to the backend. Keeping it same-origin means the
// SameSite=Lax session cookie is sent on every request and on the /live
// upgrade — a cross-site target (e.g. a deployed VPS) would drop the Lax
// cookie and 401 everything.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_SKEPPA_API || 'http://127.0.0.1:3000'
  const proxy = { target, changeOrigin: true }

  return {
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        '/api': proxy,
        '/live': { ...proxy, ws: true }, // the stores' socket and their snapshot route
      },
    },
  }
})
