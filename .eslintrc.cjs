module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2024: true
  },
  extends: ["eslint:recommended", "plugin:prettier/recommended"],
  plugins: ["prettier"],
  ignorePatterns: ["node_modules/", "coverage/", "dist/", "*.log", ".github/"],
  rules: {
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-console": "off",
    "prettier/prettier": ["error", { endOfLine: "lf" }]
  }
}
