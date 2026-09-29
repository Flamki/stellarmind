import { FileRunHistoryStore } from '../src/storage/run-history.js'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Temporary directory (Issue #176): this suite used to write into
// `tests/fixtures`, which left corrupted-file copies behind in the working tree
// and made the suite unsafe to run in parallel. `os.tmpdir()` + `mkdtemp` is the
// portable form — no shell syntax, and nothing is left in the repository.
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-run-history-'))

async function withTempFile(testName, callback) {
  const testPath = path.join(testDir, `run-history-${testName}.json`)
  try {
    await callback(testPath)
  } finally {
    try {
      await fs.unlink(testPath)
    } catch {
      // Ignore if file doesn't exist
    }
  }
}

async function assertThrows(fn, message) {
  try {
    await fn()
    throw new Error(`Expected to throw: ${message}`)
  } catch (err) {
    if (!err.message.includes(message)) {
      throw new Error(`Expected error containing "${message}", got: ${err.message}`)
    }
  }
}

console.log('Testing run-history schema versioning...\n')

// Test 1: Legacy unversioned format migrates to version 1
await withTempFile('legacy', async (testPath) => {
  console.log('Test 1: Legacy unversioned format migration')
  const legacyData = {
    runs: [
      {
        id: 'run_1234567890_abc123',
        task: 'Test task',
        budget: 100,
        status: 'completed',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:01:00.000Z',
        events: [],
        txProofs: [],
      },
    ],
  }
  await fs.writeFile(testPath, JSON.stringify(legacyData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1, got ${parsed.version}`)
  }
  if (parsed.runs[0].id !== 'run_1234567890_abc123') {
    throw new Error('Run ID not preserved during migration')
  }
  console.log('  ✓ Legacy format migrated to version 1')
  console.log('  ✓ Run ID preserved: run_1234567890_abc123\n')
})

// Test 2: Current version 1 format loads without migration
await withTempFile('current', async (testPath) => {
  console.log('Test 2: Current version 1 format')
  const currentData = {
    version: 1,
    runs: [
      {
        id: 'run_9876543210_xyz789',
        task: 'Current task',
        budget: 200,
        status: 'running',
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        events: [],
        txProofs: [],
      },
    ],
  }
  await fs.writeFile(testPath, JSON.stringify(currentData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1, got ${parsed.version}`)
  }
  if (parsed.runs[0].id !== 'run_9876543210_xyz789') {
    throw new Error('Run ID not preserved')
  }
  console.log('  ✓ Version 1 format loaded without migration')
  console.log('  ✓ Run ID preserved: run_9876543210_xyz789\n')
})

// Test 3: Invalid JSON file is preserved and recovered
await withTempFile('invalid', async (testPath) => {
  console.log('Test 3: Invalid JSON file recovery')
  await fs.writeFile(testPath, '{ invalid json }', 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  // Check that corrupted file was preserved
  const corruptedFiles = await fs.readdir(testDir)
  const corruptedFile = corruptedFiles.find((f) => f.includes('invalid') && f.includes('corrupted'))

  if (!corruptedFile) {
    throw new Error('Corrupted file was not preserved')
  }

  // Check that new valid file was created
  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1 in new file, got ${parsed.version}`)
  }
  console.log('  ✓ Corrupted file preserved with .corrupted suffix')
  console.log('  ✓ New valid file created with version 1\n')
})

// Test 4: Future version fails without rewriting
await withTempFile('future', async (testPath) => {
  console.log('Test 4: Future version rejection')
  const futureData = {
    version: 999,
    runs: [],
  }
  await fs.writeFile(testPath, JSON.stringify(futureData, null, 2), 'utf8')

  await assertThrows(async () => {
    const store = new FileRunHistoryStore(testPath, 200)
    await store.init()
  }, 'Unsupported schema version 999')

  // Verify original file was not modified
  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 999) {
    throw new Error('Future version file was modified (should not rewrite)')
  }
  console.log('  ✓ Future version rejected with clear error')
  console.log('  ✓ Original file not modified\n')
})

// Test 5: Payment proofs preserved through migration
await withTempFile('payment-proofs', async (testPath) => {
  console.log('Test 5: Payment proofs preservation')
  const legacyData = {
    runs: [
      {
        id: 'run_payment_test',
        task: 'Payment test',
        budget: 50,
        status: 'completed',
        createdAt: '2024-01-03T00:00:00.000Z',
        updatedAt: '2024-01-03T00:05:00.000Z',
        events: [],
        txProofs: [
          {
            method: 'x402',
            txHash: 'abc123def456',
            explorerUrl: 'https://testnet.stellar.org/tx/abc123def456',
          },
          {
            method: 'xlm',
            txHash: 'xyz789uvw012',
            explorerUrl: 'https://testnet.stellar.org/tx/xyz789uvw012',
          },
        ],
      },
    ],
  }
  await fs.writeFile(testPath, JSON.stringify(legacyData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const runs = await store.listRecent()
  if (runs.length !== 1) {
    throw new Error(`Expected 1 run, got ${runs.length}`)
  }
  if (runs[0].txProofs.length !== 2) {
    throw new Error(`Expected 2 txProofs, got ${runs[0].txProofs.length}`)
  }
  if (runs[0].txProofs[0].txHash !== 'abc123def456') {
    throw new Error('First txHash not preserved')
  }
  if (runs[0].txProofs[1].txHash !== 'xyz789uvw012') {
    throw new Error('Second txHash not preserved')
  }
  console.log('  ✓ Payment proofs preserved through migration')
  console.log('  ✓ txHash 1: abc123def456')
  console.log('  ✓ txHash 2: xyz789uvw012\n')
})

// Test 6: New writes include version field
await withTempFile('new-write', async (testPath) => {
  console.log('Test 6: New writes include version field')
  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  await store.createRun({ task: 'New task', budget: 100, source: 'test' })

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1 in new write, got ${parsed.version}`)
  }
  if (parsed.runs.length !== 1) {
    throw new Error(`Expected 1 run, got ${parsed.runs.length}`)
  }
  console.log('  ✓ New writes include version field')
  console.log('  ✓ Version: 1\n')
})

// Cleanup must also happen when a check throws, so a failure does not leave the
// temporary directory (and the corrupted-file copies inside it) behind.
process.on('exit', () => {
  try {
    fsSync.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // Best effort; the OS clears its temp directory eventually.
  }
})

await fs.rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

console.log('All tests passed! ✓')
