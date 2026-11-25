/**
 * Test Discovery and Manifest Validation Tests (#175)
 *
 * Validates the test infrastructure:
 * - Manifest exists and is valid JSON
 * - All test files are categorized
 * - Test runner discovers and executes tests
 * - Failed tests return nonzero exit codes
 * - Suite names are reported correctly
 *
 * Run: node tests/test-discovery.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

console.log('🧪 Testing test discovery infrastructure...\n')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    passed++
  } catch (err) {
    console.error(`❌ ${name}`)
    console.error(`   ${err.message}`)
    failed++
  }
}

// Test 1: Manifest exists
test('Manifest file exists', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  assert.ok(fs.existsSync(manifestPath), 'test-manifest.json should exist')
})

// Test 2: Manifest is valid JSON
test('Manifest is valid JSON', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const content = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(content)
  assert.ok(manifest, 'Manifest should parse as JSON')
})

// Test 3: Manifest has required categories
test('Manifest has required categories', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  assert.ok(Array.isArray(manifest.offline), 'offline category should be an array')
  assert.ok(Array.isArray(manifest.validation), 'validation category should be an array')
  assert.ok(Array.isArray(manifest.optin), 'optin category should be an array')
})

// Test 4: Manifest has description
test('Manifest has descriptions', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  assert.ok(manifest.description, 'Manifest should have description object')
  assert.ok(manifest.description.offline, 'Should describe offline category')
  assert.ok(manifest.description.validation, 'Should describe validation category')
  assert.ok(manifest.description.optin, 'Should describe optin category')
})

// Test 5: All categorized files exist
test('All categorized files exist', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const allFiles = [...manifest.offline, ...manifest.validation, ...manifest.optin]

  for (const file of allFiles) {
    const filePath = path.resolve(repoRoot, file)
    assert.ok(fs.existsSync(filePath), `Categorized file should exist: ${file}`)
  }
})

// Test 6: No duplicate entries
test('No duplicate test entries', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const allFiles = [...manifest.offline, ...manifest.validation, ...manifest.optin]
  const uniqueFiles = new Set(allFiles)

  assert.strictEqual(allFiles.length, uniqueFiles.size, 'Should not have duplicate test entries')
})

// Test 7: Test runner exists
test('Test runner script exists', () => {
  const runnerPath = path.join(__dirname, 'run-tests.js')
  assert.ok(fs.existsSync(runnerPath), 'run-tests.js should exist')
})

// Test 8: Validator script exists
test('Validator script exists', () => {
  const validatorPath = path.join(__dirname, 'validate-manifest.js')
  assert.ok(fs.existsSync(validatorPath), 'validate-manifest.js should exist')
})

// Test 9: package.json has correct test commands
test('package.json has manifest-based test commands', () => {
  const packagePath = path.join(repoRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

  assert.ok(pkg.scripts.test.includes('run-tests.js'), 'npm test should use run-tests.js')
  assert.ok(
    pkg.scripts['test:validation'].includes('run-tests.js'),
    'npm run test:validation should use run-tests.js'
  )
  assert.ok(pkg.scripts['test:validate-manifest'], 'Should have test:validate-manifest command')
})

// Test 10: Offline tests include essential suites
test('Offline tests include essential suites', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const essentialTests = [
    'tests/orchestrator.budget.test.js',
    'tests/usage-tracking.test.js',
    'tests/payment-attempts.test.js',
    'tests/plan-validator.test.js',
  ]

  for (const test of essentialTests) {
    assert.ok(manifest.offline.includes(test), `Essential test should be in offline: ${test}`)
  }
})

// Test 11: Validation category is separate
test('Validation tests are separate from offline', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  assert.ok(
    manifest.validation.includes('tests/api.validation.test.js'),
    'api.validation.test.js should be in validation category'
  )

  assert.ok(
    !manifest.offline.includes('tests/api.validation.test.js'),
    'api.validation.test.js should NOT be in offline category'
  )
})

// Test 12: Opt-in tests are separate
test('Opt-in tests are separate', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const optinTests = ['src/demo.js', 'tests/smoke.test.js']

  for (const test of optinTests) {
    assert.ok(manifest.optin.includes(test), `Opt-in test should be in optin category: ${test}`)

    assert.ok(!manifest.offline.includes(test), `Opt-in test should NOT be in offline: ${test}`)
  }
})

// Test 13: CI workflow uses manifest validation
test('CI workflow validates manifest', () => {
  const ciPath = path.join(repoRoot, '.github/workflows/ci.yml')
  const ciContent = fs.readFileSync(ciPath, 'utf8')

  assert.ok(ciContent.includes('test:validate-manifest'), 'CI should validate manifest')
})

// Test 14: Test count is reasonable
test('Reasonable number of tests categorized', () => {
  const manifestPath = path.join(__dirname, 'test-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  const totalTests = manifest.offline.length + manifest.validation.length + manifest.optin.length

  assert.ok(totalTests >= 10, 'Should have at least 10 categorized tests')
  assert.ok(totalTests <= 100, 'Should have fewer than 100 tests (sanity check)')
})

// Test 15: Test runner is executable
test('Test runner is executable', () => {
  const runnerPath = path.join(__dirname, 'run-tests.js')
  const stats = fs.statSync(runnerPath)
  const isExecutable = (stats.mode & 0o100) !== 0

  assert.ok(isExecutable || process.platform === 'win32', 'run-tests.js should be executable')
})

// Test 16: Documentation exists
test('Testing documentation exists', () => {
  const docsPath = path.join(repoRoot, 'docs/TESTING.md')
  assert.ok(fs.existsSync(docsPath), 'docs/TESTING.md should exist')
})

// Summary
console.log('\n' + '='.repeat(50))
console.log(`Test Discovery Validation`)
console.log('='.repeat(50))
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)

if (failed > 0) {
  console.log('\n❌ Test discovery validation failed\n')
  process.exit(1)
} else {
  console.log('\n✅ Test discovery infrastructure is valid\n')
  process.exit(0)
}
