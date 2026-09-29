/**
 * Print the tails of the logs the cross-OS job collected (Issue #176).
 *
 * A failed CI job should carry the diagnostic, not just the exit code. The
 * suites write their full output to `$CI_LOG_DIR` when it is set (the workflow
 * points it at a temporary directory) and this prints the last lines of each
 * file — short enough to read in the job summary.
 *
 * Run: node tests/support/print-diagnostics.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const TAIL_LINES = 25
const logDir = process.env.CI_LOG_DIR

if (!logDir) {
  console.log('diagnostics: CI_LOG_DIR is not set, nothing was collected')
  process.exit(0)
}
if (!fs.existsSync(logDir)) {
  console.log(`diagnostics: no logs at ${logDir}`)
  process.exit(0)
}

const files = fs
  .readdirSync(logDir)
  .filter((name) => name.endsWith('.log'))
  .sort()

if (files.length === 0) {
  console.log(`diagnostics: ${logDir} holds no .log files`)
  process.exit(0)
}

for (const name of files) {
  const full = path.join(logDir, name)
  const lines = fs.readFileSync(full, 'utf8').trimEnd().split('\n')
  const tail = lines.slice(-TAIL_LINES)
  console.log(`\n── ${name} (${lines.length} lines, showing last ${tail.length}) ──`)
  console.log(tail.join('\n'))
}
