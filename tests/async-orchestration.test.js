/**
 * Tests for async orchestration submission (issue #142).
 *
 * Covers:
 *  - POST /api/orchestrate?async=true returns 202 with a runId before work finishes
 *  - GET /api/runs/:id returns work status and final output
 *  - Disconnecting after 202 does not duplicate or lose the run
 *  - Idempotency key prevents duplicate runs; conflict on key reuse with different params
 *  - Validation failures still return 400, not 202
 *  - Synchronous mode (no ?async) still works and returns completed result inline
 *
 * Uses an in-memory run store and a delayed stub orchestrator.
 *
 * Run: node tests/async-orchestration.test.js
 */

import assert from 'node:assert'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import http from 'node:http'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'

// ─── Tiny test harness ───────────────────────────────────────
const failures = []
let passed = 0

function test(name, fn) {
  return { name, fn }
}

async function runTests(tests) {
  for (const { name, fn } of tests) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (err) {
      failures.push({ name, err })
      console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
    }
  }
}

// ─── Test helpers ────────────────────────────────────────────
const STUB_DELAY_MS = 200

function createStubOrchestrator(delayMs = STUB_DELAY_MS) {
  return async function stubOrchestrate(task, budget, broadcastFn, _context = {}) {
    broadcastFn({ type: 'orchestration_start', task })
    await delay(delayMs)
    broadcastFn({ type: 'orchestration_complete', task })
    return {
      task,
      budget,
      plan: { subtasks: [{ agent: 'research-bot', input: task }] },
      results: [{ agent: 'research-bot', result: `Stub result for: ${task}` }],
      totalPaid: '0.00',
      totalCost: '0.01',
      elapsed: `${delayMs}ms`,
    }
  }
}

function createFailingOrchestrator(delayMs = 50) {
  return async function failingOrchestrate(task, budget, broadcastFn) {
    broadcastFn({ type: 'orchestration_start', task })
    await delay(delayMs)
    const err = new Error('Stub orchestration failure')
    err.code = 'STUB_FAILURE'
    throw err
  }
}

async function createTestServer(orchestrateFn) {
  const app = express()
  app.use(express.json())
  app.use(requestId)

  const store = new InMemoryRunHistoryStore(100)
  await store.init()

  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: orchestrateFn || createStubOrchestrator(),
    broadcast: () => {},
  })

  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  return { server, baseUrl, store }
}

function post(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
}

function get(baseUrl, path, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(10000),
  })
}

// ─── Tests ───────────────────────────────────────────────────
console.log('\nasync orchestration submission (issue #142)')

const tests = [
  test('POST /api/orchestrate?async=true returns 202 with runId before work finishes', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(500))
    try {
      const res = await post(baseUrl, '/api/orchestrate?async=true', {
        task: 'Test async task',
        budget: 1.0,
      })
      assert.strictEqual(res.status, 202, `Expected 202 but got ${res.status}`)
      const body = await res.json()
      assert.ok(body.runId, 'Response should contain runId')
      assert.ok(body.url || body.runUrl, 'Response should contain run URL')
      assert.strictEqual(body.mode, 'async', 'Response mode should be async')
      assert.ok(body.url.includes(body.runId), 'Run URL should contain the runId')

      // The run should not be completed yet (orchestrator is still delayed)
      const detailRes = await get(baseUrl, `/api/runs/${body.runId}`)
      assert.strictEqual(detailRes.status, 200)
      const detail = await detailRes.json()
      assert.strictEqual(detail.status, 'running', 'Run should still be running')
    } finally {
      server.close()
    }
  }),

  test('run detail shows completed status after orchestration finishes', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(100))
    try {
      const res = await post(baseUrl, '/api/orchestrate?async=true', {
        task: 'Wait for completion',
        budget: 1.0,
      })
      const { runId } = await res.json()

      // Wait for orchestration to complete
      await delay(300)

      const detailRes = await get(baseUrl, `/api/runs/${runId}`)
      assert.strictEqual(detailRes.status, 200)
      const detail = await detailRes.json()
      assert.strictEqual(detail.status, 'completed', 'Run should be completed')
      assert.ok(detail.outputAvailable, 'Output should be available')
    } finally {
      server.close()
    }
  }),

  test('run detail shows failed status when orchestration errors', async () => {
    const { server, baseUrl } = await createTestServer(createFailingOrchestrator(50))
    try {
      const res = await post(baseUrl, '/api/orchestrate?async=true', {
        task: 'Expect failure',
        budget: 1.0,
      })
      assert.strictEqual(res.status, 202)
      const { runId } = await res.json()

      await delay(200)

      const detailRes = await get(baseUrl, `/api/runs/${runId}`)
      const detail = await detailRes.json()
      assert.strictEqual(detail.status, 'failed', 'Run should be failed')
      assert.ok(detail.error, 'Error field should be populated')
      assert.strictEqual(detail.error.message, 'Stub orchestration failure')
    } finally {
      server.close()
    }
  }),

  test('GET /api/runs/:id returns 404 for unknown run', async () => {
    const { server, baseUrl } = await createTestServer()
    try {
      const res = await get(baseUrl, '/api/runs/nonexistent-id')
      assert.strictEqual(res.status, 404)
    } finally {
      server.close()
    }
  }),

  test('synchronous mode still works (no async flag)', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(50))
    try {
      const res = await post(baseUrl, '/api/orchestrate', {
        task: 'Sync task',
        budget: 1.0,
      })
      assert.strictEqual(res.status, 200, 'Sync should return 200')
      const body = await res.json()
      assert.ok(body.runId, 'Sync result should contain runId')
      assert.ok(body.results, 'Sync result should contain results')
    } finally {
      server.close()
    }
  }),

  test('mode=async in body also triggers async mode', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(200))
    try {
      const res = await post(baseUrl, '/api/orchestrate', {
        task: 'Body-mode async',
        budget: 1.0,
        mode: 'async',
      })
      assert.strictEqual(res.status, 202, 'Body mode=async should return 202')
      const body = await res.json()
      assert.ok(body.runId)
      assert.strictEqual(body.mode, 'async')
    } finally {
      server.close()
    }
  }),

  test('Prefer: respond-async header triggers async mode', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(200))
    try {
      const res = await post(
        baseUrl,
        '/api/orchestrate',
        { task: 'Header async', budget: 1.0 },
        { Prefer: 'respond-async' }
      )
      assert.strictEqual(res.status, 202, 'Prefer header should trigger 202')
      const preferApplied = res.headers.get('preference-applied')
      assert.ok(preferApplied, 'Preference-Applied header should be set')
    } finally {
      server.close()
    }
  }),

  test('idempotency key returns same run on retry', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(100))
    try {
      const body = { task: 'Idempotent task', budget: 1.0 }
      const headers = { 'Idempotency-Key': 'test-key-123' }

      const res1 = await post(baseUrl, '/api/orchestrate?async=true', body, headers)
      assert.strictEqual(res1.status, 202)
      const run1 = await res1.json()

      // Wait for first run to complete
      await delay(200)

      // Retry with same key and params
      const res2 = await post(baseUrl, '/api/orchestrate?async=true', body, headers)
      assert.strictEqual(res2.status, 202)
      const run2 = await res2.json()

      assert.strictEqual(run1.runId, run2.runId, 'Same idempotency key should return same runId')
      assert.strictEqual(
        res2.headers.get('x-idempotent-replay'),
        'true',
        'Replay header should be set'
      )
    } finally {
      server.close()
    }
  }),

  test('idempotency key conflict returns 409 for different params', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(100))
    try {
      const headers = { 'Idempotency-Key': 'conflict-key-456' }

      const res1 = await post(
        baseUrl,
        '/api/orchestrate?async=true',
        { task: 'Task A', budget: 1.0 },
        headers
      )
      assert.strictEqual(res1.status, 202)
      await res1.json()

      // Wait for first run
      await delay(200)

      // Retry with same key but different task
      const res2 = await post(
        baseUrl,
        '/api/orchestrate?async=true',
        { task: 'Task B', budget: 1.0 },
        headers
      )
      assert.strictEqual(res2.status, 409, 'Different params with same key should return 409')
    } finally {
      server.close()
    }
  }),

  test('validation error returns 400 even with async=true', async () => {
    const { server, baseUrl } = await createTestServer()
    try {
      // Missing required "task" field
      const res = await post(baseUrl, '/api/orchestrate?async=true', {
        budget: 1.0,
      })
      assert.strictEqual(res.status, 400, 'Missing task should return 400, not 202')
    } finally {
      server.close()
    }
  }),

  test('invalid mode value returns 400', async () => {
    const { server, baseUrl } = await createTestServer()
    try {
      const res = await post(baseUrl, '/api/orchestrate', {
        task: 'test',
        budget: 1.0,
        mode: 'invalid',
      })
      assert.strictEqual(res.status, 400, 'Invalid mode should return 400')
    } finally {
      server.close()
    }
  }),

  test('202 response includes Location header', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(200))
    try {
      const res = await post(baseUrl, '/api/orchestrate?async=true', {
        task: 'Check Location',
        budget: 1.0,
      })
      assert.strictEqual(res.status, 202)
      const location = res.headers.get('location')
      assert.ok(location, 'Location header should be present')
      assert.ok(location.startsWith('/api/runs/'), 'Location should point to /api/runs/:id')
    } finally {
      server.close()
    }
  }),

  test('GET /api/runs lists all runs', async () => {
    const { server, baseUrl } = await createTestServer(createStubOrchestrator(50))
    try {
      await post(baseUrl, '/api/orchestrate?async=true', { task: 'Run A', budget: 1.0 })
      await post(baseUrl, '/api/orchestrate?async=true', { task: 'Run B', budget: 2.0 })

      await delay(150)

      const res = await get(baseUrl, '/api/runs')
      assert.strictEqual(res.status, 200)
      const body = await res.json()
      assert.ok(body.runs.length >= 2, 'Should list at least 2 runs')
    } finally {
      server.close()
    }
  }),

  test('disconnecting after 202 does not lose the run record', async () => {
    const { server, baseUrl, store } = await createTestServer(createStubOrchestrator(300))
    try {
      // Submit async
      const controller = new AbortController()
      const res = await fetch(`${baseUrl}/api/orchestrate?async=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Disconnect test', budget: 1.0 }),
        signal: controller.signal,
      })
      assert.strictEqual(res.status, 202)
      const { runId } = await res.json()

      // Simulate client disconnect (abort does not affect the server-side work)
      controller.abort()

      // Wait for server-side orchestration to finish
      await delay(500)

      // Verify run completed in store
      const run = await store.getRun(runId)
      assert.ok(run, 'Run record should still exist after disconnect')
      assert.strictEqual(run.status, 'completed', 'Run should have completed despite disconnect')
    } finally {
      server.close()
    }
  }),
]

await runTests(tests)

// ─── Report ──────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.error('\nFailures:')
  for (const { name, err } of failures) {
    console.error(`  ${name}: ${err.message}`)
  }
  process.exit(1)
}
