/**
 * Premium route ownership integration tests (issue #128).
 *
 * These exercise the *shared application* (`createApp`) rather than a
 * bespoke test app, so the production handlers are the ones under test:
 *
 *  - every premium method/path is registered exactly once;
 *  - the payment middleware runs exactly once per request, before handlers;
 *  - each request invokes its service exactly once with normalized,
 *    validated input;
 *  - each call emits exactly one `agent_call` and one `agent_response`;
 *  - the public response fields are unchanged.
 *
 * Run: node tests/premium-routes-ownership.test.js
 */

import assert from 'node:assert'
import { createApp } from '../src/app.js'
import { pricingConfig } from '../src/pricing.config.js'

const PREMIUM_ROUTES = [
  {
    path: '/api/premium/research',
    query: '?topic=%20%20agent%20payments%20%20',
    defaultQuery: '',
    service: 'runResearch',
    normalizedInput: 'agent payments',
    defaultValue: 'AI and blockchain payments',
    responseFields: ['agent', 'topic', 'result', 'model', 'cost', 'paidVia'],
    agent: 'research-bot',
    cost: '0.01',
  },
  {
    path: '/api/premium/summarize',
    query: '?text=%20%20summarize%20this%20%20',
    defaultQuery: '',
    service: 'runSummary',
    normalizedInput: 'summarize this',
    defaultValue: 'Please provide text to summarize via ?text= parameter',
    responseFields: ['agent', 'result', 'model', 'cost', 'paidVia'],
    agent: 'summary-bot',
    cost: '0.01',
  },
  {
    path: '/api/premium/analyze',
    query: '?topic=%20%20market%20structure%20%20',
    defaultQuery: '',
    service: 'runAnalysis',
    normalizedInput: 'market structure',
    defaultValue: 'AI agent economies',
    responseFields: ['agent', 'topic', 'result', 'model', 'cost', 'paidVia'],
    agent: 'analyst-bot',
    cost: '0.05',
  },
  {
    path: '/api/premium/code',
    query: '?prompt=%20%20write%20a%20test%20%20',
    defaultQuery: '',
    service: 'runCode',
    normalizedInput: 'write a test',
    defaultValue: 'Write a hello world function',
    responseFields: ['agent', 'prompt', 'result', 'model', 'cost', 'paidVia'],
    agent: 'code-bot',
    cost: '0.03',
  },
]

function createMockConfig(overrides = {}) {
  return {
    anthropicApiKey: '',
    serverAddress: '',
    facilitatorUrl: 'https://www.x402.org/facilitator',
    network: 'testnet',
    runHistoryStorage: 'memory',
    runHistoryFile: null,
    runHistoryMaxRuns: 200,
    orchestrationQueue: {
      maxConcurrent: 2,
      queueCapacity: 10,
      queueTimeoutMs: 30000,
    },
    ...overrides,
  }
}

function createMockRunHistoryStore() {
  return {
    createRun: async (data) => ({ id: 'run-test', ...data, status: 'running' }),
    getRun: async () => null,
    listRecent: async () => [],
    appendEvent: async () => {},
    recordPaymentAttempt: async () => {},
    completeRun: async () => {},
    failRun: async () => {},
    getIdempotencyRecord: async () => null,
    getPendingPayments: async () => [],
    reconcilePendingPayments: async () => [],
  }
}

/** Builds the app with spied premium services, payment middleware, broadcast. */
function createSpiedApp() {
  const calls = {
    runResearch: [],
    runSummary: [],
    runAnalysis: [],
    runCode: [],
  }
  const events = []
  let paymentMiddlewareCalls = 0

  const spy = (name) => async (input) => {
    calls[name].push(input)
    return `${name}:${input}`
  }

  const paymentMiddleware = (req, res, next) => {
    paymentMiddlewareCalls += 1
    if (req.path.startsWith('/api/premium/') && !req.header('x-payment-context')) {
      return res.status(402).json({ error: 'payment_required' })
    }
    next()
  }

  const { app, close } = createApp({
    config: createMockConfig(),
    pricingConfig,
    runHistoryStore: createMockRunHistoryStore(),
    broadcast: (event) => events.push(event),
    paymentMiddleware,
    premiumServices: {
      runResearch: spy('runResearch'),
      runSummary: spy('runSummary'),
      runAnalysis: spy('runAnalysis'),
      runCode: spy('runCode'),
      MODEL_LABELS: {
        research: 'test-research-model',
        summary: 'test-summary-model',
        analysis: 'test-analysis-model',
        code: 'test-code-model',
      },
    },
  })

  return {
    app,
    close,
    calls,
    events,
    paymentMiddlewareCalls: () => paymentMiddlewareCalls,
  }
}

function routeLayers(app, path) {
  const stack = app.router?.stack || app._router?.stack || []
  return stack.filter((layer) => layer.route && layer.route.path === path)
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

async function requestJson(baseUrl, endpoint, headers = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, { headers })
  const body = await res.json()
  return { status: res.status, body }
}

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

async function run() {
  console.log('premium route ownership')

  // ─── Registration shape ────────────────────────────────────────
  for (const route of PREMIUM_ROUTES) {
    await test(`${route.path} is registered exactly once`, () => {
      const { app, close } = createSpiedApp()
      try {
        assert.strictEqual(
          routeLayers(app, route.path).length,
          1,
          `${route.path} must have exactly one route registration`
        )
      } finally {
        close()
      }
    })
  }

  // ─── Payment middleware order & single application ─────────────
  await test('payment middleware runs once per premium request, before the handler', async () => {
    const { app, close, calls, paymentMiddlewareCalls } = createSpiedApp()
    try {
      await withServer(app, async (baseUrl) => {
        const blocked = await requestJson(baseUrl, `${PREMIUM_ROUTES[0].path}?topic=x`)
        assert.strictEqual(blocked.status, 402)
        assert.strictEqual(paymentMiddlewareCalls(), 1)
        assert.deepStrictEqual(calls.runResearch, [], 'handler must not run without payment')

        const paid = await requestJson(baseUrl, `${PREMIUM_ROUTES[0].path}?topic=x`, {
          'x-payment-context': 'paid',
        })
        assert.strictEqual(paid.status, 200)
        assert.strictEqual(paymentMiddlewareCalls(), 2, 'middleware runs exactly once per request')
      })
    } finally {
      close()
    }
  })

  // ─── One invocation + one event pair per route with normalized input ──
  for (const route of PREMIUM_ROUTES) {
    await test(`${route.path} invokes its service once with normalized input`, async () => {
      const { app, close, calls, events } = createSpiedApp()
      try {
        await withServer(app, async (baseUrl) => {
          const { status, body } = await requestJson(baseUrl, `${route.path}${route.query}`, {
            'x-payment-context': 'paid',
          })

          assert.strictEqual(status, 200)
          assert.deepStrictEqual(calls[route.service], [route.normalizedInput])

          const callEvents = events.filter((event) => event.type === 'agent_call')
          const responseEvents = events.filter((event) => event.type === 'agent_response')
          assert.strictEqual(callEvents.length, 1, 'one agent_call event per request')
          assert.strictEqual(responseEvents.length, 1, 'one agent_response event per request')
          assert.strictEqual(callEvents[0].agentId, route.agent)
          assert.strictEqual(responseEvents[0].agentId, route.agent)
          assert.strictEqual(callEvents[0].cost, route.cost)
          assert.strictEqual(responseEvents[0].cost, route.cost)

          assert.strictEqual(body.agent, route.agent)
          assert.strictEqual(body.paidVia, 'x402')
          assert.strictEqual(body.cost, `${route.cost} USDC`)
          for (const field of route.responseFields) {
            assert.ok(field in body, `response must keep the "${field}" field`)
          }
        })
      } finally {
        close()
      }
    })

    await test(`${route.path} applies the validated default input`, async () => {
      const { app, close, calls } = createSpiedApp()
      try {
        await withServer(app, async (baseUrl) => {
          const { status } = await requestJson(baseUrl, `${route.path}${route.defaultQuery}`, {
            'x-payment-context': 'paid',
          })
          assert.strictEqual(status, 200)
          assert.deepStrictEqual(calls[route.service], [route.defaultValue])
        })
      } finally {
        close()
      }
    })
  }

  // ─── Rejected input never reaches the service or events ───────
  await test('invalid input is rejected before the service or events run', async () => {
    const { app, close, calls, events } = createSpiedApp()
    try {
      await withServer(app, async (baseUrl) => {
        const oversizedTopic = 'x'.repeat(501)
        const { status, body } = await requestJson(
          baseUrl,
          `/api/premium/research?topic=${oversizedTopic}`,
          { 'x-payment-context': 'paid' }
        )
        assert.strictEqual(status, 400)
        assert.strictEqual(body.code, 'INVALID_INPUT')
        assert.deepStrictEqual(calls.runResearch, [])
        assert.strictEqual(events.length, 0)
      })
    } finally {
      close()
    }
  })

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    for (const { name, err } of failures) {
      console.error(`\n${name}:\n${err.stack}`)
    }
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('premium route ownership tests failed')
  console.error(err)
  process.exit(1)
})
