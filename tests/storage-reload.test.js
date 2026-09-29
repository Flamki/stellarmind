/**
 * Temporary-file persistence and storage reload (Issue #176)
 *
 * The failure this pins down only appears on a *second* process: a run is
 * written, the process ends, and the next start has to find the same runs,
 * events, receipts and idempotency records again — from a path that may contain
 * spaces (Windows profile directories routinely do).
 *
 * Everything here uses a temporary directory created with `fs.mkdtemp` and
 * joined with `path.join`, so it runs on Windows and Linux with no shell
 * syntax, and it removes what it created even when a check fails.
 *
 * Point `STORAGE_RELOAD_DIR` at a directory to run the same checks inside it
 * (the cross-OS workflow uses a path containing spaces on purpose).
 *
 * Run: node tests/storage-reload.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileRunHistoryStore } from '../src/storage/run-history.js'

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message?.replace(/\n/g, '\n      ')}`)
  }
}

function completedResult(overrides = {}) {
  return {
    budget: 2,
    totalSpent: '0.25',
    budgetExhausted: false,
    paymentProtocol: 'x402',
    txCount: 1,
    elapsed: 1234,
    plan: 'research -> summary',
    results: [{ agentId: 'research-bot', cost: '0.25', output: 'ok' }],
    payments: [
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'cafebabe1234',
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/cafebabe1234',
      },
      { paymentSuccess: false, paidVia: 'x402', txHash: null },
    ],
    usage: { entries: [{ phase: 'research', totalTokens: 42 }] },
    ...overrides,
  }
}

const baseDir = process.env.STORAGE_RELOAD_DIR
  ? path.resolve(process.env.STORAGE_RELOAD_DIR)
  : os.tmpdir()
await fs.mkdir(baseDir, { recursive: true })

// A space in the directory *and* in the file name: paths like this break naive
// string concatenation and unquoted command lines.
const workDir = await fs.mkdtemp(path.join(baseDir, 'stellar mind storage '))
const historyFile = path.join(workDir, 'run history.json')

const cleanup = async () => {
  try {
    // `maxRetries` matters on Windows, where a just-closed handle can still hold
    // the file for a moment.
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (err) {
    console.error(`  ! could not remove ${workDir}: ${err.message}`)
  }
}

console.log(`\ntemporary-file persistence and storage reload (issue #176)`)
console.log(`  temporary directory: ${workDir}`)

async function freshStore(maxRuns = 200) {
  const store = new FileRunHistoryStore(historyFile, maxRuns)
  await store.init()
  return store
}

await test('a run survives a restart: id, task, events, receipts and totals reload', async () => {
  const first = await freshStore()
  const run = await first.createRun({ task: 'reload me', budget: 2, source: 'api' })
  await first.appendEvent(run.id, { type: 'agent_call', agentId: 'research-bot', stepId: 's1' })
  await first.appendEvent(run.id, { type: 'agent_response', agentId: 'research-bot', cost: '0.25' })
  await first.completeRun(run.id, completedResult())
  await first.flush()

  // A second process, same file: this is the reload under test.
  const second = await freshStore()
  const reloaded = await second.getRun(run.id)
  assert.ok(reloaded, 'the run is found after reload')
  assert.strictEqual(reloaded.task, 'reload me')
  assert.strictEqual(reloaded.status, 'completed')
  assert.strictEqual(reloaded.events.length, 2, 'recorded events survive')
  assert.strictEqual(reloaded.events[0].agentId, 'research-bot')
  assert.strictEqual(reloaded.events[0].type, 'agent_call')
  assert.strictEqual(reloaded.summary.totalSpent, '0.25')
  assert.strictEqual(reloaded.plan, 'research -> summary')
  assert.strictEqual(reloaded.outputAvailable, true)
  assert.strictEqual(reloaded.txProofs.length, 1, 'only successful payments become receipts')
  assert.strictEqual(reloaded.txProofs[0].txHash, 'cafebabe1234')
  assert.strictEqual(reloaded.txProofs[0].method, 'x402')
  assert.strictEqual((await second.listRecent(5))[0].id, run.id)
})

await test('idempotency records survive a restart', async () => {
  const store = await freshStore()
  const run = await store.createRun({
    task: 'idempotent work',
    budget: 1,
    idempotencyKey: 'key-abc',
    idempotencyFingerprint: 'fingerprint-1',
  })
  await store.flush()

  const reloaded = await freshStore()
  const record = await reloaded.getIdempotencyRecord('key-abc')
  assert.ok(record, 'the idempotency record is still there')
  assert.strictEqual(record.runId, run.id)
  assert.strictEqual(record.fingerprint, 'fingerprint-1')
  assert.strictEqual(await reloaded.getIdempotencyRecord('never-seen'), null)
})

await test('the file on disk is valid JSON with the runs it claims to hold', async () => {
  const raw = await fs.readFile(historyFile, 'utf8')
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed.runs), 'the file carries a runs array')
  assert.ok(parsed.runs.length >= 2)
  assert.ok(
    parsed.runs.every((entry) => typeof entry.id === 'string' && typeof entry.task === 'string'),
    'each stored run keeps its identity fields'
  )
})

await test('maxRuns trimming survives a restart', async () => {
  const trimDir = path.join(workDir, 'trimmed store')
  const trimFile = path.join(trimDir, 'run history.json')
  const store = new FileRunHistoryStore(trimFile, 2)
  await store.init()

  for (const task of ['one', 'two', 'three']) {
    await store.createRun({ task, budget: 1 })
  }
  await store.flush()

  const reloaded = new FileRunHistoryStore(trimFile, 2)
  await reloaded.init()
  const recent = await reloaded.listRecent(10)
  assert.strictEqual(recent.length, 2, 'the cap is applied when the file is written')
  assert.deepStrictEqual(
    recent.map((entry) => entry.task),
    ['three', 'two'],
    'the newest runs are the ones kept'
  )
})

await test('a corrupted history file is preserved and the store starts clean', async () => {
  const corruptFile = path.join(workDir, 'corrupt history.json')
  await fs.writeFile(corruptFile, '{"runs": [ this is not json', 'utf8')

  const store = new FileRunHistoryStore(corruptFile, 10)
  await store.init()
  assert.deepStrictEqual(await store.listRecent(5), [], 'a broken file does not resurrect runs')

  const entries = await fs.readdir(path.dirname(corruptFile))
  assert.ok(
    entries.some((name) => name.includes('corrupt')),
    `the damaged file is kept aside for inspection (saw: ${entries.join(', ')})`
  )

  const run = await store.createRun({ task: 'after corruption', budget: 1 })
  await store.flush()
  const reloaded = new FileRunHistoryStore(corruptFile, 10)
  await reloaded.init()
  assert.strictEqual((await reloaded.getRun(run.id)).task, 'after corruption')
})

await test('a missing history file is created, and a directory path is created for it', async () => {
  const nestedFile = path.join(workDir, 'nested dir', 'deeper dir', 'run history.json')
  const store = new FileRunHistoryStore(nestedFile, 5)
  await store.init()
  await store.createRun({ task: 'nested', budget: 1 })
  await store.flush()

  const stat = await fs.stat(nestedFile)
  assert.ok(stat.isFile(), 'the store created every directory on the way')
})

await test('concurrent writes leave a parseable file', async () => {
  const concurrentFile = path.join(workDir, 'concurrent history.json')
  const store = new FileRunHistoryStore(concurrentFile, 50)
  await store.init()

  const runs = await Promise.all(
    Array.from({ length: 10 }, (_, index) => store.createRun({ task: `task ${index}`, budget: 1 }))
  )
  await Promise.all(runs.map((run) => store.appendEvent(run.id, { type: 'agent_call' })))
  await store.flush()

  const parsed = JSON.parse(await fs.readFile(concurrentFile, 'utf8'))
  assert.strictEqual(parsed.runs.length, 10, 'no run was lost to a racing write')
})

await test('the temporary directory is removable and this test leaves nothing behind', async () => {
  await cleanup()
  const stillThere = await fs
    .stat(workDir)
    .then(() => true)
    .catch(() => false)
  assert.strictEqual(stillThere, false, `${workDir} should be gone`)
  console.log(`  (removed ${workDir})`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.error(`\ndiagnostics: history file was ${historyFile}`)
  for (const { name, err } of failures) console.error(`  - ${name}: ${err.message}`)
  process.exitCode = 1
} else {
  await cleanup()
}
