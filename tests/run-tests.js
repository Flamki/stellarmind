#!/usr/bin/env node
/**
 * Test runner with manifest-based discovery (#175)
 *
 * Runs test suites from the manifest, ensuring every intended offline
 * regression test is included. Newly added tests require explicit
 * categorization to prevent silent omissions.
 *
 * Usage:
 *   node tests/run-tests.js              # run all offline tests
 *   node tests/run-tests.js offline      # run offline tests
 *   node tests/run-tests.js validation   # run validation tests
 *   node tests/run-tests.js all          # run offline + validation
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const manifestPath = path.join(__dirname, 'test-manifest.json')

// Load manifest
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`❌ Failed to load test manifest: ${err.message}`)
  process.exit(1)
}

// Determine which suite to run
const suiteArg = process.argv[2] || 'offline'
const validSuites = ['offline', 'validation', 'all']

if (!validSuites.includes(suiteArg)) {
  console.error(`❌ Invalid suite: ${suiteArg}`)
  console.error(`   Valid options: ${validSuites.join(', ')}`)
  process.exit(1)
}

// Get test files to run
let testFiles = []
if (suiteArg === 'all') {
  testFiles = [...manifest.offline, ...manifest.validation]
} else {
  testFiles = manifest[suiteArg] || []
}

if (testFiles.length === 0) {
  console.error(`❌ No tests found for suite: ${suiteArg}`)
  process.exit(1)
}

console.log(`\n🧪 Running ${suiteArg} test suite (${testFiles.length} files)\n`)

// Run tests sequentially
let failedTests = []
let passedCount = 0

async function runTest(testFile) {
  const testPath = path.resolve(repoRoot, testFile)

  // Check if file exists
  if (!fs.existsSync(testPath)) {
    console.error(`⚠️  Test file not found: ${testFile}`)
    failedTests.push({ file: testFile, error: 'File not found' })
    return false
  }

  return new Promise((resolve) => {
    console.log(`▶️  Running: ${testFile}`)

    const child = spawn('node', [testPath], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    })

    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`✅ Passed: ${testFile}\n`)
        passedCount++
        resolve(true)
      } else {
        console.error(`❌ Failed: ${testFile} (exit code ${code})\n`)
        failedTests.push({ file: testFile, exitCode: code })
        resolve(false)
      }
    })

    child.on('error', (err) => {
      console.error(`❌ Error running ${testFile}: ${err.message}\n`)
      failedTests.push({ file: testFile, error: err.message })
      resolve(false)
    })
  })
}

// Run all tests
async function runAllTests() {
  for (const testFile of testFiles) {
    await runTest(testFile)
  }

  // Report summary
  console.log('\n' + '='.repeat(60))
  console.log(`Test Summary (${suiteArg} suite)`)
  console.log('='.repeat(60))
  console.log(`Total:  ${testFiles.length}`)
  console.log(`Passed: ${passedCount}`)
  console.log(`Failed: ${failedTests.length}`)

  if (failedTests.length > 0) {
    console.log('\n❌ Failed tests:')
    failedTests.forEach(({ file, exitCode, error }) => {
      const reason = error || `exit code ${exitCode}`
      console.log(`   - ${file} (${reason})`)
    })
    console.log('')
    process.exit(1)
  } else {
    console.log('\n✅ All tests passed!\n')
    process.exit(0)
  }
}

runAllTests().catch((err) => {
  console.error(`\n❌ Test runner error: ${err.message}\n`)
  process.exit(1)
})
