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
]
