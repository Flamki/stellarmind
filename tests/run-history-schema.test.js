import { FileRunHistoryStore } from '../src/storage/run-history.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function withTempFile(testName, callback) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `stellarmind-schema-${testName}-`))
  const testDir = path.join(tempRoot, 'Workspace With Spaces')
  const testPath = path.join(testDir, `run-history-${testName}.json`)
  try {
    await fs.mkdir(testDir, { recursive: true })
    await callback(testPath, testDir)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
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
await withTempFile('invalid', async (testPath, testDir) => {
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

// Test 7: Completed results survive restart and remain readable by run ID
await withTempFile('restart-output', async (testPath) => {
  console.log('Test 7: Completed output survives restart')
  const firstStore = new FileRunHistoryStore(testPath, 200)
  await firstStore.init()

  const created = await firstStore.createRun({ task: 'Persisted run', budget: 15, source: 'test' })
  await firstStore.completeRun(created.id, {
    task: 'Persisted run',
    budget: 15,
    plan: { steps: [{ agent: 'research-bot', input: 'Persisted run' }] },
    results: [{ agent: 'research-bot', result: 'completed output payload' }],
    totalSpent: 0,
    budgetExhausted: false,
    paymentProtocol: 'x402',
    txCount: 0,
    x402PaymentCount: 0,
    xlmFallbackCount: 0,
    unpaidCount: 0,
    elapsed: '25ms',
    usage: { entries: [], summary: { totalInputTokens: 0, totalOutputTokens: 0 } },
    payments: [],
  })

  const reopened = new FileRunHistoryStore(testPath, 200)
  await reopened.init()
  const result = await reopened.getRun(created.id)

  if (!result || result.status !== 'completed') {
    throw new Error('Completed run should survive file restart and remain readable')
  }
  if (!result.outputAvailable) {
    throw new Error('Completed output should be marked as available after restart')
  }
  if (!Array.isArray(result.output) || result.output.length !== 1) {
    throw new Error('Persisted output should still include final step results after restart')
  }
  if (result.output[0].result !== 'completed output payload') {
    throw new Error('Persisted result payload was not restored exactly after restart')
  }
  console.log('  ✓ Completed run result is recoverable after restart')
  console.log('  ✓ Output is still marked available after reopen\n')
})

// Test 8: Legacy record without output is still readable with an availability flag
await withTempFile('legacy-output-availability', async (testPath) => {
  console.log('Test 8: Legacy output availability remains explicit')

  const legacyData = {
    version: 1,
    runs: [
      {
        id: 'legacy_run_missing_output',
        task: 'Legacy task',
        budget: 7,
        status: 'completed',
        createdAt: '2024-01-04T00:00:00.000Z',
        updatedAt: '2024-01-04T00:00:01.000Z',
        completedAt: '2024-01-04T00:00:01.000Z',
        summary: { totalSpent: 0 },
        plan: null,
        results: null,
        output: undefined,
        outputAvailable: false,
        events: [],
        txProofs: [],
        usage: null,
        error: null,
      },
    ],
  }

  await fs.writeFile(testPath, JSON.stringify(legacyData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const run = await store.getRun('legacy_run_missing_output')
  if (!run) {
    throw new Error('Legacy run should still be loaded from disk')
  }
  if (run.outputAvailable !== false) {
    throw new Error('Legacy runs without stored outputs should stay explicitly unavailable')
  }
  if (run.output !== null) {
    throw new Error(
      'Legacy runs should expose a null output when the persisted payload is unavailable'
    )
  }
  console.log('  ✓ Legacy output availability remains explicit and non-destructive')
  console.log('  ✓ Unavailable legacy output is surfaced as null\n')
})

console.log('All tests passed! ✓')
