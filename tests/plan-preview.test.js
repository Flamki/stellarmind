/**
 * Tests for Plan-Preview and Execution API (issue #145 / plan-preview scope).
 *
 * Covers:
 *  - Preview returns validated steps, per-step quotes, total quote, and expiry.
 *  - Preview makes zero agent/payment calls; planner-provider usage is disclosed.
 *  - Execution validates the stored plan and current pricing against the accepted quote.
 *  - Expired quotes return explicit re-preview requirement (QUOTE_EXPIRED).
 *  - Changed pricing returns explicit re-preview requirement (QUOTE_CHANGED).
 *  - Missing / unknown plan ID returns 404 (PLAN_NOT_FOUND).
 *  - HTTP endpoints POST /api/orchestrate/preview and POST /api/orchestrate/execute work correctly.
 *
 * Run: node tests/plan-preview.test.js
 */

import assert from 'node:assert'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import http from 'node:http'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'
import { previewOrchestration, executePlan, activePlansStore } from '../src/agents/orchestrator.js'
import { AGENTS } from '../src/agents/registry.js'

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

async function createTestServer() {
  const app = express()
  app.use(express.json())
  app.use(requestId)

  const store = new InMemoryRunHistoryStore(100)
  await store.init()

  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: async (task, budget, broadcastFn) => {
      broadcastFn({ type: 'orchestrator_start', task })
      await delay(10)
      broadcastFn({ type: 'orchestrator_complete', task })
      return {
        task,
        budget,
        plan: 'Stub execution plan',
        results: [{ agentId: 'research-bot', output: 'Stub result' }],
        payments: [],
        txCount: 0,
        x402PaymentCount: 0,
        xlmFallbackCount: 0,
        unpaidCount: 1,
        totalSpent: '0.01',
        budgetExhausted: false,
        paymentProtocol: 'none',
        elapsed: '10ms',
      }
    },
    broadcast: () => {},
  })

  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  return { server, baseUrl, store }
}

async function post(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return { status: res.status, data }
}

async function runAllTests() {
  console.log('--- Running Plan-Preview & Execute Tests ---')

  const tests = [
    test('preview returns validated steps, per-step quotes, total quote, and expiry', async () => {
      const stubPlan = {
        plan: 'Test preview workflow',
        subtasks: [
          { agentId: 'research-bot', input: 'Research topic', cost: '0.01' },
          { agentId: 'summary-bot', input: 'Summarize', cost: '0.01' },
        ],
      }

      let agentCalls = 0

      const preview = await previewOrchestration('Analyze quantum computing', 0.10, () => {}, {
        plan: stubPlan,
        serviceMap: {
          'research-bot': async () => { agentCalls++; return 'research' },
          'summary-bot': async () => { agentCalls++; return 'summary' },
        },
      })

      assert.strictEqual(typeof preview.planId, 'string')
      assert.strictEqual(preview.task, 'Analyze quantum computing')
      assert.strictEqual(preview.budget, 0.10)
      assert.strictEqual(preview.plan, 'Test preview workflow')
      assert.strictEqual(Array.isArray(preview.steps), true)
      assert.strictEqual(preview.steps.length, 2)
      assert.strictEqual(preview.steps[0].agentId, 'research-bot')
      assert.strictEqual(typeof preview.steps[0].quote, 'string')
      assert.strictEqual(typeof preview.totalQuote, 'string')
      assert.strictEqual(typeof preview.expiresAt, 'string')
      assert.strictEqual(agentCalls, 0, 'Preview must make zero agent calls')
      assert.strictEqual(preview.usage !== undefined, true, 'Preview discloses planner usage')
    }),

    test('execution validates stored plan and executes successfully', async () => {
      const stubPlan = {
        plan: 'Execution workflow',
        subtasks: [
          { agentId: 'research-bot', input: 'Research', cost: '0.01' },
        ],
      }

      const preview = await previewOrchestration('Test execution task', 0.10, () => {}, {
        plan: stubPlan,
      })

      assert.strictEqual(activePlansStore.has(preview.planId), true)

      const result = await executePlan(preview.planId, () => {}, {
        serviceMap: {
          'research-bot': async () => 'Research result output',
        },
      })

      assert.strictEqual(result.task, 'Test execution task')
      assert.strictEqual(activePlansStore.has(preview.planId), false, 'Plan removed after execution')
    }),

    test('expired quote returns explicit QUOTE_EXPIRED error', async () => {
      const stubPlan = {
        plan: 'Expired plan',
        subtasks: [
          { agentId: 'research-bot', input: 'Research', cost: '0.01' },
        ],
      }

      const preview = await previewOrchestration('Expired task', 0.10, () => {}, {
        plan: stubPlan,
      })

      const record = activePlansStore.get(preview.planId)
      record.expiresAt = new Date(Date.now() - 1000).toISOString()

      let caughtErr = null
      try {
        await executePlan(preview.planId, () => {})
      } catch (err) {
        caughtErr = err
      }

      assert.notStrictEqual(caughtErr, null)
      assert.strictEqual(caughtErr.code, 'QUOTE_EXPIRED')
      assert.strictEqual(caughtErr.status, 400)
    }),

    test('changed pricing returns explicit QUOTE_CHANGED error', async () => {
      const stubPlan = {
        plan: 'Changed price plan',
        subtasks: [
          { agentId: 'research-bot', input: 'Research', cost: '0.01' },
        ],
      }

      const preview = await previewOrchestration('Price change task', 0.10, () => {}, {
        plan: stubPlan,
      })

      const agent = AGENTS.find((a) => a.id === 'research-bot')
      const originalPrice = agent.price
      agent.price = '$99.99'

      let caughtErr = null
      try {
        await executePlan(preview.planId, () => {})
      } catch (err) {
        caughtErr = err
      } finally {
        agent.price = originalPrice
      }

      assert.notStrictEqual(caughtErr, null)
      assert.strictEqual(caughtErr.code, 'QUOTE_CHANGED')
      assert.strictEqual(caughtErr.status, 400)
    }),

    test('unknown plan ID returns PLAN_NOT_FOUND', async () => {
      let caughtErr = null
      try {
        await executePlan('plan_nonexistent_123', () => {})
      } catch (err) {
        caughtErr = err
      }

      assert.notStrictEqual(caughtErr, null)
      assert.strictEqual(caughtErr.code, 'PLAN_NOT_FOUND')
      assert.strictEqual(caughtErr.status, 404)
    }),

    test('HTTP endpoints /api/orchestrate/preview and /api/orchestrate/execute work end-to-end', async () => {
      const { server, baseUrl } = await createTestServer()

      try {
        const previewRes = await post(baseUrl, '/api/orchestrate/preview', {
          task: 'HTTP test task',
          budget: 0.10,
        })
        assert.strictEqual(previewRes.status, 200)
        assert.strictEqual(typeof previewRes.data.planId, 'string')
        assert.strictEqual(previewRes.data.task, 'HTTP test task')
        assert.strictEqual(Array.isArray(previewRes.data.steps), true)

        const planId = previewRes.data.planId

        const execRes = await post(baseUrl, '/api/orchestrate/execute', {
          planId,
        })
        assert.strictEqual(execRes.status, 200)
        assert.strictEqual(execRes.data.task, 'HTTP test task')
      } finally {
        server.close()
      }
    }),
  ]

  await runTests(tests)

  console.log(`\nResults: ${passed} passed, ${failures.length} failed.`)
  if (failures.length > 0) {
    process.exit(1)
  }
}

runAllTests()
