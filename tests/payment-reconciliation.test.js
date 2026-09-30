/**
 * Run-history persistence + reconciliation of payment attempts (#131).
 *
 * `orchestrator` records one attempt per (run, step); this suite exercises the
 * storage layer that keeps them, because that is where "one logical charge,
 * one record" has to survive a restart:
 *
 *  - an attempt observed mid-run is persisted and stays visible while its
 *    outcome is unknown
 *  - a reconciliation pass resolves it in place (never appending a second
 *    attempt for the same run and step)
 *  - a file-backed store reloads the attempts, so a restart mid-reconciliation
 *    resumes on the same attempt instead of opening a new charge
 *
 * Dependency-free (node builtins only) and network-free:
 *   node tests/payment-reconciliation.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileRunHistoryStore, InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import {
  canAttemptFallback,
  createPaymentAttempt,
  markPaymentAttemptUnknown,
  paymentAttemptId,
} from '../src/agents/payment-attempts.js'

const failures = []
let passed = 0

function report(name, err) {
  failures.push({ name, err })
  console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
}

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    report(name, err)
  }
}

const RUN_STEP = {
  runId: 'run_placeholder',
  stepId: 'research-bot',
  amount: '0.01',
  currency: 'USDC',
}

/** Creates a run and returns `{ store, runId, attempt }` with one unknown attempt. */
async function seedUnknownAttempt(store) {
  const run = await store.createRun({ task: 'summarize stellar payments', budget: 0.15 })
  const attempt = markPaymentAttemptUnknown(
    createPaymentAttempt({ ...RUN_STEP, runId: run.id }),
    'transport_error'
  )
  await store.recordPaymentAttempt(run.id, attempt)
  return { runId: run.id, attempt }
}

async function main() {
  console.log('persisting an attempt whose outcome is unknown')

  await test('an unknown attempt is stored and reported as pending, not settled', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId, attempt } = await seedUnknownAttempt(store)

    const run = await store.getRun(runId)
    assert.strictEqual(run.paymentAttempts.length, 1)
    assert.strictEqual(run.paymentAttempts[0].id, attempt.id)
    assert.strictEqual(run.paymentAttempts[0].id, paymentAttemptId(runId, 'research-bot'))
    assert.deepStrictEqual(
      run.pendingPaymentAttempts.map((a) => a.id),
      [attempt.id]
    )
    assert.strictEqual(run.paymentAttemptSummary.unknown, 1)
    assert.strictEqual(run.paymentAttemptSummary.confirmed, 0)
  })

  await test('a settled charge is not left looking pending', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId } = await seedUnknownAttempt(store)
    const run = await store.getRun(runId)

    await store.recordPaymentAttempt(runId, {
      ...run.paymentAttempts[0],
      outcome: 'confirmed',
      txHash: 'tx_settled',
    })

    const updated = await store.getRun(runId)
    assert.strictEqual(updated.paymentAttempts.length, 1, 'still one logical charge')
    assert.deepStrictEqual(updated.pendingPaymentAttempts, [])
  })

  await test('recording an attempt for an unknown run is a no-op', async () => {
    const store = new InMemoryRunHistoryStore(10)
    assert.strictEqual(await store.recordPaymentAttempt('run_missing', { id: 'pay:x:y' }), null)
    assert.strictEqual(await store.recordPaymentAttempt('run_missing', null), null)
  })

  console.log('\nreconciliation')

  await test('a probe that confirms the earlier settlement resolves the attempt in place', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId, attempt } = await seedUnknownAttempt(store)

    const reconciled = await store.reconcilePendingPayments(async () => ({
      settled: true,
      txHash: 'tx_lost_response',
      proof: { source: 'horizon' },
    }))

    assert.strictEqual(reconciled.length, 1)
    assert.strictEqual(reconciled[0].id, attempt.id)
    assert.strictEqual(reconciled[0].outcome, 'confirmed')

    const run = await store.getRun(runId)
    assert.strictEqual(
      run.paymentAttempts.length,
      1,
      'a recovered settlement is not a second charge'
    )
    assert.strictEqual(run.paymentAttempts[0].txHash, 'tx_lost_response')
    assert.strictEqual(run.paymentAttempts[0].proof.source, 'horizon')
    assert.deepStrictEqual(run.pendingPaymentAttempts, [])
  })

  await test('an inconclusive probe leaves the attempt visibly pending', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId, attempt } = await seedUnknownAttempt(store)

    const reconciled = await store.reconcilePendingPayments(async () => ({ settled: 'unknown' }))

    assert.strictEqual(reconciled.length, 1)
    assert.strictEqual(reconciled[0].outcome, 'unknown')
    assert.strictEqual(reconciled[0].failureReason, 'reconciliation_inconclusive')

    const run = await store.getRun(runId)
    assert.deepStrictEqual(
      run.pendingPaymentAttempts.map((a) => a.id),
      [attempt.id]
    )
  })

  await test('a probe that positively finds no settlement permits the fallback', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId } = await seedUnknownAttempt(store)

    const reconciled = await store.reconcilePendingPayments(async () => ({ settled: false }))

    assert.strictEqual(reconciled[0].outcome, 'failed')
    assert.strictEqual(reconciled[0].failureReason, 'reconciled_not_settled')
    assert.strictEqual(canAttemptFallback(reconciled[0]), true)

    const run = await store.getRun(runId)
    assert.deepStrictEqual(run.pendingPaymentAttempts, [])
  })

  await test('a probe that throws cannot settle anything by accident', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId, attempt } = await seedUnknownAttempt(store)

    const reconciled = await store.reconcilePendingPayments(async () => {
      throw new Error('rpc unavailable')
    })

    assert.strictEqual(reconciled[0].outcome, 'unknown')
    assert.strictEqual(canAttemptFallback(reconciled[0]), false)

    const run = await store.getRun(runId)
    assert.strictEqual(run.pendingPaymentAttempts[0].id, attempt.id)
  })

  await test('reconciliation is scoped to one run when a runId is given', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const first = await seedUnknownAttempt(store)
    const second = await seedUnknownAttempt(store)

    const reconciled = await store.reconcilePendingPayments(async () => ({ settled: true }), {
      runId: second.runId,
    })

    assert.strictEqual(reconciled.length, 1)
    assert.strictEqual(reconciled[0].id, second.attempt.id)

    assert.deepStrictEqual((await store.getRun(first.runId)).pendingPaymentAttempts.length, 1)
    assert.deepStrictEqual((await store.getRun(second.runId)).pendingPaymentAttempts, [])
  })

  await test('the pending-payment view lists every unresolved charge', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const { runId } = await seedUnknownAttempt(store)

    const pending = await store.getPendingPayments()
    assert.strictEqual(pending.length, 1)
    assert.strictEqual(pending[0].runId, runId)
    assert.strictEqual(pending[0].task, 'summarize stellar payments')
    assert.strictEqual(pending[0].attempt.outcome, 'unknown')

    await store.reconcilePendingPayments(async () => ({ settled: true }))
    assert.deepStrictEqual(await store.getPendingPayments(), [])
  })

  console.log('\ncompleted runs and restarts')

  await test('completeRun persists the run attempts, keeping unknown ones pending', async () => {
    const store = new InMemoryRunHistoryStore(10)
    const run = await store.createRun({ task: 'mixed outcomes', budget: 0.15 })
    const unknown = markPaymentAttemptUnknown(
      createPaymentAttempt({ ...RUN_STEP, runId: run.id }),
      'transport_error'
    )
    const confirmed = {
      ...createPaymentAttempt({ ...RUN_STEP, runId: run.id, stepId: 'summary-bot' }),
      outcome: 'confirmed',
      txHash: 'tx_summary',
    }

    await store.completeRun(run.id, {
      totalSpent: '0.02',
      budget: 0.15,
      paymentProtocol: 'x402',
      txCount: 1,
      x402PaymentCount: 1,
      xlmFallbackCount: 0,
      unpaidCount: 0,
      elapsed: '10ms',
      results: [{ agentId: 'summary-bot' }],
      payments: [{ paymentSuccess: true, txHash: 'tx_summary', paidVia: 'x402' }],
      paymentAttempts: [unknown, confirmed],
    })

    const stored = await store.getRun(run.id)
    assert.strictEqual(stored.paymentAttempts.length, 2)
    assert.deepStrictEqual(
      stored.pendingPaymentAttempts.map((a) => a.id),
      [unknown.id]
    )
    assert.strictEqual(stored.paymentAttemptSummary.confirmed, 1)
    assert.strictEqual(stored.paymentAttemptSummary.unknown, 1)
    // Only the settled charge is a transaction proof — the unknown one must
    // never be counted as spend that already happened.
    assert.strictEqual(stored.txProofs.length, 1)
    assert.strictEqual(stored.summary.totalSpent, '0.02')
  })

  await test('a file-backed store resumes the same attempt after a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-payments-'))
    const file = path.join(dir, 'run-history.json')

    const first = new FileRunHistoryStore(file, 10)
    await first.init()
    const { runId, attempt } = await seedUnknownAttempt(first)
    await first.flush()

    // Simulate a process restart: a brand new store reading the same file.
    const reloaded = new FileRunHistoryStore(file, 10)
    await reloaded.init()

    const run = await reloaded.getRun(runId)
    assert.strictEqual(run.paymentAttempts.length, 1)
    assert.strictEqual(run.paymentAttempts[0].id, attempt.id)
    assert.strictEqual(run.pendingPaymentAttempts.length, 1)

    // The recovered settlement updates that same attempt, on the same file.
    const reconciled = await reloaded.reconcilePendingPayments(async () => ({
      settled: true,
      txHash: 'tx_after_restart',
    }))
    assert.strictEqual(reconciled.length, 1)
    await reloaded.flush()

    const second = new FileRunHistoryStore(file, 10)
    await second.init()
    const finalRun = await second.getRun(runId)
    assert.strictEqual(
      finalRun.paymentAttempts.length,
      1,
      'the restart did not open a second charge'
    )
    assert.strictEqual(finalRun.paymentAttempts[0].id, attempt.id)
    assert.strictEqual(finalRun.paymentAttempts[0].txHash, 'tx_after_restart')
    assert.deepStrictEqual(finalRun.pendingPaymentAttempts, [])

    await fs.rm(dir, { recursive: true, force: true })
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
