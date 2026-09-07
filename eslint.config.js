import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import stylistic from '@stylistic/eslint-plugin'

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
  // Formatting. ESLint core dropped its stylistic rules, so these come from
  // @stylistic — they are what makes `--fix` reformat anything at all. The
  // values are the style the repo was already written in: no semicolons,
  // single quotes, two spaces, trailing commas in multiline literals.
  {
    files: ['**/*.{js,cjs,vue}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0, maxBOF: 0 }],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1, CallExpression: { arguments: 'off' } }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/comma-dangle': ['error', { functions: 'never', arrays: 'only-multiline', objects: 'only-multiline', imports: 'only-multiline', exports: 'only-multiline' }],
      '@stylistic/comma-spacing': 'error',
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      '@stylistic/arrow-spacing': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/block-spacing': 'error',
      '@stylistic/no-multi-spaces': 'error',
      '@stylistic/key-spacing': 'error',
      '@stylistic/rest-spread-spacing': 'error',
    },
  },

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
  ...pluginVue.configs['flat/essential'].map(c => ({
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

  // Frontend smoke tests: Vitest under happy-dom — browser globals for the
  // mounted views, Node globals for the runner itself.
  {
    files: ['web/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
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
