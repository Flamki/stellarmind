/**
 * Tests for run/step identity of orchestration events (Issue #163).
 *
 * Covers:
 *  - every identified event carries its runId and a monotonic stepIndex
 *  - two calls to the same agent are two steps, not one
 *  - an agent_response pairs with the call it answers (FIFO per agent), so a
 *    call and its response share a step id
 *  - a response without a preceding call still counts as its own step
 *  - the route broadcasts and persists the identified events, and the reducer
 *    counts distinct steps rather than distinct agent names
 *
 * Run: node tests/run-event-identity.test.js
 */

import assert from 'node:assert'
import express from 'express'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createRunEventIdentifier, summarizeRunSteps } from '../src/agents/run-event-identity.js'
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

// ─── Tests ───────────────────────────────────────────────────
console.log('\nrun/step identity for orchestration events (issue #163)')

const tests = [
  test('every event is stamped with the runId and a monotonic stepIndex', () => {
    const identify = createRunEventIdentifier('run_1')
    const events = [
      { type: 'orchestrator_plan', subtaskCount: 2 },
      { type: 'agent_call', agentId: 'research-bot' },
      { type: 'agent_response', agentId: 'research-bot' },
      { type: 'orchestrator_complete' },
    ].map(identify)

    events.forEach((event, i) => {
      assert.strictEqual(event.runId, 'run_1', 'runId is stamped on every event')
      assert.strictEqual(event.stepIndex, i + 1, 'stepIndex is monotonic within the run')
    })
  }),

  test('two calls to the same agent are two distinct steps', () => {
    const identify = createRunEventIdentifier('run_2')
    const first = identify({ type: 'agent_call', agent: 'Research Agent', agentId: 'research-bot' })
    const second = identify({
      type: 'agent_call',
      agent: 'Research Agent',
      agentId: 'research-bot',
    })

    assert.notStrictEqual(first.stepId, second.stepId, 'each call gets its own step id')

    const summary = summarizeRunSteps([first, second])
    assert.strictEqual(summary.started, 2, 'the same agent twice counts as two steps')
  }),

  test('a response pairs with the call it answers', () => {
    const identify = createRunEventIdentifier('run_3')
    const callOne = identify({ type: 'agent_call', agentId: 'research-bot' })
    const callTwo = identify({ type: 'agent_call', agentId: 'research-bot' })
    const responseOne = identify({ type: 'agent_response', agentId: 'research-bot', cost: '0.01' })
    const responseTwo = identify({ type: 'agent_response', agentId: 'research-bot', cost: '0.02' })

    assert.strictEqual(responseOne.stepId, callOne.stepId, 'first response answers the first call')
    assert.strictEqual(
      responseTwo.stepId,
      callTwo.stepId,
      'second response answers the second call'
    )
    assert.strictEqual(responseOne.stepPaired, true)
    assert.strictEqual(responseTwo.stepPaired, true)

    const summary = summarizeRunSteps([callOne, callTwo, responseOne, responseTwo])
    assert.strictEqual(summary.started, 2)
    assert.strictEqual(summary.completed, 2)
    assert.strictEqual(summary.spent, 0.03, 'spend accumulates once per completed step')
  }),

  test('pairs per agent, not across agents', () => {
    const identify = createRunEventIdentifier('run_4')
    const researchCall = identify({ type: 'agent_call', agentId: 'research-bot' })
    const summaryCall = identify({ type: 'agent_call', agentId: 'summary-bot' })
    const researchResponse = identify({ type: 'agent_response', agentId: 'research-bot' })

    assert.strictEqual(researchResponse.stepId, researchCall.stepId)
    assert.notStrictEqual(researchResponse.stepId, summaryCall.stepId)
  }),

  test('a response without a call is still a step of its own', () => {
    const identify = createRunEventIdentifier('run_5')
    const orphan = identify({ type: 'agent_response', agentId: 'analyst-bot' })

    assert.ok(orphan.stepId, 'the response still carries a step id')
    assert.strictEqual(orphan.stepPaired, false)
    assert.strictEqual(summarizeRunSteps([orphan]).completed, 1)
  }),

  test('the identifier rejects a missing runId instead of stamping null', () => {
    assert.throws(() => createRunEventIdentifier(), /requires a runId/)
  }),

  test('the route broadcasts and persists identified events for its run', async () => {
    const app = express()
    app.use(express.json())
    app.use(requestId)

    const store = new InMemoryRunHistoryStore(20)
    await store.init()

    const streamedEvents = []
    // Same agent twice, then one response: the shape the dashboard used to
    // collapse into a single step.
    const orchestrate = async (task, budget, emit) => {
      emit({ type: 'orchestrator_plan', subtaskCount: 2 })
      emit({ type: 'agent_call', agent: 'Research Agent', agentId: 'research-bot', cost: '0.01' })
      emit({ type: 'agent_call', agent: 'Research Agent', agentId: 'research-bot', cost: '0.01' })
      emit({
        type: 'agent_response',
        agent: 'Research Agent',
        agentId: 'research-bot',
        cost: '0.01',
      })
      emit({
        type: 'agent_response',
        agent: 'Research Agent',
        agentId: 'research-bot',
        cost: '0.01',
      })
      return {
        task,
        budget,
        plan: 'stub',
        results: [],
        totalSpent: '0.02',
        budgetExhausted: false,
        paymentProtocol: 'x402',
        txCount: 1,
        usage: { entries: [], summary: {} },
        payments: [],
      }
    }

    registerOrchestrationRoutes(app, {
      runHistoryStore: store,
      orchestrate,
      broadcast: (event) => streamedEvents.push(event),
    })
    app.use(errorHandler)

    const server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    try {
      const res = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'identity please', budget: 1 }),
        signal: AbortSignal.timeout(10000),
      })
      assert.strictEqual(res.status, 200)
      const body = await res.json()
      assert.ok(body.runId, 'the response carries the run id')

      // Every streamed event belongs to that run and has a step position.
      assert.strictEqual(
        streamedEvents.every((event) => event.runId === body.runId),
        true,
        'no event is broadcast without its runId'
      )
      assert.deepStrictEqual(
        streamedEvents.map((event) => event.stepIndex),
        [1, 2, 3, 4, 5],
        'stepIndex follows the stream order'
      )

      const summary = summarizeRunSteps(streamedEvents)
      assert.strictEqual(summary.started, 2, 'two calls to one agent are two steps')
      assert.strictEqual(summary.completed, 2, 'two responses complete two steps')

      // The persisted history must agree with what the dashboard saw.
      await delay(50)
      const stored = await store.getRun(body.runId)
      assert.strictEqual(stored.events.length, 5, 'every event is persisted')
      assert.deepStrictEqual(
        stored.events.map((event) => event.stepId ?? null),
        streamedEvents.map((event) => event.stepId ?? null),
        'history keeps the same step identity as the live stream'
      )
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
