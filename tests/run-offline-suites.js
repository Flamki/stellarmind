/**
 * Offline Regression Suite Discovery & Runner (Issue #175)
 *
 * Discovers and executes all offline `*.test.js` regression suites under `src/`
 * and `tests/`, while keeping live-funded demos (`src/demo.js`), process-spawn
 * smoke checks (`tests/smoke.test.js`), and k6 load tests (`tests/load/**`) as
 * explicit opt-in commands.
 *
 * Run: node tests/run-offline-suites.js
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Explicit opt-in / separate suites excluded from the default offline gate:
 * - `tests/smoke.test.js`: full HTTP server child-process smoke check (`npm run smoke`)
 * - `tests/load/`: k6 load tests (`npm run test:load`)
 */
export const OPT_IN_TEST_PATHS = new Set(['tests/smoke.test.js'])
export const OPT_IN_TEST_PREFIXES = ['tests/load/']

/**
 * Validated baseline manifest of offline regression suites in the repository.
 * Automatic filesystem discovery also picks up any newly added `*.test.js`
 * files under `src/` or `tests/` so new suites cannot be silently omitted.
 */
export const BASELINE_OFFLINE_SUITES = [
  'src/agents/settlement-header.test.js',
  'tests/admission-queue.integration.test.js',
  'tests/admission-queue.test.js',
  'tests/api.validation.test.js',
  'tests/app-factory.integration.test.js',
  'tests/async-orchestration.test.js',
  'tests/docker-port-config.test.js',
  'tests/docker-run-history.test.js',
  'tests/horizon-transaction-ops.test.js',
  'tests/network-profile.test.js',
  'tests/offline-suite-runner.test.js',
  'tests/orchestrator.budget.test.js',
  'tests/payment-attempts.test.js',
  'tests/payment-reconciliation.test.js',
  'tests/plan-preview.test.js',
  'tests/plan-validator.test.js',
  'tests/premium-endpoints.integration.test.js',
  'tests/premium-routes-ownership.test.js',
  'tests/pricing.integration.test.js',
  'tests/pricing.validator.test.js',
  'tests/response-normalization.test.js',
  'tests/run-history-recovery.test.js',
  'tests/run-history-schema.test.js',
  'tests/security.integration.test.js',
  'tests/settlement-reporting.test.js',
  'tests/sse-heartbeat.test.js',
  'tests/usage-tracking.test.js',
  'tests/wallet-availability.test.js',
]

function toPosixRelative(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).join('/')
}

function isOptInPath(relPath) {
  if (OPT_IN_TEST_PATHS.has(relPath)) return true
  return OPT_IN_TEST_PREFIXES.some((prefix) => relPath.startsWith(prefix))
}

function walkTestFiles(dirPath, rootDir, collected = []) {
  if (!fs.existsSync(dirPath)) return collected
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      walkTestFiles(fullPath, rootDir, collected)
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      const relPath = toPosixRelative(rootDir, fullPath)
      if (!isOptInPath(relPath)) {
        collected.push(relPath)
      }
    }
  }
  return collected
}

/**
 * Discovers all offline regression test files under `src/` and `tests/`.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {boolean} [options.validateBaseline]
 * @returns {string[]} sorted relative POSIX paths
 */
export function discoverOfflineSuites({
  rootDir = defaultRootDir,
  validateBaseline = rootDir === defaultRootDir,
} = {}) {
  const discovered = [
    ...walkTestFiles(path.join(rootDir, 'src'), rootDir),
    ...walkTestFiles(path.join(rootDir, 'tests'), rootDir),
  ].sort()

  if (validateBaseline) {
    const discoveredSet = new Set(discovered)
    const missingBaseline = BASELINE_OFFLINE_SUITES.filter((suite) => !discoveredSet.has(suite))
    if (missingBaseline.length > 0) {
      throw new Error(`Missing expected offline regression suite(s): ${missingBaseline.join(', ')}`)
    }
  }

  return discovered
}

/**
 * Runs discovered offline suites sequentially and reports results.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {string[]} [options.suites]
 * @param {boolean} [options.validateBaseline]
 * @param {boolean} [options.quiet]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function runOfflineSuites({
  rootDir = defaultRootDir,
  suites,
  validateBaseline = rootDir === defaultRootDir && !suites,
  quiet = false,
  env = process.env,
} = {}) {
  const targetSuites = suites || discoverOfflineSuites({ rootDir, validateBaseline })
  const passed = []
  const failed = []

  if (!quiet) {
    console.log(`Running ${targetSuites.length} offline regression suite(s)...\n`)
  }

  for (const suite of targetSuites) {
    const absPath = path.join(rootDir, ...suite.split('/'))
    const result = spawnSync(process.execPath, [absPath], {
      cwd: rootDir,
      env: {
        ...env,
        STELLARMIND_OFFLINE_RUNNER: '1',
      },
      encoding: 'utf8',
    })

    if (result.status === 0) {
      passed.push(suite)
      if (!quiet) {
        console.log(`PASS ${suite}`)
      }
    } else {
      const exitCode = result.status ?? 1
      failed.push({
        suite,
        exitCode,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      })
      if (!quiet) {
        console.error(`FAIL ${suite} (exit ${exitCode})`)
        if (result.stdout) console.error(result.stdout.trimEnd())
        if (result.stderr) console.error(result.stderr.trimEnd())
      }
    }
  }

  const summary =
    failed.length === 0
      ? `\nOffline regression summary: ${passed.length}/${targetSuites.length} suites passed.`
      : `\nOffline regression summary: ${passed.length} passed, ${failed.length} failed. Failing suite(s): ${failed.map((f) => f.suite).join(', ')}`

  if (!quiet) {
    if (failed.length === 0) {
      console.log(summary)
    } else {
      console.error(summary)
    }
  }

  return {
    total: targetSuites.length,
    passed,
    failed,
    exitCode: failed.length === 0 ? 0 : 1,
    summary: summary.trim(),
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const report = runOfflineSuites()
  process.exit(report.exitCode)
}
