import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'

// Flat config for the whole workspace. Three worlds: Bun on the server
// (server/, scripts/), the browser for the Vue app (web/src/), and Bun again
// for the tooling configs. Style is not enforced here — the repo has no
// formatter, so lint stays about real mistakes.

// Bun's extras on top of the Node globals it also provides.
const bunGlobals = { ...globals.node, Bun: 'readonly', prompt: 'readonly' }

export default [
  {
    ignores: ['node_modules/**', 'web/dist/**', 'data/**'],
  },

  js.configs.recommended,

  // Server, install/seed scripts.
  {
    files: ['server/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: bunGlobals,
    },
  },

  // Vue app: browser globals + the plugin's correctness rules (essential, not
  // recommended — the latter is mostly template formatting).
  ...pluginVue.configs['flat/essential'].map((c) => ({
    ...c,
    files: ['web/src/**/*.{js,vue}'],
  })),
  {
    files: ['web/src/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      // View components are routed single-word names by design.
      'vue/multi-word-component-names': 'off',
    },
  },

  // Tooling configs run under Bun/Node, not the browser.
  {
    files: ['*.js', 'web/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: bunGlobals,
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
]
