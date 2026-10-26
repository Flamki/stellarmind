/**
 * Operational metrics endpoint and registry tests (issue #181).
 *
 * Covers:
 *  - Accepted/terminal runs, phase latency histograms, active/queued work gauges,
 *    payment/settlement outcomes, and persistence error counters
 *  - Bounded label cardinality: prompts, run IDs, wallet addresses, and tx hashes
 *    are rejected/coerced to bounded allowlist values and never appear in labels
 *  - Demo activity (`mode="demo"`) is distinguished from live activity (`mode="live"`)
 *  - Deterministic successful, failed, queued, and demo runs produce accurate deltas
 *    in both Prometheus text (`/metrics`) and JSON (`/api/metrics`)
 *
 * Run: node tests/operational-metrics.test.js
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../src/app.js'
import { ALLOWED_LABEL_VALUES, createMetricsRegistry } from '../src/metrics.js'
import { pricingConfig } from '../src/pricing.config.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.stack || err.message}`)
  }
}

function createTestConfig(overrides = {}) {
  return {
    anthropicApiKey: 'sk-ant-live-key',
    serverAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    facilitatorUrl: 'https://www.x402.org/facilitator',
    network: 'stellar:testnet',
    runHistoryStorage: 'memory',
    runHistoryFile: null,
    runHistoryMaxRuns: 200,
    orchestrationQueue: {
      maxConcurrent: 1,
      queueCapacity: 10,
      queueTimeoutMs: 5000,
    },
    ...overrides,
  }
}

async function withMetricsServer(deps, fn) {
  const { config: configOverrides, ...restDeps } = deps || {}
  const store = restDeps.runHistoryStore || new InMemoryRunHistoryStore(100)
  await store.init()

  const metrics = restDeps.metrics || createMetricsRegistry()
  const config = createTestConfig(configOverrides)
  const { app, close } = createApp({
    config,
    pricingConfig,
    runHistoryStore: store,
    metrics,
    ...restDeps,
  })

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    await fn({ baseUrl, metrics, store })
  } finally {
    close()
    server.closeIdleConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

function findCounterValue(entries, matchLabels) {
  const hit = entries.find((entry) =>
    Object.entries(matchLabels).every(([k, v]) => entry.labels[k] === v)
  )
  return hit ? hit.value : 0
}

function findHistogram(entries, matchLabels) {
  return (
    entries.find((entry) => Object.entries(matchLabels).every(([k, v]) => entry.labels[k] === v)) ||
    null
  )
}

console.log('Testing operational metrics endpoint and registry (issue #181)...\n')

await test('drives deterministic successful, failed, queued, and demo runs and asserts metric deltas', async () => {
  let blockFirstRunRelease
  const blockFirstRun = new Promise((resolve) => {
    blockFirstRunRelease = resolve
  })

  let callIndex = 0
  const stubOrchestrate = async (task, budget, broadcastFn) => {
    callIndex += 1
    broadcastFn({ type: 'orchestrator_start', task })

    if (task.includes('queued-blocker')) {
      await blockFirstRun
    } else if (task.includes('fail-this-run')) {
      await delay(10)
      const err = new Error('Simulated upstream failure')
      err.code = 'UPSTREAM_ERROR'
      throw err
    } else {
      await delay(10)
    }

    return {
      task,
      budget,
      plan: 'deterministic plan',
      results: [
        {
          agentId: 'research-bot',
          stepId: 'step-0',
          output: `Result ${callIndex}`,
          paidVia: 'x402',
          paymentSuccess: true,
        },
      ],
      payments: [
        {
          paidVia: 'x402',
          paymentMethod: 'x402',
          paymentSuccess: true,
          settledAsset: 'USDC',
          settledAmount: '0.01',
          txHash: 'a'.repeat(64),
        },
      ],
      totalSpent: '0.01',
      elapsed: '10ms',
    }
  }

  await withMetricsServer({ orchestrate: stubOrchestrate }, async ({ baseUrl, store }) => {
    // 1. Start a live run that holds the single concurrency slot (`maxConcurrent: 1`)
    const firstRunPromise = fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'live queued-blocker task', budget: 0.1 }),
    })

    await delay(25)

    // 2. Submit a second live run that must wait in the admission queue
    const secondRunPromise = fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'live queued follower task', budget: 0.1 }),
    })

    await delay(25)

    // While first is active and second is queued, check live gauges via /api/metrics
    const midSnapRes = await fetch(`${baseUrl}/api/metrics`)
    assert.equal(midSnapRes.status, 200)
    const midSnap = await midSnapRes.json()
    assert.equal(midSnap.gauges.activeRuns, 1)
    assert.equal(midSnap.gauges.queuedRuns, 1)
    assert.equal(midSnap.gauges.peakQueuedRuns, 1)

    // Release first run so both complete
    blockFirstRunRelease()
    const [firstRes, secondRes] = await Promise.all([firstRunPromise, secondRunPromise])
    assert.equal(firstRes.status, 200)
    assert.equal(secondRes.status, 200)

    // 3. Drive a deterministic failed live run
    const failedRes = await fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'live fail-this-run task', budget: 0.1 }),
    })
    assert.equal(failedRes.status, 500)

    // 4. Drive a deterministic demo run (distinguished via X-StellarMind-Mode: demo)
    const demoRes = await fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-StellarMind-Mode': 'demo',
      },
      body: JSON.stringify({ task: 'demo showcase run', budget: 0.1 }),
    })
    assert.equal(demoRes.status, 200)

    // 5. Simulate a persistence error on appendEvent
    const origAppend = store.appendEvent.bind(store)
    store.appendEvent = async () => {
      throw new Error('simulated disk full')
    }
    const persistErrRes = await fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'live run with appendEvent error', budget: 0.1 }),
    })
    assert.equal(persistErrRes.status, 200)
    store.appendEvent = origAppend

    // Fetch JSON snapshot and Prometheus text output
    const snapRes = await fetch(`${baseUrl}/api/metrics`)
    const snap = await snapRes.json()

    // Active and queued gauges return to 0 after runs finish, while peakQueuedRuns stays 1
    assert.equal(snap.gauges.activeRuns, 0)
    assert.equal(snap.gauges.queuedRuns, 0)
    assert.equal(snap.gauges.peakQueuedRuns, 1)

    // Accepted runs: 4 live + 1 demo
    assert.equal(
      findCounterValue(snap.counters.runsAccepted, { mode: 'live', submission: 'sync' }),
      4
    )
    assert.equal(
      findCounterValue(snap.counters.runsAccepted, { mode: 'demo', submission: 'sync' }),
      1
    )

    // Terminal runs: 3 live completed, 1 live failed, 1 demo completed
    assert.equal(
      findCounterValue(snap.counters.runsTerminal, { status: 'completed', mode: 'live' }),
      3
    )
    assert.equal(
      findCounterValue(snap.counters.runsTerminal, { status: 'failed', mode: 'live' }),
      1
    )
    assert.equal(
      findCounterValue(snap.counters.runsTerminal, { status: 'completed', mode: 'demo' }),
      1
    )

    // Queued counter: 1 live run waited in queue
    assert.equal(findCounterValue(snap.counters.runsQueued, { mode: 'live' }), 1)

    // Settlement outcomes: 3 live x402 USDC settled + 1 demo x402 USDC settled
    assert.equal(
      findCounterValue(snap.counters.settlementOutcomes, {
        method: 'x402',
        outcome: 'settled',
        asset: 'USDC',
        mode: 'live',
      }),
      3
    )
    assert.equal(
      findCounterValue(snap.counters.settlementOutcomes, {
        method: 'x402',
        outcome: 'settled',
        asset: 'USDC',
        mode: 'demo',
      }),
      1
    )

    // Persistence errors: append_event recorded
    assert.ok(findCounterValue(snap.counters.persistenceErrors, { operation: 'append_event' }) >= 1)

    // Phase latency histograms: queue_wait, planning, agent_step, settlement, total_run
    assert.ok(findHistogram(snap.histograms.phaseDurationMs, { phase: 'queue_wait', mode: 'live' }))
    assert.ok(findHistogram(snap.histograms.phaseDurationMs, { phase: 'planning', mode: 'live' }))
    assert.ok(findHistogram(snap.histograms.phaseDurationMs, { phase: 'agent_step', mode: 'live' }))
    assert.ok(findHistogram(snap.histograms.phaseDurationMs, { phase: 'settlement', mode: 'live' }))
    assert.ok(findHistogram(snap.histograms.phaseDurationMs, { phase: 'total_run', mode: 'live' }))
    assert.ok(findHistogram(snap.histograms.phaseDurationMs, { phase: 'total_run', mode: 'demo' }))

    // Verify Prometheus exposition format on GET /metrics
    const promRes = await fetch(`${baseUrl}/metrics`)
    assert.equal(promRes.status, 200)
    assert.ok(promRes.headers.get('content-type').includes('text/plain'))
    const promText = await promRes.text()
    assert.ok(promText.includes('stellarmind_runs_accepted_total{mode="live",submission="sync"} 4'))
    assert.ok(promText.includes('stellarmind_runs_accepted_total{mode="demo",submission="sync"} 1'))
    assert.ok(
      promText.includes('stellarmind_runs_terminal_total{status="Failed"') === false &&
        promText.includes('stellarmind_runs_terminal_total{status="failed",mode="live"} 1')
    )
    assert.ok(
      promText.includes(
        'stellarmind_settlement_outcomes_total{method="x402",outcome="settled",asset="USDC",mode="live"} 3'
      )
    )
    assert.ok(
      promText.includes(
        'stellarmind_settlement_outcomes_total{method="x402",outcome="settled",asset="USDC",mode="demo"} 1'
      )
    )
    assert.ok(promText.includes('stellarmind_persistence_errors_total{operation="append_event"}'))
  })
})

await test('enforces bounded label cardinality and strips prompts, run IDs, wallet addresses, and tx hashes', async () => {
  const registry = createMetricsRegistry()

  const sensitivePrompt = 'Summarize secret merger plan for Acme Corp'
  const sensitiveRunId = 'run_1793047633397_956c0ea8'
  const sensitiveWallet = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'
  const sensitiveTxHash = 'f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3'

  registry.recordRunAccepted({
    mode: sensitivePrompt,
    submission: sensitiveRunId,
    runId: sensitiveRunId,
    prompt: sensitivePrompt,
  })
  registry.recordRunTerminal({
    status: sensitiveWallet,
    mode: sensitiveTxHash,
    durationMs: 42,
  })
  registry.recordSettlementOutcome({
    method: sensitiveWallet,
    outcome: sensitiveTxHash,
    asset: sensitiveRunId,
    mode: sensitivePrompt,
    txHash: sensitiveTxHash,
    wallet: sensitiveWallet,
    durationMs: 12,
  })
  registry.recordPersistenceError({
    operation: sensitivePrompt,
    runId: sensitiveRunId,
  })

  const promText = registry.formatPrometheus()
  const snap = registry.getSnapshot()

  // Verify none of the high-cardinality / sensitive strings appear anywhere in Prometheus output
  for (const forbidden of [sensitivePrompt, sensitiveRunId, sensitiveWallet, sensitiveTxHash]) {
    assert.equal(
      promText.includes(forbidden),
      false,
      `Prometheus output must never contain high-cardinality value: ${forbidden}`
    )
    assert.equal(
      JSON.stringify(snap).includes(forbidden),
      false,
      `JSON snapshot must never contain high-cardinality value: ${forbidden}`
    )
  }

  // Verify all emitted labels belong strictly to ALLOWED_LABEL_VALUES
  const allEntries = [
    ...snap.counters.runsAccepted,
    ...snap.counters.runsTerminal,
    ...snap.counters.settlementOutcomes,
    ...snap.counters.persistenceErrors,
    ...snap.histograms.phaseDurationMs,
  ]
  for (const entry of allEntries) {
    for (const [key, val] of Object.entries(entry.labels)) {
      assert.ok(ALLOWED_LABEL_VALUES[key], `Unexpected label key: ${key}`)
      assert.ok(
        ALLOWED_LABEL_VALUES[key].allowed.has(val),
        `Label ${key}="${val}" is outside the bounded allowlist`
      )
    }
  }
})

if (failures > 0) {
  console.error(`\n❌ ${failures} test(s) failed.`)
  process.exit(1)
}
console.log('\n✅ All operational metrics tests passed!')
