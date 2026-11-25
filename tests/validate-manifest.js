#!/usr/bin/env node
/**
 * Validate test manifest completeness (#175)
 *
 * Ensures every .test.js file is explicitly categorized in the manifest,
 * preventing newly added tests from being silently omitted from CI.
 *
 * Usage: node tests/validate-manifest.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const manifestPath = path.join(__dirname, 'test-manifest.json')

console.log('🔍 Validating test manifest...\n')

// Load manifest
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`❌ Failed to load manifest: ${err.message}`)
  process.exit(1)
}

// Find all test files using git ls-files to respect .gitignore
let allTestFilesRaw
try {
  allTestFilesRaw = execSync('git ls-files "*.test.js"', {
    cwd: repoRoot,
    encoding: 'utf8',
  })
} catch (err) {
  console.error(`❌ Failed to list test files: ${err.message}`)
  process.exit(1)
}

const allTestFiles = allTestFilesRaw
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .sort()

// Get all categorized files from manifest
const categorizedFiles = new Set([
  ...(manifest.offline || []),
  ...(manifest.validation || []),
  ...(manifest.optin || []),
])

// Find uncategorized tests
const uncategorized = allTestFiles.filter((file) => !categorizedFiles.has(file))

// Find categorized files that don't exist
const missingFiles = Array.from(categorizedFiles).filter((file) => {
  return !fs.existsSync(path.resolve(repoRoot, file))
})

// Report results
let hasErrors = false

if (uncategorized.length > 0) {
  hasErrors = true
  console.error('❌ Uncategorized test files found:\n')
  uncategorized.forEach((file) => {
    console.error(`   - ${file}`)
  })
  console.error('\nAdd these files to tests/test-manifest.json under:')
  console.error('  - "offline" for regression tests')
  console.error('  - "validation" for API validation tests')
  console.error('  - "optin" for demo/load tests\n')
}

if (missingFiles.length > 0) {
  hasErrors = true
  console.error('❌ Manifest references missing files:\n')
  missingFiles.forEach((file) => {
    console.error(`   - ${file}`)
  })
  console.error('\nRemove these from tests/test-manifest.json\n')
}

if (!hasErrors) {
  console.log('✅ All test files are properly categorized')
  console.log(`   Total: ${allTestFiles.length} test files`)
  console.log(`   Offline: ${manifest.offline?.length || 0}`)
  console.log(`   Validation: ${manifest.validation?.length || 0}`)
  console.log(`   Opt-in: ${manifest.optin?.length || 0}`)
  console.log('')
  process.exit(0)
} else {
  process.exit(1)
}
