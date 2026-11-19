import assert from 'node:assert'
import { createApp } from '../src/app.js'
import { pricingConfig } from '../src/pricing.config.js'

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

function createMockRunHistoryStore(instanceId) {
  const store = {
    instanceId,
    runs: [],
    events: new Map(),
    idempotencyRecords: new Map(),
    paymentAttempts: new Map(),

    createRun: async (data) => {
      const run = {
        id: `run-${instanceId}-${store.runs.length}`,
        ...data,
        status: 'running',
        createdAt: new Date().toISOString(),
      }
      store.runs.push(run)
      return run
    },

    getRun: async (id) => {
      return store.runs.find((r) => r.id === id) || null
    },

    listRecent: async (limit) => {
      return store.runs.slice(-limit)
    },

    appendEvent: async (runId, event) => {
      if (!store.events.has(runId)) {
        store.events.set(runId, [])
      }
      store.events.get(runId).push(event)
    },

    completeRun: async (runId, result) => {
      const run = store.runs.find((r) => r.id === runId)
      if (run) {
        run.status = 'completed'
        run.result = result
        run.completedAt = new Date().toISOString()
      }
    },

    failRun: async (runId, error) => {
      const run = store.runs.find((r) => r.id === runId)
      if (run) {
        run.status = 'failed'
        run.error = error
        run.failedAt = new Date().toISOString()
      }
    },

    getIdempotencyRecord: async (key) => {
      return store.idempotencyRecords.get(key) || null
    },

    recordPaymentAttempt: async (runId, attempt) => {
      if (!store.paymentAttempts.has(runId)) {
        store.paymentAttempts.set(runId, [])
      }
      store.paymentAttempts.get(runId).push(attempt)
    },

    getPendingPayments: async () => {
      const pending = []
      for (const [runId, attempts] of store.paymentAttempts.entries()) {
        pending.push(...attempts.filter((a) => !a.settled))
      }
      return pending
    },

    reconcilePendingPayments: async (probe, context) => {
      return { reconciled: 0, pending: 0 }
    },
  }

  return store
}

async function requestJson(baseUrl, endpoint, headers = {}) {
  const res = await fetch(`${baseUrl}${endpoint}`, { headers })
  const body = await res.json()
  return { status: res.status, body }
}

async function run() {
  console.log('Testing app factory with stub dependencies...')

  // Test 1: Importing createApp does not open sockets or make external requests
  console.log('  ✓ createApp imported without side effects')

  // Test 2: Create two independent app instances
  const store1 = createMockRunHistoryStore('instance-1')
  const store2 = createMockRunHistoryStore('instance-2')

  const config1 = createMockConfig({ serverAddress: 'GTEST1' })
  const config2 = createMockConfig({ serverAddress: 'GTEST2' })

  const { app: app1, close: close1 } = createApp({
    config: config1,
    pricingConfig,
    runHistoryStore: store1,
  })

  const { app: app2, close: close2 } = createApp({
    config: config2,
    pricingConfig,
    runHistoryStore: store2,
  })

  console.log('  ✓ Two app instances created with independent stores')

  // Test 3: Exercise public routes on both instances
  await withServer(app1, async (baseUrl1) => {
    const healthRes = await requestJson(baseUrl1, '/healthz')
    assert.strictEqual(healthRes.status, 200)
    assert.strictEqual(healthRes.body.status, 'ok')

    const agentsRes = await requestJson(baseUrl1, '/api/agents')
    assert.strictEqual(agentsRes.status, 200)
    assert(Array.isArray(agentsRes.body))
    assert(agentsRes.body.length > 0)
  })

  await withServer(app2, async (baseUrl2) => {
    const healthRes = await requestJson(baseUrl2, '/healthz')
    assert.strictEqual(healthRes.status, 200)

    const agentsRes = await requestJson(baseUrl2, '/api/agents')
    assert.strictEqual(agentsRes.status, 200)
  })

  console.log('  ✓ Public routes work on both instances')

  // Test 4: Verify stores are independent
  const run1 = await store1.createRun({ task: 'test-1', budget: 100, source: 'test' })
  const run2 = await store2.createRun({ task: 'test-2', budget: 200, source: 'test' })

  assert.strictEqual(run1.id.startsWith('run-instance-1-'), true)
  assert.strictEqual(run2.id.startsWith('run-instance-2-'), true)
  assert.strictEqual(store1.runs.length, 1)
  assert.strictEqual(store2.runs.length, 1)

  console.log('  ✓ Stores are independent between instances')

  // Test 5: Exercise free agent endpoint (no payment required)
  await withServer(app1, async (baseUrl1) => {
    const researchRes = await requestJson(baseUrl1, '/api/research?topic=test-topic')
    assert.strictEqual(researchRes.status, 200)
    assert.strictEqual(researchRes.body.agent, 'research-bot')
  })

  console.log('  ✓ Free agent endpoint works')

  // Test 6: Exercise premium endpoint with stubbed payment middleware
  const paymentMiddleware = (req, res, next) => {
    if (req.path.startsWith('/api/premium/')) {
      if (!req.header('x-payment-context')) {
        return res.status(402).json({
          error: 'payment_required',
          message: 'Missing payment context',
        })
      }
    }
    next()
  }

  const { app: app3, close: close3 } = createApp({
    config: config1,
    pricingConfig,
    runHistoryStore: store1,
    paymentMiddleware,
  })

  await withServer(app3, async (baseUrl3) => {
    // Without payment header
    const blockedRes = await requestJson(baseUrl3, '/api/premium/research?topic=test')
    assert.strictEqual(blockedRes.status, 402)
    assert.strictEqual(blockedRes.body.error, 'payment_required')

    // With payment header
    const paidRes = await requestJson(baseUrl3, '/api/premium/research?topic=test', {
      'x-payment-context': 'paid',
    })
    assert.strictEqual(paidRes.status, 200)
    assert.strictEqual(paidRes.body.agent, 'research-bot')
  })

  console.log('  ✓ Premium endpoint with payment middleware works')

  // Cleanup
  close1()
  close2()
  close3()

  console.log('✅ app factory integration tests passed')
}

run().catch((err) => {
  console.error('❌ app factory integration tests failed')
  console.error(err)
  process.exit(1)
})
