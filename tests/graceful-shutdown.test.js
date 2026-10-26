/**
 * Graceful shutdown and drain lifecycle tests (issue #180).
 *
 * Covers:
 *  - Readiness (/readyz) switches to not_ready (503) before new work is refused
 *  - New work is refused with 503 SERVER_DRAINING once draining starts
 *  - Idle server terminates immediately well within drain timeout bounds
 *  - Accepted active stub run completing within the drain window persists as completed
 *  - Active stub run exceeding the drain deadline is recorded as interrupted
 *    (interruptedReason: 'graceful_shutdown_timeout') with uncertain payment attempts preserved
 *  - Open SSE connections receive server_shutdown event and close without hanging
 *  - Delayed persistence writes flush completely before shutdown resolves and survive reload
 *
 * Run: node tests/graceful-shutdown.test.js
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'
import { createPaymentAttempt, markPaymentAttemptUnknown } from '../src/agents/payment-attempts.js'
import { pricingConfig } from '../src/pricing.config.js'
import {
  FileRunHistoryStore,
  InMemoryRunHistoryStore,
  INTERRUPTED_REASON_SHUTDOWN_TIMEOUT,
} from '../src/storage/run-history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.join(__dirname, 'fixtures')

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
    anthropicApiKey: 'sk-ant-test-key',
    serverAddress: '',
    facilitatorUrl: 'https://www.x402.org/facilitator',
    network: 'stellar:testnet',
    shutdownDrainTimeoutMs: 400,
    runHistoryStorage: 'memory',
    runHistoryFile: null,
    runHistoryMaxRuns: 200,
    orchestrationQueue: {
      maxConcurrent: 2,
      queueCapacity: 10,
      queueTimeoutMs: 5000,
    },
    ...overrides,
  }
}

async function startTestServer(deps = {}) {
  const { config: configOverrides, ...restDeps } = deps
  const store = restDeps.runHistoryStore || new InMemoryRunHistoryStore(100)
  await store.init()

  const config = createTestConfig(configOverrides)
  const appInstance = createApp({
    config,
    pricingConfig,
    runHistoryStore: store,
    ...restDeps,
  })

  const server = http.createServer(appInstance.app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    ...appInstance,
    server,
    store,
    baseUrl,
  }
}

async function withTempFile(name, fn) {
  const filePath = path.join(testDir, `graceful-shutdown-${name}-${Date.now()}.json`)
  try {
    await fs.mkdir(testDir, { recursive: true })
    await fn(filePath)
  } finally {
    await fs.unlink(filePath).catch(() => {})
  }
}

console.log('Testing graceful shutdown drain lifecycle (issue #180)...\n')

await test('idle server shuts down immediately and switches readiness to not_ready before refusing work', async () => {
  const { server, shutdown, baseUrl } = await startTestServer({
    config: { shutdownDrainTimeoutMs: 1000 },
  })

  const initialReadyRes = await fetch(`${baseUrl}/readyz`)
  assert.equal(initialReadyRes.status, 200)
  const initialReady = await initialReadyRes.json()
  assert.equal(initialReady.ready, true)
  assert.equal(initialReady.status, 'ready')

  let readinessObservedBeforeRefusal = null
  const startMs = Date.now()
  const summary = await shutdown({
    signal: 'SIGTERM',
    server,
    drainTimeoutMs: 1000,
    onReadinessChanged: async (payload) => {
      // Called immediately after readiness flips to not_ready, before refusingNewWork is armed
      const probeRes = await fetch(`${baseUrl}/readyz`)
      const probeBody = await probeRes.json()
      readinessObservedBeforeRefusal = {
        hookPayload: payload,
        httpStatus: probeRes.status,
        httpBody: probeBody,
      }
    },
  })
  const elapsedMs = Date.now() - startMs

  assert.ok(readinessObservedBeforeRefusal, 'onReadinessChanged hook should be called')
  assert.equal(readinessObservedBeforeRefusal.hookPayload.status, 'not_ready')
  assert.equal(readinessObservedBeforeRefusal.hookPayload.ready, false)
  assert.equal(readinessObservedBeforeRefusal.httpStatus, 503)
  assert.equal(readinessObservedBeforeRefusal.httpBody.status, 'not_ready')
  assert.equal(readinessObservedBeforeRefusal.httpBody.draining, true)

  assert.equal(summary.drained, true)
  assert.equal(summary.timedOut, false)
  assert.deepEqual(summary.interruptedRunIds, [])
  assert.ok(
    elapsedMs < 500,
    `Idle shutdown should not wait full 1000ms drain window (took ${elapsedMs}ms)`
  )
})

await test('refuses new orchestration requests with 503 SERVER_DRAINING while draining an accepted run', async () => {
  let releaseActiveRun
  const activeRunGate = new Promise((resolve) => {
    releaseActiveRun = resolve
  })

  const { server, shutdown, store, baseUrl } = await startTestServer({
    orchestrate: async (task, budget, broadcastFn) => {
      broadcastFn({ type: 'orchestrator_start', task })
      await activeRunGate
      return {
        task,
        budget,
        plan: 'stub plan',
        results: [{ agentId: 'research-bot', output: 'done' }],
        payments: [],
        totalSpent: '0.01',
        elapsed: '50ms',
      }
    },
  })

  // 1. Submit an accepted async run before shutdown starts
  const acceptedRes = await fetch(`${baseUrl}/api/orchestrate?async=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'Accepted in-flight task', budget: 0.1 }),
  })
  assert.equal(acceptedRes.status, 202)
  const { runId } = await acceptedRes.json()

  // 2. Begin shutdown with a 600ms drain window
  const shutdownPromise = shutdown({
    signal: 'SIGTERM',
    server,
    drainTimeoutMs: 600,
  })

  await delay(30)

  // 3. Verify /readyz is 503 not_ready while draining
  const readyRes = await fetch(`${baseUrl}/readyz`)
  assert.equal(readyRes.status, 503)
  const readyBody = await readyRes.json()
  assert.equal(readyBody.status, 'not_ready')
  assert.equal(readyBody.draining, true)

  // 4. Verify new orchestration work is refused with 503 SERVER_DRAINING
  const refusedRes = await fetch(`${baseUrl}/api/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'Should be refused during drain', budget: 0.1 }),
  })
  assert.equal(refusedRes.status, 503)
  assert.ok(refusedRes.headers.get('retry-after'))
  const refusedBody = await refusedRes.json()
  assert.equal(refusedBody.code, 'SERVER_DRAINING')

  // 5. Let the accepted run complete within the drain window
  releaseActiveRun()
  const summary = await shutdownPromise
  assert.equal(summary.drained, true)
  assert.equal(summary.timedOut, false)

  const completedRun = await store.getRun(runId)
  assert.equal(completedRun.status, 'completed')
  assert.equal(completedRun.outputAvailable, true)
})

await test('records remaining work at drain deadline as interrupted and preserves uncertain payment attempts', async () => {
  await withTempFile('deadline-uncertain-payment', async (filePath) => {
    const fileStore = new FileRunHistoryStore(filePath, 100)
    await fileStore.init()

    const { server, shutdown, baseUrl } = await startTestServer({
      runHistoryStore: fileStore,
      orchestrate: async (task, budget, broadcastFn, context = {}) => {
        const attempt = markPaymentAttemptUnknown(
          createPaymentAttempt({
            runId: context.runId,
            stepId: 'step-0',
            agentId: 'research-bot',
            amount: '0.01',
            currency: 'USDC',
          }),
          'transport_error'
        )
        broadcastFn({
          type: 'x402_settlement_unresolved',
          agent: 'Research Bot',
          agentId: 'research-bot',
          attemptId: attempt.id,
          paymentOutcome: attempt.outcome,
          paymentAttempt: attempt,
        })

        // Simulate a long-running step that exceeds the drain deadline and respects abort signal
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 10000)
          timer.unref?.()
          if (context.signal) {
            context.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                const err = context.signal.reason || new Error('Aborted')
                err.paymentAttempts = [attempt]
                reject(err)
              },
              { once: true }
            )
          }
        })
      },
    })

    const subRes = await fetch(`${baseUrl}/api/orchestrate?async=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'Stalled run with uncertain payment', budget: 0.2 }),
    })
    assert.equal(subRes.status, 202)
    const { runId } = await subRes.json()

    // Wait briefly so the uncertain payment event is broadcast
    await delay(40)

    const startMs = Date.now()
    const summary = await shutdown({
      signal: 'SIGTERM',
      server,
      drainTimeoutMs: 120,
    })
    const elapsedMs = Date.now() - startMs

    assert.equal(summary.timedOut, true)
    assert.equal(summary.drained, false)
    assert.ok(summary.interruptedRunIds.includes(runId))
    assert.ok(
      elapsedMs >= 100 && elapsedMs < 1000,
      `Expected bounded exit near 120ms, got ${elapsedMs}ms`
    )

    // Reload from disk into a fresh FileRunHistoryStore to verify durable state
    const reloadedStore = new FileRunHistoryStore(filePath, 100)
    await reloadedStore.init()
    const reloadedRun = await reloadedStore.getRun(runId)

    assert.ok(reloadedRun, 'Run should be persisted to disk')
    assert.equal(reloadedRun.status, 'interrupted')
    assert.equal(reloadedRun.interruptedReason, INTERRUPTED_REASON_SHUTDOWN_TIMEOUT)
    assert.equal(typeof reloadedRun.interruptedAt, 'string')
    assert.ok(Array.isArray(reloadedRun.pendingPaymentAttempts))
    assert.equal(reloadedRun.pendingPaymentAttempts.length, 1)
    assert.equal(reloadedRun.pendingPaymentAttempts[0].outcome, 'unknown')
    assert.equal(reloadedRun.pendingPaymentAttempts[0].agentId, 'research-bot')
    assert.ok(
      reloadedRun.events.some(
        (ev) => ev.type === 'run_interrupted' && ev.reason === INTERRUPTED_REASON_SHUTDOWN_TIMEOUT
      ),
      'Audit trail should contain run_interrupted event with graceful_shutdown_timeout reason'
    )
  })
})

await test('closes open SSE connections cleanly with server_shutdown event without hanging', async () => {
  const { server, shutdown, baseUrl } = await startTestServer()

  const sseMessages = []
  let sseClosed = false

  const sseCompleted = new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      assert.equal(res.statusCode, 200)
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''
        for (const frame of frames) {
          const match = frame.match(/^data: (.+)$/m)
          if (match) {
            sseMessages.push(JSON.parse(match[1]))
          }
        }
        if (sseMessages.length === 1 && sseMessages[0].type === 'connected') {
          // Trigger shutdown while SSE stream is open
          shutdown({ signal: 'SIGINT', server, drainTimeoutMs: 200 }).catch(reject)
        }
      })
      res.on('end', () => {
        sseClosed = true
        resolve()
      })
      res.on('error', reject)
    })
    req.on('error', reject)
  })

  await sseCompleted
  assert.equal(sseClosed, true, 'SSE stream should end cleanly on shutdown')
  assert.ok(
    sseMessages.some((msg) => msg.type === 'server_shutdown' && msg.reason === 'SIGINT'),
    'SSE stream should receive server_shutdown event before closing'
  )
})

await test('flushes delayed persistence writes before shutdown resolves', async () => {
  await withTempFile('delayed-persistence', async (filePath) => {
    class DelayedFileRunHistoryStore extends FileRunHistoryStore {
      async persist() {
        const delayedQueue = this._writeQueue.then(() => delay(150))
        this._writeQueue = delayedQueue
        return super.persist()
      }
    }

    const delayedStore = new DelayedFileRunHistoryStore(filePath, 100)
    await delayedStore.init()

    const { server, shutdown, baseUrl } = await startTestServer({
      runHistoryStore: delayedStore,
      orchestrate: async (task, budget) => ({
        task,
        budget,
        plan: 'quick plan',
        results: [{ agentId: 'summary-bot', output: 'fast output' }],
        payments: [],
        totalSpent: '0.01',
        elapsed: '10ms',
      }),
    })

    const res = await fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'Delayed disk write test', budget: 0.1 }),
    })
    assert.equal(res.status, 200)
    const { runId } = await res.json()

    // Trigger a delayed appendEvent right before shutdown
    const pendingAppend = delayedStore.appendEvent(runId, {
      type: 'agent_response',
      agentId: 'summary-bot',
      status: 'completed',
    })

    await shutdown({ signal: 'SIGTERM', server, drainTimeoutMs: 500 })
    await pendingAppend

    // Verify file on disk has the completed run and flushed event immediately after shutdown returns
    const rawOnDisk = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(rawOnDisk)
    const persistedRun = parsed.runs.find((r) => r.id === runId)
    assert.ok(persistedRun, 'Completed run must be flushed to disk before shutdown resolves')
    assert.equal(persistedRun.status, 'completed')
    assert.ok(
      persistedRun.events.some((e) => e.type === 'agent_response' && e.agentId === 'summary-bot'),
      'Delayed event write must be present in persisted file'
    )
  })
})

if (failures > 0) {
  console.error(`\n❌ ${failures} test(s) failed.`)
  process.exit(1)
}
console.log('\n✅ All graceful shutdown tests passed!')
