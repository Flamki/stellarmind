/**
 * Windows Compatibility Tests (#176)
 *
 * Tests cross-platform concerns:
 * - Paths with spaces
 * - Temporary directory handling
 * - File path normalization
 * - Line ending handling
 * - Child process cleanup
 *
 * Run: node tests/windows-compatibility.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { FileRunHistoryStore } from '../src/storage/run-history.js'

console.log('🪟 Testing Windows compatibility...\n')
console.log(`Platform: ${process.platform}`)
console.log(`OS: ${os.type()} ${os.release()}`)
console.log(`Temp dir: ${os.tmpdir()}\n`)

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`✅ ${name}`)
      passed++
    })
    .catch((err) => {
      console.error(`❌ ${name}`)
      console.error(`   ${err.message}`)
      failed++
    })
}

// Test 1: Handle temporary directory with spaces
await test('Temporary directory with spaces', async () => {
  // Create a temp directory with spaces in the path
  const baseTemp = os.tmpdir()
  const tempWithSpaces = path.join(baseTemp, `stellarmind test ${Date.now()}`)

  await fs.mkdir(tempWithSpaces, { recursive: true })

  try {
    const testFile = path.join(tempWithSpaces, 'test-file.json')
    const testData = { test: 'data with spaces in path', timestamp: Date.now() }

    // Write file
    await fs.writeFile(testFile, JSON.stringify(testData, null, 2), 'utf8')

    // Read file back
    const content = await fs.readFile(testFile, 'utf8')
    const parsed = JSON.parse(content)

    assert.strictEqual(parsed.test, testData.test, 'Should read/write to path with spaces')
  } finally {
    // Cleanup
    await fs.rm(tempWithSpaces, { recursive: true, force: true })
  }
})

// Test 2: Path normalization across platforms
await test('Path normalization', () => {
  const testPath = path.join('src', 'agents', 'orchestrator.js')

  // Should work regardless of platform separator
  assert.ok(testPath.includes('orchestrator.js'), 'Path should contain filename')

  // Normalized paths should be consistent
  const normalized = path.normalize(testPath)
  assert.ok(normalized.length > 0, 'Normalized path should not be empty')

  // Resolve should work
  const resolved = path.resolve(testPath)
  assert.ok(path.isAbsolute(resolved), 'Resolved path should be absolute')
})

// Test 3: File storage in temporary directory
await test('File storage with temporary directory', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-storage-'))

  try {
    const historyFile = path.join(tempDir, 'run-history.json')
    const store = new FileRunHistoryStore(historyFile)
    await store.init() // Initialize the store

    // Create a run
    const run = await store.createRun({
      task: 'Test task for Windows compatibility',
      budget: 0.1,
      source: 'compatibility-test',
    })

    assert.ok(run.id, 'Should create run with ID')

    // Complete the run
    await store.completeRun(run.id, {
      results: [{ agentId: 'test', output: 'Test output' }],
      totalSpent: '0.05',
      agentsUsed: 1,
    })

    // Verify file was created
    const fileExists = await fs
      .access(historyFile)
      .then(() => true)
      .catch(() => false)
    assert.ok(fileExists, 'History file should exist')

    // Create new store instance to test persistence
    const store2 = new FileRunHistoryStore(historyFile)
    await store2.init() // Initialize to load existing data

    // List runs to verify reload
    const runs = await store2.listRecent(10)
    assert.ok(runs.length > 0, 'Should have at least one run')

    const retrieved = runs.find((r) => r.id === run.id)
    assert.ok(retrieved, 'Should retrieve run from new store instance')
    assert.strictEqual(retrieved.id, run.id, 'Retrieved run should have same ID')
    assert.strictEqual(retrieved.status, 'completed', 'Run should be completed')
  } finally {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

// Test 4: Handle line endings (CRLF vs LF)
await test('Line ending handling', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-lineends-'))

  try {
    const testFile = path.join(tempDir, 'line-endings.txt')

    // Write with explicit line endings
    const textWithLF = 'line1\nline2\nline3'
    const textWithCRLF = 'line1\r\nline2\r\nline3'

    await fs.writeFile(testFile, textWithLF, 'utf8')
    const readBackLF = await fs.readFile(testFile, 'utf8')

    await fs.writeFile(testFile, textWithCRLF, 'utf8')
    const readBackCRLF = await fs.readFile(testFile, 'utf8')

    // Should handle both
    assert.ok(readBackLF.includes('line2'), 'Should read LF line endings')
    assert.ok(readBackCRLF.includes('line2'), 'Should read CRLF line endings')
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

// Test 5: Child process spawn and cleanup
await test('Child process spawn and cleanup', async () => {
  return new Promise((resolve, reject) => {
    // Spawn a simple Node process that exits quickly
    const child = spawn(process.execPath, ['-e', 'console.log("test"); process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Child process did not exit within timeout'))
    }, 5000)

    child.on('exit', (code) => {
      clearTimeout(timeout)

      try {
        assert.strictEqual(code, 0, 'Child should exit with code 0')
        assert.ok(output.includes('test'), 'Should capture child output')
        resolve()
      } catch (err) {
        reject(err)
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
})

// Test 6: Multiple concurrent file operations
await test('Concurrent file operations', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-concurrent-'))

  try {
    const historyFile = path.join(tempDir, 'concurrent-history.json')
    const store = new FileRunHistoryStore(historyFile)
    await store.init() // Initialize the store

    // Create multiple runs concurrently
    const runs = await Promise.all([
      store.createRun({ task: 'Task 1', budget: 0.1, source: 'test' }),
      store.createRun({ task: 'Task 2', budget: 0.1, source: 'test' }),
      store.createRun({ task: 'Task 3', budget: 0.1, source: 'test' }),
    ])

    assert.strictEqual(runs.length, 3, 'Should create 3 runs')

    // All should have unique IDs
    const ids = new Set(runs.map((r) => r.id))
    assert.strictEqual(ids.size, 3, 'All runs should have unique IDs')

    // Complete them concurrently
    await Promise.all(
      runs.map((run) =>
        store.completeRun(run.id, {
          results: [{ agentId: 'test', output: 'Output' }],
          totalSpent: '0.05',
          agentsUsed: 1,
        })
      )
    )

    // Verify all completed
    const retrieved = await Promise.all(runs.map((run) => store.getRun(run.id)))

    assert.ok(
      retrieved.every((r) => r.status === 'completed'),
      'All runs should be completed'
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

// Test 7: Storage reload after simulated crash
await test('Storage reload after simulated crash', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-crash-'))

  try {
    const historyFile = path.join(tempDir, 'crash-recovery.json')

    // Create store and add runs
    const store1 = new FileRunHistoryStore(historyFile)
    await store1.init() // Initialize

    const run1 = await store1.createRun({
      task: 'Task before crash',
      budget: 0.1,
      source: 'crash-test',
    })

    await store1.completeRun(run1.id, {
      results: [{ agentId: 'test', output: 'Output' }],
      totalSpent: '0.05',
      agentsUsed: 1,
    })

    // Verify file exists before creating new store
    const fileExists = await fs
      .access(historyFile)
      .then(() => true)
      .catch(() => false)
    assert.ok(fileExists, 'History file should exist before crash simulation')

    // Simulate crash by creating new store instance
    const store2 = new FileRunHistoryStore(historyFile)
    await store2.init() // Initialize to reload existing data

    // List runs to verify reload
    const runs = await store2.listRecent(10)
    assert.ok(runs.length > 0, 'Should reload runs after crash')

    const reloaded = runs.find((r) => r.id === run1.id)
    assert.ok(reloaded, 'Should find the original run')
    assert.strictEqual(reloaded.status, 'completed', 'Reloaded run should have correct status')
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

// Test 8: Handle special characters in filenames
await test('Special characters in filenames', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-special-'))

  try {
    // Test various special characters that are valid across platforms
    const testFile = path.join(tempDir, 'test-file_123.json')
    const data = { test: 'special chars' }

    await fs.writeFile(testFile, JSON.stringify(data), 'utf8')
    const content = await fs.readFile(testFile, 'utf8')
    const parsed = JSON.parse(content)

    assert.strictEqual(parsed.test, data.test, 'Should handle special chars in filename')
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

// Summary
console.log('\n' + '='.repeat(50))
console.log('Windows Compatibility Tests')
console.log('='.repeat(50))
console.log(`Platform: ${process.platform}`)
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)

if (failed > 0) {
  console.log('\n❌ Windows compatibility tests failed\n')
  process.exit(1)
} else {
  console.log('\n✅ All Windows compatibility tests passed\n')
  process.exit(0)
}
