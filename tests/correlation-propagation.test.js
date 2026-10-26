import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { config as baseConfig } from '../src/config.js'
import { pricingConfig } from '../src/pricing.config.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import { orchestrate } from '../src/agents/orchestrator.js'
import { setLogSink, resetLogSink } from '../src/logger.js'
import {
  ATTEMPT_HEADER,
  CORRELATION_ID_HEADER,
  RUN_ID_HEADER,
  STEP_ID_HEADER,
  buildCorrelationHeaders,
  extractCorrelationContext,
  sanitizeAttemptNumber,
  sanitizeCorrelationToken,
} from '../src/correlation.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.stack || err.message}`)
  }
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await fn(baseUrl)
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

console.log('Testing run and step correlation propagation (issue #182)...\n')

await test('sanitizes correlation tokens and strips task text or credentials from correlation headers', async () => {
  // Valid safe identifiers
  assert.equal(sanitizeCorrelationToken('corr_2026-10:step.0'), 'corr_2026-10:step.0')
  assert.equal(sanitizeCorrelationToken('  run_1700000_abcd1234  '), 'run_1700000_abcd1234')
  assert.equal(sanitizeAttemptNumber(1), 1)
  assert.equal(sanitizeAttemptNumber('2'), 2)

  // Rejects task prose, spaces, and oversized strings
  assert.equal(sanitizeCorrelationToken('Analyze DeFi yield farming risks in 2026'), null)
  assert.equal(sanitizeCorrelationToken('a'.repeat(129)), null)
  assert.equal(sanitizeCorrelationToken(''), null)

  // Rejects Anthropic API keys, Stellar secret keys, and Bearer tokens
  assert.equal(sanitizeCorrelationToken('sk-ant-api03-secret-token-value'), null)
  const stellarSecret = `S${'A'.repeat(55)}`
  assert.equal(sanitizeCorrelationToken(stellarSecret), null)
  assert.equal(sanitizeCorrelationToken('Bearer_eyJhbGciOiJIUzI1NiJ9'), null)
  assert.equal(sanitizeCorrelationToken('my_api_key_12345'), null)

  const headers = buildCorrelationHeaders({
    correlationId: 'Analyze secret task text with spaces',
    runId: stellarSecret,
    stepId: 'sk-ant-leaked-credential',
    attempt: 0,
  })
  assert.deepEqual(headers, {})

  const safeHeaders = buildCorrelationHeaders({
    correlationId: 'req-corr-182',
    runId: 'run_182_abc',
    stepId: 'step-0',
    attempt: 2,
  })
  assert.deepEqual(safeHeaders, {
    [CORRELATION_ID_HEADER]: 'req-corr-182',
    [RUN_ID_HEADER]: 'run_182_abc',
    [STEP_ID_HEADER]: 'step-0',
    [ATTEMPT_HEADER]: '2',
  })
})

await test('request middleware rejects unsafe incoming x-correlation-id headers containing task text or secrets', async () => {
  const extracted = extractCorrelationContext({
    headers: {
      'x-correlation-id': 'sk-ant-api03-should-never-be-echoed',
      'x-stellarmind-run-id': 'Research confidential acquisition target',
      'x-stellarmind-step-id': 'step-0',
      'x-stellarmind-attempt': '1',
    },
  })

  assert.ok(extracted.correlationId)
  assert.ok(!extracted.correlationId.includes('sk-ant-'))
  assert.equal(extracted.runId, null)
  assert.equal(extracted.stepId, 'step-0')
  assert.equal(extracted.attempt, 1)
})

await test('traces a two-step run with one retry across outer request, internal premium HTTP calls, structured logs, and persisted run.events', async () => {
  const logs = []
  const sseEvents = []
  const outboundPremiumRequests = []
  const runHistoryStore = new InMemoryRunHistoryStore()
  const sensitiveTask = 'Audit confidential treasury strategy for AcmeVault alpha-secret-plan'

  setLogSink((entry) => {
    logs.push(entry)
  })

  try {
    let serverBaseUrl = ''
    let researchCallCount = 0

    // Custom orchestrate wrapper that drives the real `orchestrate()` implementation
    // against the live Express `/api/premium/*` endpoints via an instrumented x402Fetch
    const orchestrateWithLivePremiumCalls = (task, budget, broadcastFn, context = {}) => {
      return orchestrate(task, budget, broadcastFn, {
        ...context,
        x402MaxAttempts: 2,
        plan: {
          plan: 'Two-step research and summary plan',
          subtasks: [
            { stepId: 'step-0', agentId: 'research-bot', input: task },
            { stepId: 'step-1', agentId: 'summary-bot', input: `Summarize: ${task}` },
          ],
        },
        x402Fetch: async (url, init = {}) => {
          const targetUrl = url.replace(baseConfig.internalBaseUrl, serverBaseUrl)
          const headers = { ...(init.headers || {}) }
          outboundPremiumRequests.push({ url: targetUrl, headers })

          // Simulate a transient 402/429 failure on attempt 1 of step-0 (research-bot),
          // then succeed on attempt 2 of step-0 and attempt 1 of step-1.
          if (targetUrl.includes('/api/premium/research')) {
            researchCallCount += 1
            if (researchCallCount === 1) {
              return fetch(targetUrl, {
                headers: {
                  ...headers,
                  'x-simulate-transient-429': 'true',
                },
              })
            }
          }

          return fetch(targetUrl, {
            headers: {
              ...headers,
              'x-payment-context': 'paid',
            },
          })
        },
      })
    }

    const paymentMiddleware = (req, res, next) => {
      if (!req.path.startsWith('/api/premium/')) return next()
      if (req.header('x-simulate-transient-429') === 'true') {
        return res.status(429).json({
          code: 'RATE_LIMITED',
          message: 'Simulated transient facilitator rate limit on attempt 1',
        })
      }
      if (!req.header('x-payment-context')) {
        return res.status(402).json({ error: 'payment_required' })
      }
      res.setHeader(
        'payment-response',
        Buffer.from(
          JSON.stringify({
            success: true,
            transaction: `tx_${req.header(STEP_ID_HEADER)}_${req.header(ATTEMPT_HEADER)}`,
          })
        ).toString('base64')
      )
      return next()
    }

    const { app, close } = createApp({
      config: {
        ...baseConfig,
        anthropicApiKey: 'sk-ant-test-key-for-correlation',
        serverAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
      pricingConfig,
      runHistoryStore,
      orchestrate: orchestrateWithLivePremiumCalls,
      broadcast: (event) => sseEvents.push(event),
      paymentMiddleware,
      premiumServices: {
        runResearch: async (topic) => `Research findings on ${topic}`,
        runSummary: async (text) => `Executive summary of ${text.slice(0, 40)}`,
        runAnalysis: async (topic) => `Analysis of ${topic}`,
        runCode: async (prompt) => `Code for ${prompt}`,
        MODEL_LABELS: {
          research: 'test-haiku',
          summary: 'test-haiku',
          analysis: 'test-sonnet',
          code: 'test-sonnet',
        },
      },
    })

    try {
      await withServer(app, async (baseUrl) => {
        serverBaseUrl = baseUrl
        const outerCorrelationId = 'corr-trace-two-step-182'

        const response = await fetch(`${baseUrl}/api/orchestrate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [CORRELATION_ID_HEADER]: outerCorrelationId,
          },
          body: JSON.stringify({
            task: sensitiveTask,
            budget: 0.1,
          }),
        })

        assert.equal(response.status, 200)
        assert.equal(response.headers.get(CORRELATION_ID_HEADER), outerCorrelationId)
        const body = await response.json()

        const runId = body.runId
        assert.ok(runId && runId.startsWith('run_'), `Expected valid runId, got ${runId}`)
        assert.equal(body.correlationId, outerCorrelationId)
        assert.equal(body.results.length, 2)

        // 1. Verify step results retain logical stepId and record final attempt counts
        assert.equal(body.results[0].stepId, 'step-0')
        assert.equal(body.results[0].attempt, 2)
        assert.equal(body.results[0].correlationId, outerCorrelationId)
        assert.equal(body.results[0].runId, runId)

        assert.equal(body.results[1].stepId, 'step-1')
        assert.equal(body.results[1].attempt, 1)
        assert.equal(body.results[1].correlationId, outerCorrelationId)
        assert.equal(body.results[1].runId, runId)

        // 2. Verify outbound internal HTTP headers to /api/premium/*:
        //    - step-0 attempt 1 (failed 429)
        //    - step-0 attempt 2 (succeeded 200)
        //    - step-1 attempt 1 (succeeded 200)
        assert.equal(outboundPremiumRequests.length, 3)
        assert.deepEqual(
          outboundPremiumRequests.map((req) => ({
            correlationId: req.headers[CORRELATION_ID_HEADER],
            runId: req.headers[RUN_ID_HEADER],
            stepId: req.headers[STEP_ID_HEADER],
            attempt: req.headers[ATTEMPT_HEADER],
          })),
          [
            {
              correlationId: outerCorrelationId,
              runId,
              stepId: 'step-0',
              attempt: '1',
            },
            {
              correlationId: outerCorrelationId,
              runId,
              stepId: 'step-0',
              attempt: '2',
            },
            {
              correlationId: outerCorrelationId,
              runId,
              stepId: 'step-1',
              attempt: '1',
            },
          ]
        )

        // 3. Verify no task text or credentials ever appear in correlation headers
        for (const req of outboundPremiumRequests) {
          for (const [headerName, headerValue] of Object.entries(req.headers)) {
            assert.ok(
              !String(headerValue).includes('AcmeVault'),
              `Header ${headerName} leaked task text`
            )
            assert.ok(
              !String(headerValue).includes('sk-ant-'),
              `Header ${headerName} leaked API key`
            )
          }
        }

        // 4. Verify structured logs can join outer request and internal premium requests
        const outerStartLog = logs.find(
          (l) =>
            l.msg === 'request_start' &&
            l.path === '/api/orchestrate' &&
            l.correlationId === outerCorrelationId
        )
        assert.ok(outerStartLog, 'Expected outer request_start log with correlationId')

        const internalPremiumStartLogs = logs.filter(
          (l) => l.msg === 'request_start' && l.path?.startsWith('/api/premium/')
        )
        assert.equal(internalPremiumStartLogs.length, 3)
        assert.deepEqual(
          internalPremiumStartLogs.map((l) => ({
            correlationId: l.correlationId,
            runId: l.runId,
            stepId: l.stepId,
            attempt: l.attempt,
          })),
          [
            { correlationId: outerCorrelationId, runId, stepId: 'step-0', attempt: 1 },
            { correlationId: outerCorrelationId, runId, stepId: 'step-0', attempt: 2 },
            { correlationId: outerCorrelationId, runId, stepId: 'step-1', attempt: 1 },
          ]
        )

        const retryLogs = logs.filter((l) => l.msg === 'x402_retry_attempt')
        assert.equal(retryLogs.length, 1)
        assert.equal(retryLogs[0].correlationId, outerCorrelationId)
        assert.equal(retryLogs[0].runId, runId)
        assert.equal(retryLogs[0].stepId, 'step-0')
        assert.equal(retryLogs[0].attempt, 1)
        assert.equal(retryLogs[0].nextAttempt, 2)

        // 5. Verify persisted run.events preserve correlationId, runId, stepId, and attempt
        const persistedRun = await runHistoryStore.getRun(runId)
        assert.ok(persistedRun)
        assert.equal(persistedRun.correlationId, outerCorrelationId)
        assert.ok(persistedRun.events.length >= 6)

        for (const event of persistedRun.events) {
          assert.equal(
            event.correlationId,
            outerCorrelationId,
            `Event ${event.type} missing correlationId`
          )
          assert.equal(event.runId, runId, `Event ${event.type} missing runId`)
        }

        const retryEvents = persistedRun.events.filter((e) => e.type === 'x402_retry')
        assert.equal(retryEvents.length, 1)
        assert.equal(retryEvents[0].stepId, 'step-0')
        assert.equal(retryEvents[0].attempt, 1)

        const x402PaymentEvents = persistedRun.events.filter((e) => e.type === 'x402_payment')
        assert.equal(x402PaymentEvents.length, 2)
        assert.deepEqual(
          x402PaymentEvents.map((e) => ({
            stepId: e.stepId,
            attempt: e.attempt,
            txHash: e.txHash,
          })),
          [
            { stepId: 'step-0', attempt: 2, txHash: 'tx_step-0_2' },
            { stepId: 'step-1', attempt: 1, txHash: 'tx_step-1_1' },
          ]
        )
      })
    } finally {
      close()
    }
  } finally {
    resetLogSink()
  }
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`)
  process.exit(1)
}
console.log(`\nAll ${passed} correlation propagation tests passed!`)
