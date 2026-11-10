/**
 * Unit and HTTP integration tests for run history cursor pagination and filters (Issue #141).
 *
 * Covers:
 *  - Deterministic (createdAt DESC, id DESC) ordering including tied timestamps.
 *  - Inserting a new run between page requests does not duplicate older entries.
 *  - Status and date range filters compose consistently with cursor pagination.
 *  - Lightweight list summaries omit full event arrays while GET /api/runs/:id returns full detail.
 *  - Invalid cursors and filter values return structured 400 validation errors.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import {
  InMemoryRunHistoryStore,
  encodeRunCursor,
  decodeRunCursor,
} from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'

console.log('=== Issue #141: Run History Cursor Pagination & Filters Tests ===')

function seedFixtureStore() {
  const store = new InMemoryRunHistoryStore(200)
  // Seed 6 runs, including two with identical timestamps ('2026-03-10T12:00:00.000Z')
  const fixtures = [
    {
      id: 'run_1001_aaaa',
      task: 'Oldest completed run',
      budget: 1,
      source: 'test',
      status: 'completed',
      createdAt: '2026-03-10T10:00:00.000Z',
      updatedAt: '2026-03-10T10:01:00.000Z',
      completedAt: '2026-03-10T10:01:00.000Z',
      summary: { totalSpent: '0.01', txCount: 1 },
      results: [{ stepId: 'step-0', agentId: 'research-bot', output: 'x'.repeat(2000) }],
      output: [{ stepId: 'step-0', agentId: 'research-bot', output: 'x'.repeat(2000) }],
      events: Array.from({ length: 25 }, (_, i) => ({
        type: 'agent_call',
        timestamp: `2026-03-10T10:00:${String(i).padStart(2, '0')}.000Z`,
      })),
      txProofs: [{ txHash: 'tx-1001', amount: '0.01', asset: 'USDC' }],
    },
    {
      id: 'run_1002_bbbb',
      task: 'Failed run before noon',
      budget: 1,
      source: 'test',
      status: 'failed',
      createdAt: '2026-03-10T11:00:00.000Z',
      updatedAt: '2026-03-10T11:01:00.000Z',
      completedAt: '2026-03-10T11:01:00.000Z',
      summary: { error: 'Upstream failure' },
      error: { message: 'Upstream failure', code: 'EXECUTION_FAILED' },
      results: [],
      output: null,
      events: [{ type: 'orchestrator_start', timestamp: '2026-03-10T11:00:00.000Z' }],
      txProofs: [],
    },
    {
      id: 'run_1003_aaaa',
      task: 'Tied noon run A (lower id)',
      budget: 1,
      source: 'test',
      status: 'completed',
      createdAt: '2026-03-10T12:00:00.000Z',
      updatedAt: '2026-03-10T12:01:00.000Z',
      completedAt: '2026-03-10T12:01:00.000Z',
      summary: { totalSpent: '0.02', txCount: 2 },
      results: [{ stepId: 'step-0', output: 'noon A' }],
      output: [{ stepId: 'step-0', output: 'noon A' }],
      events: [{ type: 'orchestrator_start', timestamp: '2026-03-10T12:00:00.000Z' }],
      txProofs: [],
    },
    {
      id: 'run_1003_zzzz',
      task: 'Tied noon run Z (higher id)',
      budget: 1,
      source: 'test',
      status: 'completed',
      createdAt: '2026-03-10T12:00:00.000Z',
      updatedAt: '2026-03-10T12:01:00.000Z',
      completedAt: '2026-03-10T12:01:00.000Z',
      summary: { totalSpent: '0.03', txCount: 1 },
      results: [{ stepId: 'step-0', output: 'noon Z' }],
      output: [{ stepId: 'step-0', output: 'noon Z' }],
      events: [{ type: 'orchestrator_start', timestamp: '2026-03-10T12:00:00.000Z' }],
      txProofs: [],
    },
    {
      id: 'run_1004_cccc',
      task: 'Afternoon completed run',
      budget: 2,
      source: 'test',
      status: 'completed',
      createdAt: '2026-03-10T13:00:00.000Z',
      updatedAt: '2026-03-10T13:02:00.000Z',
      completedAt: '2026-03-10T13:02:00.000Z',
      summary: { totalSpent: '0.05', txCount: 1 },
      results: [{ stepId: 'step-0', output: 'afternoon' }],
      output: [{ stepId: 'step-0', output: 'afternoon' }],
      events: [{ type: 'orchestrator_start', timestamp: '2026-03-10T13:00:00.000Z' }],
      txProofs: [],
    },
    {
      id: 'run_1005_dddd',
      task: 'Active running run',
      budget: 2,
      source: 'test',
      status: 'running',
      createdAt: '2026-03-10T14:00:00.000Z',
      updatedAt: '2026-03-10T14:00:00.000Z',
      completedAt: null,
      summary: null,
      results: null,
      output: null,
      events: [{ type: 'orchestrator_start', timestamp: '2026-03-10T14:00:00.000Z' }],
      txProofs: [],
    },
  ]

  // Insert in scrambled order to verify deterministic sorting
  store.runs = [fixtures[2], fixtures[0], fixtures[5], fixtures[3], fixtures[1], fixtures[4]]
  return store
}

// 1. Deterministic ordering with tied timestamps + concurrent insertion stability
{
  const store = seedFixtureStore()

  // Page 1 (limit 2): should return run_1005_dddd (14:00) and run_1004_cccc (13:00)
  const page1 = await store.listRuns({ limit: 2 })
  assert.deepEqual(
    page1.runs.map((r) => r.id),
    ['run_1005_dddd', 'run_1004_cccc']
  )
  assert.equal(page1.hasMore, true)
  assert.ok(page1.nextCursor)

  // Insert a brand-new run at the top (15:00) BEFORE fetching page 2
  store.runs.unshift({
    id: 'run_1006_eeee',
    task: 'Newly inserted run between pages',
    budget: 1,
    source: 'test',
    status: 'running',
    createdAt: '2026-03-10T15:00:00.000Z',
    updatedAt: '2026-03-10T15:00:00.000Z',
    completedAt: null,
    summary: null,
    results: null,
    output: null,
    events: [],
    txProofs: [],
  })

  // Page 2 (limit 2): must NOT duplicate run_1004_cccc and must order tied 12:00 runs by id DESC
  const page2 = await store.listRuns({ limit: 2, cursor: page1.nextCursor })
  assert.deepEqual(
    page2.runs.map((r) => r.id),
    ['run_1003_zzzz', 'run_1003_aaaa']
  )
  assert.equal(page2.hasMore, true)
  assert.ok(page2.nextCursor)

  // Also test splitting directly across the tied 12:00 timestamp with limit=1
  const tieSplitPageA = await store.listRuns({ limit: 1, cursor: page1.nextCursor })
  assert.deepEqual(
    tieSplitPageA.runs.map((r) => r.id),
    ['run_1003_zzzz']
  )
  const tieSplitPageB = await store.listRuns({ limit: 1, cursor: tieSplitPageA.nextCursor })
  assert.deepEqual(
    tieSplitPageB.runs.map((r) => r.id),
    ['run_1003_aaaa']
  )

  // Page 3 (terminal page, limit 2): should return run_1002_bbbb (11:00) and run_1001_aaaa (10:00)
  const page3 = await store.listRuns({ limit: 2, cursor: page2.nextCursor })
  assert.deepEqual(
    page3.runs.map((r) => r.id),
    ['run_1002_bbbb', 'run_1001_aaaa']
  )
  assert.equal(page3.hasMore, false)
  assert.equal(page3.nextCursor, null)

  console.log(
    '✓ Cursor pagination is deterministic across tied timestamps and immune to concurrent insertions'
  )
}

// 2. Status and date filters compose consistently with cursor pagination
{
  const store = seedFixtureStore()

  // Filter status=completed and createdAfter=11:30, createdBefore=13:30 -> matches 3 runs: 1004, 1003_zzzz, 1003_aaaa
  const filteredPage1 = await store.listRuns({
    limit: 2,
    status: 'completed',
    createdAfter: '2026-03-10T11:30:00.000Z',
    createdBefore: '2026-03-10T13:30:00.000Z',
  })
  assert.equal(filteredPage1.totalMatching, 3)
  assert.deepEqual(
    filteredPage1.runs.map((r) => r.id),
    ['run_1004_cccc', 'run_1003_zzzz']
  )
  assert.equal(filteredPage1.hasMore, true)

  const filteredPage2 = await store.listRuns({
    limit: 2,
    status: 'completed',
    createdAfter: '2026-03-10T11:30:00.000Z',
    createdBefore: '2026-03-10T13:30:00.000Z',
    cursor: filteredPage1.nextCursor,
  })
  assert.deepEqual(
    filteredPage2.runs.map((r) => r.id),
    ['run_1003_aaaa']
  )
  assert.equal(filteredPage2.hasMore, false)
  assert.equal(filteredPage2.nextCursor, null)

  console.log('✓ Status and date range filters compose cleanly with cursor pagination')
}

// 3. Lightweight list summaries vs full detail retrieval + HTTP 400 validation errors
{
  const store = seedFixtureStore()
  const app = express()
  app.use(requestId)
  app.use(express.json())
  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: async () => ({ results: [] }),
  })
  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // Verify list endpoint omits full events and output arrays, keeping payload compact
    const listRes = await fetch(`${baseUrl}/api/runs?limit=6`)
    assert.equal(listRes.status, 200)
    const listBody = await listRes.json()
    const summary1001 = listBody.runs.find((r) => r.id === 'run_1001_aaaa')
    assert.ok(summary1001)
    assert.equal(summary1001.eventCount, 25)
    assert.equal(summary1001.stepCount, 1)
    assert.equal(
      'events' in summary1001,
      false,
      'List summary must omit full events array by default'
    )
    assert.equal(
      'output' in summary1001,
      false,
      'List summary must omit full output array by default'
    )
    assert.equal(
      'results' in summary1001,
      false,
      'List summary must omit full results array by default'
    )

    // Verify detail endpoint GET /api/runs/:id still returns full events and output
    const detailRes = await fetch(`${baseUrl}/api/runs/run_1001_aaaa`)
    assert.equal(detailRes.status, 200)
    const detailBody = await detailRes.json()
    assert.equal(Array.isArray(detailBody.events), true)
    assert.equal(detailBody.events.length, 25)
    assert.equal(Array.isArray(detailBody.output), true)
    assert.equal(detailBody.output.length, 1)
    assert.ok(
      JSON.stringify(summary1001).length < JSON.stringify(detailBody).length / 4,
      'List summary payload should be dramatically smaller than full run detail'
    )

    // Verify invalid cursor returns 400 INVALID_CURSOR
    const badCursorRes = await fetch(`${baseUrl}/api/runs?cursor=not_a_valid_cursor!`)
    assert.equal(badCursorRes.status, 400)
    const badCursorBody = await badCursorRes.json()
    assert.equal(badCursorBody.code, 'INVALID_CURSOR')
    assert.equal(Array.isArray(badCursorBody.details), true)

    // Verify invalid status returns 400 INVALID_FILTER
    const badStatusRes = await fetch(`${baseUrl}/api/runs?status=nonexistent_status`)
    assert.equal(badStatusRes.status, 400)
    const badStatusBody = await badStatusRes.json()
    assert.equal(badStatusBody.code, 'INVALID_FILTER')

    // Verify invalid date returns 400 INVALID_FILTER
    const badDateRes = await fetch(`${baseUrl}/api/runs?createdAfter=not-a-date`)
    assert.equal(badDateRes.status, 400)
    const badDateBody = await badDateRes.json()
    assert.equal(badDateBody.code, 'INVALID_FILTER')

    // Verify inverted date range (createdAfter > createdBefore) returns 400 INVALID_FILTER
    const invertedDateRes = await fetch(
      `${baseUrl}/api/runs?createdAfter=2026-03-11T00:00:00Z&createdBefore=2026-03-10T00:00:00Z`
    )
    assert.equal(invertedDateRes.status, 400)
    const invertedDateBody = await invertedDateRes.json()
    assert.equal(invertedDateBody.code, 'INVALID_FILTER')

    // Verify encodeRunCursor / decodeRunCursor roundtrip
    const encoded = encodeRunCursor({ createdAt: '2026-03-10T12:00:00.000Z', id: 'run_1003_zzzz' })
    const decoded = decodeRunCursor(encoded)
    assert.equal(decoded.id, 'run_1003_zzzz')
    assert.equal(decoded.createdAt, '2026-03-10T12:00:00.000Z')

    console.log(
      '✓ Lightweight list summaries, full detail retrieval, and structured 400 validation errors verified'
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

console.log('=== All Issue #141 tests passed ===')
