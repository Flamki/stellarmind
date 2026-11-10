/**
 * Unit tests for active-run eviction protection and terminal event retention bounds (Issue #138).
 *
 * Covers:
 *  - Creating new runs never silently removes an active run, even when > maxRuns entries are created.
 *  - Finishing a long-lived active run retains its terminal record in deterministic order.
 *  - Over-capacity active work is rejected by explicit admission rules (ACTIVE_RUN_CAPACITY_EXCEEDED).
 *  - Truncated event history (by count or bytes) is marked while summary and txProofs remain available.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  InMemoryRunHistoryStore,
  FileRunHistoryStore,
  ActiveRunCapacityExceededError,
} from '../src/storage/run-history.js'

console.log('=== Issue #138: Active Run Retention & Event Bounds Tests ===')

// 1. Keep a run active while creating > maxRuns entries, then finish it and verify terminal record + event bounds
{
  const store = new InMemoryRunHistoryStore({
    maxRuns: 3,
    maxEventsPerRun: 4,
    maxEventBytesPerRun: 4096,
  })

  // Start long-lived active run
  const longActive = await store.createRun({
    task: 'Long-running research workflow',
    budget: 2,
    source: 'test',
  })

  // Append 7 events to longActive (exceeding maxEventsPerRun = 4)
  for (let i = 1; i <= 7; i++) {
    await store.appendEvent(longActive.id, {
      type: `step_event_${i}`,
      agentId: 'research-bot',
      cost: '0.01',
      timestamp: new Date(Date.now() + i * 10).toISOString(),
    })
  }

  // Create and complete 5 short runs (> maxRuns = 3) while longActive is still running
  const shortRunIds = []
  for (let i = 1; i <= 5; i++) {
    const shortRun = await store.createRun({
      task: `Short run ${i}`,
      budget: 1,
      source: 'test',
    })
    shortRunIds.push(shortRun.id)
    await store.completeRun(shortRun.id, {
      totalSpent: '0.01',
      budget: 1,
      payments: [
        {
          paymentSuccess: true,
          paidVia: 'x402',
          txHash: `tx-short-${i}`,
          settledAmount: '0.01',
          settledAsset: 'USDC',
        },
      ],
      results: [{ stepId: 'step-0', agentId: 'research-bot', output: `done ${i}` }],
    })
  }

  // Verify longActive is STILL present while status === 'running'
  const stillRunning = await store.getRun(longActive.id)
  assert.ok(stillRunning, 'Active run must never be evicted while new runs are created')
  assert.equal(stillRunning.status, 'running')

  // Now complete longActive after all 5 short runs
  await new Promise((r) => setTimeout(r, 5))
  await store.completeRun(longActive.id, {
    totalSpent: '0.06',
    quotedTotal: '0.06',
    settledTotals: [{ asset: 'USDC', amount: '0.06' }],
    settledSummary: '0.06 USDC',
    budget: 2,
    txCount: 2,
    x402PaymentCount: 2,
    xlmFallbackCount: 0,
    unpaidCount: 0,
    payments: [
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'tx-long-1',
        settledAmount: '0.01',
        settledAsset: 'USDC',
      },
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'tx-long-2',
        settledAmount: '0.05',
        settledAsset: 'USDC',
      },
    ],
    results: [{ stepId: 'step-0', agentId: 'analyst-bot', output: 'Final analysis output' }],
  })

  const completedLong = await store.getRun(longActive.id)
  assert.ok(completedLong, 'Completed long-lived run must be retained in terminal history')
  assert.equal(completedLong.status, 'completed')

  // Verify event bounds & truncation metadata while summary and txProofs remain intact
  assert.equal(completedLong.events.length, 4)
  assert.equal(completedLong.eventsTruncated, true)
  assert.equal(completedLong.droppedEventCount, 3)
  assert.equal(completedLong.eventRetention.truncated, true)
  assert.equal(completedLong.eventRetention.droppedEventCount, 3)
  assert.equal(completedLong.eventRetention.retainedEventCount, 4)
  assert.deepEqual(
    completedLong.events.map((e) => e.type),
    ['step_event_4', 'step_event_5', 'step_event_6', 'step_event_7']
  )

  // Summary and transaction proofs remain intact
  assert.equal(completedLong.summary.totalSpent, '0.06')
  assert.equal(completedLong.txProofs.length, 2)
  assert.equal(completedLong.txProofs[0].txHash, 'tx-long-1')
  assert.equal(completedLong.txProofs[1].txHash, 'tx-long-2')

  // Terminal retention kept exactly maxRuns (3): longActive (newest completed) + shortRun 5 + shortRun 4
  const retained = await store.listRecent(10)
  assert.equal(retained.length, 3)
  assert.equal(retained[0].id, longActive.id)
  assert.equal(retained[1].id, shortRunIds[4])
  assert.equal(retained[2].id, shortRunIds[3])

  console.log(
    '✓ Active run survived > maxRuns creations, retained on completion, and enforced event count bounds'
  )
}

// 2. Over-capacity active work is handled by explicit admission rules
{
  const store = new InMemoryRunHistoryStore({
    maxRuns: 5,
    maxActiveRuns: 2,
  })

  const active1 = await store.createRun({ task: 'Active 1', budget: 1 })
  const active2 = await store.createRun({ task: 'Active 2', budget: 1 })

  await assert.rejects(
    () => store.createRun({ task: 'Active 3 (over capacity)', budget: 1 }),
    (err) =>
      err instanceof ActiveRunCapacityExceededError &&
      err.code === 'ACTIVE_RUN_CAPACITY_EXCEEDED' &&
      err.status === 429
  )

  // Both existing active runs remain untouched
  assert.ok(await store.getRun(active1.id))
  assert.ok(await store.getRun(active2.id))

  // Completing one active run frees a slot for new admission
  await store.completeRun(active1.id, { totalSpent: '0.01', budget: 1, payments: [], results: [] })
  const active3 = await store.createRun({ task: 'Active 3 (now admitted)', budget: 1 })
  assert.ok(active3.id)

  console.log(
    '✓ Over-capacity active work rejected with explicit ACTIVE_RUN_CAPACITY_EXCEEDED error'
  )
}

// 3. Event byte limit enforcement + FileRunHistoryStore persistence
{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-138-'))
  const filePath = path.join(tmpDir, 'run-history.json')

  try {
    const fileStore = new FileRunHistoryStore(filePath, {
      maxRuns: 3,
      maxEventsPerRun: 50,
      maxEventBytesPerRun: 750,
    })
    await fileStore.init()

    const run = await fileStore.createRun({ task: 'Byte bound test', budget: 1 })
    for (let i = 1; i <= 10; i++) {
      await fileStore.appendEvent(run.id, {
        type: 'agent_response',
        agentId: 'research-bot',
        reason: `event-payload-${i}-${'X'.repeat(80)}`,
      })
    }
    await fileStore.completeRun(run.id, {
      totalSpent: '0.01',
      budget: 1,
      payments: [
        {
          paymentSuccess: true,
          paidVia: 'x402',
          txHash: 'tx-bytes',
          settledAmount: '0.01',
          settledAsset: 'USDC',
        },
      ],
      results: [{ stepId: 'step-0', output: 'ok' }],
    })

    // Reload from disk in a second FileRunHistoryStore instance
    const reloadedStore = new FileRunHistoryStore(filePath, {
      maxRuns: 3,
      maxEventsPerRun: 50,
      maxEventBytesPerRun: 750,
    })
    await reloadedStore.init()

    const loadedRun = await reloadedStore.getRun(run.id)
    assert.ok(loadedRun)
    assert.equal(loadedRun.eventsTruncated, true)
    assert.ok(loadedRun.droppedEventCount > 0)
    assert.ok(loadedRun.eventRetention.retainedEventBytes <= 750)
    assert.equal(loadedRun.txProofs.length, 1)
    assert.equal(loadedRun.txProofs[0].txHash, 'tx-bytes')

    console.log(
      '✓ Event byte limit and truncation metadata persisted and reloaded via FileRunHistoryStore'
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

console.log('=== All Issue #138 tests passed ===')
