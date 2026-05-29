import globals from "globals"
import prettierPlugin from "eslint-plugin-prettier"

const { browser, node } = globals

export default [
  {
    ignores: ["node_modules/**", ".github/**", "coverage/**", "dist/**", "**/*.log"],
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...browser,
        ...node
      }
    },
    plugins: {
      prettier: prettierPlugin
    },
    extends: ["eslint:recommended", "plugin:prettier/recommended"],
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      "prettier/prettier": ["error", { endOfLine: "lf" }]
    }
  }
]
