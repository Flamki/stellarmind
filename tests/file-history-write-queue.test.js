/**
 * Unit tests for serialized file-history writes and pending-event draining (Issue #135).
 *
 * Covers:
 *  - Concurrent appends cannot race on temporary files and execute sequentially.
 *  - Run completion drains and persists all earlier accepted events before completing.
 *  - A failed write is visible to the caller and does not permanently stall later writes.
 *  - Reloading from disk preserves complete event order and terminal summaries.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileRunHistoryStore } from '../src/storage/run-history.js'

console.log('=== Issue #135: File-History Write Queue & Event Drain Tests ===')

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-135-'))
const filePath = path.join(tmpDir, 'run-history.json')

try {
  const seenTempPaths = new Set()
  let activeWrites = 0
  let maxConcurrentWrites = 0
  let failOnWriteNumber = -1
  let writeCount = 0

  const store = new FileRunHistoryStore(filePath, 200, {
    writeFileFn: async (targetPath, data, enc) => {
      seenTempPaths.add(targetPath)
      activeWrites += 1
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
      writeCount += 1
      const currentWrite = writeCount
      try {
        // Small jittered delay to amplify any potential race if writes were not serialized
        await new Promise((r) => setTimeout(r, (currentWrite % 3) + 1))
        if (currentWrite === failOnWriteNumber) {
          const err = new Error('Simulated disk write failure (ENOSPC)')
          err.code = 'ENOSPC'
          throw err
        }
        await fs.writeFile(targetPath, data, enc)
      } finally {
        activeWrites -= 1
      }
    },
  })

  await store.init()

  const runA = await store.createRun({ task: 'Interleaved Run A', budget: 1, source: 'test' })
  const runB = await store.createRun({ task: 'Interleaved Run B', budget: 2, source: 'test' })

  // 1. Fire-and-forget many interleaved appendEvent calls without awaiting each one
  for (let i = 1; i <= 12; i++) {
    // Intentionally NOT awaited here to simulate synchronous broadcast callbacks
    store.appendEvent(runA.id, {
      type: `runA_evt_${i}`,
      agentId: 'research-bot',
      timestamp: new Date(1700000000000 + i * 100).toISOString(),
    })
    store.appendEvent(runB.id, {
      type: `runB_evt_${i}`,
      agentId: 'analyst-bot',
      timestamp: new Date(1700000000000 + i * 100 + 50).toISOString(),
    })
  }

  // Complete both runs immediately while fire-and-forget appendEvent calls are still queued
  await Promise.all([
    store.completeRun(runA.id, {
      totalSpent: '0.02',
      budget: 1,
      payments: [
        {
          paymentSuccess: true,
          paidVia: 'x402',
          txHash: 'tx-A',
          settledAmount: '0.02',
          settledAsset: 'USDC',
        },
      ],
      results: [{ stepId: 'step-0', output: 'Run A output' }],
    }),
    store.completeRun(runB.id, {
      totalSpent: '0.05',
      budget: 2,
      payments: [
        {
          paymentSuccess: true,
          paidVia: 'x402',
          txHash: 'tx-B',
          settledAmount: '0.05',
          settledAsset: 'USDC',
        },
      ],
      results: [{ stepId: 'step-0', output: 'Run B output' }],
    }),
  ])

  assert.equal(
    maxConcurrentWrites,
    1,
    'Write queue must serialize all file writes (concurrency === 1)'
  )
  assert.equal(
    seenTempPaths.size,
    writeCount,
    'Every write must use a distinct temporary file path'
  )

  // 2. Inject a write failure on the next write and verify caller visibility + queue recovery
  failOnWriteNumber = writeCount + 1
  await assert.rejects(
    () =>
      store.appendEvent(runA.id, {
        type: 'runA_evt_13_failed_write',
        agentId: 'summary-bot',
      }),
    (err) => err.code === 'ENOSPC' && err.message.includes('Simulated disk write failure')
  )

  // Subsequent write must NOT be stalled by the earlier failed write
  await store.appendEvent(runB.id, {
    type: 'runB_evt_13_recovered',
    agentId: 'code-bot',
    timestamp: new Date(1700000005000).toISOString(),
  })

  await store.flush()

  // Verify no leftover .tmp files remain in the directory
  const filesOnDisk = await fs.readdir(tmpDir)
  assert.deepEqual(filesOnDisk, ['run-history.json'])

  // 3. Reload store from disk and verify complete event order and terminal summaries
  const reloaded = new FileRunHistoryStore(filePath, 200)
  await reloaded.init()

  const loadedA = await reloaded.getRun(runA.id)
  const loadedB = await reloaded.getRun(runB.id)

  assert.ok(loadedA)
  assert.equal(loadedA.status, 'completed')
  assert.equal(loadedA.summary.totalSpent, '0.02')
  assert.equal(loadedA.txProofs[0].txHash, 'tx-A')
  assert.deepEqual(
    loadedA.events.slice(0, 12).map((e) => e.type),
    Array.from({ length: 12 }, (_, idx) => `runA_evt_${idx + 1}`)
  )

  assert.ok(loadedB)
  assert.equal(loadedB.status, 'completed')
  assert.equal(loadedB.summary.totalSpent, '0.05')
  assert.equal(loadedB.txProofs[0].txHash, 'tx-B')
  assert.deepEqual(
    loadedB.events.map((e) => e.type),
    [...Array.from({ length: 12 }, (_, idx) => `runB_evt_${idx + 1}`), 'runB_evt_13_recovered']
  )

  console.log('✓ Concurrent appends serialized with unique .tmp files')
  console.log('✓ Pending events drained before run completion')
  console.log('✓ Failed write surfaced to caller without stalling subsequent writes')
  console.log('✓ Reload preserved exact event ordering and terminal summaries')
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true })
}

console.log('=== All Issue #135 tests passed ===')
