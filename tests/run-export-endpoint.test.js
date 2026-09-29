/**
 * Tests for the run report export endpoint (Issue #167).
 *
 * Covers:
 *  - GET /api/runs/:id/export returns the versioned JSON document as a download
 *  - ?format=md returns the readable Markdown rendering
 *  - an unknown run is a 404, an unsupported format is a 400
 *  - the exported receipts carry the network and transaction hash
 *
 * Run: node tests/run-export-endpoint.test.js
 */

import assert from 'node:assert'
import express from 'express'
import http from 'node:http'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'
import { RUN_EXPORT_SCHEMA_VERSION } from '../src/storage/run-export.js'

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

// ─── Test server + fixtures ──────────────────────────────────

const stubResult = {
  task: 'Sync run',
  budget: 1,
  plan: 'single agent',
  results: [
    {
      agentId: 'research-bot',
      agentName: 'Research Agent',
      cost: '0.01',
      currency: 'USDC',
      output: 'ok',
    },
  ],
  totalSpent: '0.01',
  budgetExhausted: false,
  paymentProtocol: 'x402',
  txCount: 1,
  elapsed: 1,
  usage: { entries: [], summary: {} },
  payments: [
    {
      paymentSuccess: true,
      paidVia: 'x402',
      txHash: 'cafebabe',
      explorerUrl: 'https://stellar.expert/explorer/testnet/tx/cafebabe',
    },
  ],
}

async function createTestServer() {
  const app = express()
  app.use(express.json())
  app.use(requestId)

  const store = new InMemoryRunHistoryStore(50, { network: 'stellar:testnet' })
  await store.init()

  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: async () => ({ ...stubResult }),
    broadcast: () => {},
  })

  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return { server, baseUrl: `http://127.0.0.1:${port}`, store }
}

async function seedCompletedRun(store) {
  const { runId } = await store.createRun({ task: 'Export this run', budget: 2, source: 'api' })
  await store.appendEvent(runId, {
    type: 'agent_call',
    agent: 'Research Agent',
    agentId: 'research-bot',
    cost: '0.01',
    paidVia: 'x402',
    timestamp: '2026-09-29T10:00:00.000Z',
  })
  await store.appendEvent(runId, {
    type: 'agent_response',
    agent: 'Research Agent',
    agentId: 'research-bot',
    status: 'ok',
    timestamp: '2026-09-29T10:00:02.000Z',
  })
  await store.completeRun(runId, {
    totalSpent: '0.01',
    budget: 2,
    budgetExhausted: false,
    paymentProtocol: 'x402',
    txCount: 1,
    plan: 'single agent',
    results: [{ agent: 'Research Agent', result: 'Exported output.' }],
    usage: { entries: [], summary: {} },
    payments: [
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'feedface',
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/feedface',
      },
    ],
  })
  return runId
}

const get = (baseUrl, path) => fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10000) })

// ─── Tests ───────────────────────────────────────────────────
console.log('\nrun report export endpoint (issue #167)')

const tests = [
  test('GET /api/runs/:id/export returns the versioned JSON as a download', async () => {
    const { server, baseUrl, store } = await createTestServer()
    try {
      const runId = await seedCompletedRun(store)

      const res = await get(baseUrl, `/api/runs/${runId}/export`)
      assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`)
      assert.match(res.headers.get('content-type'), /application\/json/)
      assert.strictEqual(
        res.headers.get('content-disposition'),
        `attachment; filename="${runId}.json"`
      )

      const doc = await res.json()
      assert.strictEqual(doc.schemaVersion, RUN_EXPORT_SCHEMA_VERSION)
      assert.strictEqual(doc.run.id, runId)
      assert.strictEqual(doc.run.status, 'completed')
      assert.ok(doc.run.network, 'export must state the network')
      assert.strictEqual(doc.steps.length, 2, 'both step events exported')
      assert.strictEqual(doc.receipts.length, 1)
      assert.strictEqual(doc.receipts[0].txHash, 'feedface')
      assert.ok(doc.receipts[0].network, 'receipt must carry the network')
      assert.strictEqual(doc.receipts[0].confirmed, true)
      assert.strictEqual(doc.amounts.totalSpent, '0.01')
    } finally {
      server.close()
    }
  }),

  test('?format=md returns readable Markdown as a download', async () => {
    const { server, baseUrl, store } = await createTestServer()
    try {
      const runId = await seedCompletedRun(store)

      const res = await get(baseUrl, `/api/runs/${runId}/export?format=md`)
      assert.strictEqual(res.status, 200)
      assert.match(res.headers.get('content-type'), /text\/markdown/)
      assert.strictEqual(
        res.headers.get('content-disposition'),
        `attachment; filename="${runId}.md"`
      )

      const body = await res.text()
      assert.ok(body.startsWith(`# Run report — ${runId}`), 'markdown starts with the run title')
      assert.ok(body.includes('Research Agent'), 'steps are listed')
      assert.ok(body.includes('feedface'), 'receipt hash is listed')
      assert.ok(body.includes('## Receipts'))
    } finally {
      server.close()
    }
  }),

  test('an unknown run is a 404 with RUN_NOT_FOUND', async () => {
    const { server, baseUrl } = await createTestServer()
    try {
      const res = await get(baseUrl, '/api/runs/run_does_not_exist/export')
      assert.strictEqual(res.status, 404)
      const body = await res.json()
      assert.strictEqual(body.code, 'RUN_NOT_FOUND')
    } finally {
      server.close()
    }
  }),

  test('an unsupported format is a 400 with UNSUPPORTED_EXPORT_FORMAT', async () => {
    const { server, baseUrl, store } = await createTestServer()
    try {
      const runId = await seedCompletedRun(store)
      const res = await get(baseUrl, `/api/runs/${runId}/export?format=xml`)
      assert.strictEqual(res.status, 400)
      const body = await res.json()
      assert.strictEqual(body.code, 'UNSUPPORTED_EXPORT_FORMAT')
    } finally {
      server.close()
    }
  }),

  test('a synchronous run response carries the runId, and that run exports', async () => {
    const { server, baseUrl } = await createTestServer()
    try {
      const res = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Sync run', budget: 1 }),
        signal: AbortSignal.timeout(10000),
      })
      assert.strictEqual(res.status, 200)
      const body = await res.json()
      assert.ok(body.runId, 'the result must carry the runId the UI links to')
      assert.strictEqual(body.results.length, 1, 'the result itself is unchanged')

      const exported = await get(baseUrl, `/api/runs/${body.runId}/export`)
      assert.strictEqual(exported.status, 200)
      const doc = await exported.json()
      assert.strictEqual(doc.run.id, body.runId)
      assert.strictEqual(doc.receipts[0].txHash, 'cafebabe')
    } finally {
      server.close()
    }
  }),

  test('the export endpoint does not shadow the run detail endpoint', async () => {
    const { server, baseUrl, store } = await createTestServer()
    try {
      const runId = await seedCompletedRun(store)
      const res = await get(baseUrl, `/api/runs/${runId}`)
      assert.strictEqual(res.status, 200)
      const body = await res.json()
      assert.strictEqual(body.id, runId, 'detail endpoint still returns the raw run')
      assert.ok(!('schemaVersion' in body), 'detail response is not an export document')
    } finally {
      server.close()
    }
  }),
]

await runTests(tests)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exitCode = 1
}
