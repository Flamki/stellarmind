import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InMemoryRunHistoryStore,
  FileRunHistoryStore,
  createRunHistoryStore,
  INTERRUPTED_REASON_SERVER_RESTART,
} from '../src/storage/run-history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.join(__dirname, 'fixtures')

let failures = 0

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures++
      console.error(`  ✗ ${name}`)
      console.error(`    ${err.message}`)
    })
}

async function withTempFile(testName, callback) {
  const testPath = path.join(testDir, `run-history-recovery-${testName}.json`)
  try {
    await fs.mkdir(testDir, { recursive: true })
    await callback(testPath)
  } finally {
    await fs.unlink(testPath).catch(() => {})
  }
}

console.log('Testing run-history startup recovery (issue #139)...\n')

await test('marks a run left "running" as interrupted, with a timestamp and machine-readable reason', async () => {
  const store = new InMemoryRunHistoryStore()
  const run = await store.createRun({ task: 'do a thing', budget: 10 })
  assert.equal(run.status, 'running')

  const recoveredIds = await store.recoverInterruptedRuns()
  assert.deepEqual(recoveredIds, [run.id])

  const reloaded = await store.getRun(run.id)
  assert.equal(reloaded.status, 'interrupted')
  assert.equal(reloaded.interruptedReason, INTERRUPTED_REASON_SERVER_RESTART)
  assert.equal(typeof reloaded.interruptedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(reloaded.interruptedAt)))
})

await test('leaves completed and failed runs untouched', async () => {
  const store = new InMemoryRunHistoryStore()
  const completed = await store.createRun({ task: 'ok', budget: 10 })
  await store.completeRun(completed.id, { totalSpent: 1, budget: 10, results: [{ ok: true }] })

  const failed = await store.createRun({ task: 'bad', budget: 10 })
  await store.failRun(failed.id, new Error('boom'))

  const recoveredIds = await store.recoverInterruptedRuns()
  assert.deepEqual(recoveredIds, [])

  assert.equal((await store.getRun(completed.id)).status, 'completed')
  assert.equal((await store.getRun(failed.id)).status, 'failed')
})

await test('preserves existing events, results, plan, usage and txProofs on interrupted runs', async () => {
  const store = new InMemoryRunHistoryStore()
  const run = await store.createRun({ task: 'partial', budget: 10 })
  await store.appendEvent(run.id, {
    type: 'agent_payment',
    agent: 'research',
    paidVia: 'x402',
    txHash: 'deadbeef',
    status: 'success',
  })

  const before = await store.getRun(run.id)
  assert.equal(before.events.length, 1)

  await store.recoverInterruptedRuns()

  const after = await store.getRun(run.id)
  assert.equal(after.status, 'interrupted')
  // The pre-crash event survives, and a new recovery event is appended —
  // nothing is rewritten or dropped.
  assert.equal(after.events.length, 2)
  assert.equal(after.events[0].txHash, 'deadbeef')
  assert.equal(after.events[1].type, 'run_interrupted')
  assert.equal(after.events[1].reason, INTERRUPTED_REASON_SERVER_RESTART)
  assert.equal(after.plan, null)
  assert.equal(after.results, null)
  assert.deepEqual(after.txProofs, [])
})

await test('is idempotent across repeated recovery passes', async () => {
  const store = new InMemoryRunHistoryStore()
  const run = await store.createRun({ task: 'x', budget: 10 })

  const first = await store.recoverInterruptedRuns()
  const second = await store.recoverInterruptedRuns()

  assert.deepEqual(first, [run.id])
  assert.deepEqual(second, [])
  assert.equal((await store.getRun(run.id)).events.length, 1)
})

await test('FileRunHistoryStore persists recovered runs to disk immediately', async () => {
  await withTempFile('persist', async (testPath) => {
    const orphaned = {
      version: 1,
      runs: [
        {
          id: 'run_orphaned_1',
          task: 'never finished',
          budget: 25,
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:05.000Z',
          completedAt: null,
          summary: null,
          plan: { subtasks: [] },
          results: null,
          output: null,
          outputAvailable: false,
          error: null,
          events: [],
          txProofs: [],
          usage: null,
        },
      ],
      idempotency: [],
    }
    await fs.writeFile(testPath, JSON.stringify(orphaned, null, 2), 'utf8')

    const store = new FileRunHistoryStore(testPath, 200)
    await store.init()
    const recoveredIds = await store.recoverInterruptedRuns()
    assert.deepEqual(recoveredIds, ['run_orphaned_1'])

    const onDisk = JSON.parse(await fs.readFile(testPath, 'utf8'))
    assert.equal(onDisk.runs[0].status, 'interrupted')
    assert.equal(onDisk.runs[0].interruptedReason, INTERRUPTED_REASON_SERVER_RESTART)
  })
})

await test('createRunHistoryStore runs recovery automatically at startup', async () => {
  await withTempFile('factory', async (testPath) => {
    const orphaned = {
      version: 1,
      runs: [
        {
          id: 'run_orphaned_2',
          task: 'never finished either',
          budget: 25,
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:05.000Z',
          events: [],
          txProofs: [],
        },
      ],
      idempotency: [],
    }
    await fs.writeFile(testPath, JSON.stringify(orphaned, null, 2), 'utf8')

    const store = await createRunHistoryStore({
      runHistoryStorage: 'file',
      runHistoryFile: testPath,
      runHistoryMaxRuns: 200,
    })

    const run = await store.getRun('run_orphaned_2')
    assert.equal(run.status, 'interrupted')
  })
})

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`)
  process.exit(1)
}
console.log('\nAll tests passed! ✓')
