/**
 * Offline Suite Discovery & Exit Behavior Tests (Issue #175)
 *
 * Run: node tests/offline-suite-runner.test.js
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASELINE_OFFLINE_SUITES,
  discoverOfflineSuites,
  runOfflineSuites,
} from './run-offline-suites.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
  }
}

console.log('Testing offline regression suite discovery and execution (issue #175)...')

await test('Default npm test script invokes the offline suite runner', () => {
  assert.equal(pkg.scripts.test, 'node tests/run-offline-suites.js')
})

await test('Every intended offline regression suite is discovered', () => {
  const discovered = discoverOfflineSuites({ rootDir: repoRoot, validateBaseline: true })

  for (const expected of BASELINE_OFFLINE_SUITES) {
    assert.ok(discovered.includes(expected), `Expected offline suite ${expected} to be discovered`)
  }

  // Previously omitted suites from issue #175 context must be included
  const previouslyOmitted = [
    'tests/api.validation.test.js',
    'tests/pricing.validator.test.js',
    'tests/pricing.integration.test.js',
    'tests/security.integration.test.js',
    'tests/sse-heartbeat.test.js',
    'tests/run-history-recovery.test.js',
    'tests/run-history-schema.test.js',
    'tests/wallet-availability.test.js',
  ]
  for (const suite of previouslyOmitted) {
    assert.ok(discovered.includes(suite), `Previously omitted suite ${suite} must be discovered`)
  }
})

await test('Live-funded demos, smoke checks, and load tests remain explicit opt-in commands', () => {
  const discovered = discoverOfflineSuites({ rootDir: repoRoot, validateBaseline: true })

  assert.ok(!discovered.includes('tests/smoke.test.js'), 'smoke.test.js must remain separate')
  assert.ok(
    !discovered.some((suite) => suite.startsWith('tests/load/')),
    'load tests must remain opt-in'
  )
  assert.ok(!discovered.includes('src/demo.js'), 'live demo must remain opt-in')

  assert.equal(pkg.scripts.smoke, 'node tests/smoke.test.js')
  assert.equal(pkg.scripts.demo, 'node src/demo.js')
  assert.equal(pkg.scripts['test:demo'], 'node src/demo.js')
  assert.equal(pkg.scripts['test:load'], 'npx k6 run tests/load/load-test.js')
})

await test('Newly added regression files are automatically discovered and cannot be silently omitted', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarmind-suite-discovery-'))
  try {
    fs.mkdirSync(path.join(tempRoot, 'src', 'agents'), { recursive: true })
    fs.mkdirSync(path.join(tempRoot, 'tests', 'load'), { recursive: true })

    fs.writeFileSync(
      path.join(tempRoot, 'src', 'agents', 'existing.test.js'),
      'process.exit(0)\n',
      'utf8'
    )
    fs.writeFileSync(
      path.join(tempRoot, 'tests', 'newly-added-regression.test.js'),
      'process.exit(0)\n',
      'utf8'
    )
    // Opt-in files should still be ignored
    fs.writeFileSync(path.join(tempRoot, 'tests', 'smoke.test.js'), 'process.exit(0)\n', 'utf8')
    fs.writeFileSync(
      path.join(tempRoot, 'tests', 'load', 'load-test.js'),
      'process.exit(0)\n',
      'utf8'
    )

    const discovered = discoverOfflineSuites({ rootDir: tempRoot, validateBaseline: false })
    assert.deepEqual(discovered, [
      'src/agents/existing.test.js',
      'tests/newly-added-regression.test.js',
    ])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

await test('Temporary failing fixture is discovered, returns nonzero, and names the failing suite', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarmind-suite-failure-'))
  try {
    fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true })

    fs.writeFileSync(
      path.join(tempRoot, 'tests', 'passing-fixture.test.js'),
      'console.log("ok")\n',
      'utf8'
    )
    fs.writeFileSync(
      path.join(tempRoot, 'tests', 'failing-fixture.test.js'),
      'console.error("intentional regression failure"); process.exit(1)\n',
      'utf8'
    )

    const report = runOfflineSuites({
      rootDir: tempRoot,
      validateBaseline: false,
      quiet: true,
    })

    assert.equal(report.exitCode, 1, 'Runner must return nonzero exit code on suite failure')
    assert.deepEqual(report.passed, ['tests/passing-fixture.test.js'])
    assert.equal(report.failed.length, 1)
    assert.equal(report.failed[0].suite, 'tests/failing-fixture.test.js')
    assert.ok(
      report.summary.includes('tests/failing-fixture.test.js'),
      `Summary should name the failing suite, got: ${report.summary}`
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
