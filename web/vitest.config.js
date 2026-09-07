import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Component smoke tests: every view mounted with a stubbed store/api under
// happy-dom, failing on any Vue render warning. Kept apart from vite.config.js
// so the dev-server proxy setup stays untouched.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    // The harness self-test compiles an inline `template:` string, which needs
    // the runtime compiler; SFCs are precompiled by the plugin either way.
    alias: { vue: 'vue/dist/vue.esm-bundler.js' },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.js'],
  },
})
