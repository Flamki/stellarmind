import globals from 'globals'
import prettierPlugin from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'

const { browser, node } = globals

export default [
  prettierConfig,
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', '.github/**', '**/*.log'],
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...browser,
        ...node,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prettier/prettier': ['error', { endOfLine: 'lf' }],
    },
  },
  {
    // Vanilla browser scripts (loaded via <script> tags) share the global scope:
    // functions defined in one file are called from others (e.g. init.js calls
    // loadAgents/loadWallets/connectSSE). ESLint analyzes files in isolation, so
    // suppress the unused-vars check for these non-module scripts.
    files: ['public/assets/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
    },
    rules: {
      'no-unused-vars': 'off',
    },
  },
]
