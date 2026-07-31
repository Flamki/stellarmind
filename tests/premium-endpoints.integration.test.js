import assert from 'node:assert'
import express from 'express'
import { pricingConfig } from '../src/pricing.config.js'
import { registerPremiumRoutes } from '../src/routes/premium-routes.js'

function createTestApp({ withPaymentHeaderRequired = true } = {}) {
  const app = express()

  // Mock payment middleware: block premium endpoints unless payment header exists.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/premium/')) return next()
    if (!withPaymentHeaderRequired) return next()

    if (!req.header('x-payment-context')) {
      return res.status(402).json({
        error: 'payment_required',
        message: 'Missing payment context',
      })
    }
    return next()
  })

  const calls = {
    research: 0,
    summary: 0,
    analysis: 0,
    code: 0,
  }

  registerPremiumRoutes(app, {
    pricingConfig,
    broadcast: () => {},
    runResearch: async (topic) => {
      calls.research += 1
      return `research:${topic}`
    },
    runSummary: async (text) => {
      calls.summary += 1
      return `summary:${text}`
    },
    runAnalysis: async (topic) => {
      calls.analysis += 1
      return `analysis:${topic}`
    },
    runCode: async (prompt) => {
      calls.code += 1
      return `code:${prompt}`
    },
    MODEL_LABELS: {
      research: 'test-research-model',
      summary: 'test-summary-model',
      analysis: 'test-analysis-model',
      code: 'test-code-model',
    },
  })

  return { app, calls }
}

async function requestJson(baseUrl, endpoint, payment = false) {
  const headers = payment ? { 'x-payment-context': 'paid' } : {}
  const res = await fetch(`${baseUrl}${endpoint}`, { headers })
  const body = await res.json()
  return { status: res.status, body }
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

async function run() {
  const endpoints = [
    '/api/premium/research?topic=test-topic',
    '/api/premium/summarize?text=test-text',
    '/api/premium/analyze?topic=test-topic',
    '/api/premium/code?prompt=test-prompt',
  ]

  // Without payment context => blocked by middleware
  {
    const { app, calls } = createTestApp()
    await withServer(app, async (baseUrl) => {
      for (const endpoint of endpoints) {
        const { status, body } = await requestJson(baseUrl, endpoint, false)
        assert.strictEqual(status, 402, `Expected 402 for ${endpoint} without payment context`)
        assert.strictEqual(
          body.error,
          'payment_required',
          `Expected payment_required payload for ${endpoint}`
        )
      }
    })
    assert.deepStrictEqual(
      calls,
      { research: 0, summary: 0, analysis: 0, code: 0 },
      'Agent handlers must not execute on 402'
    )
  }

  // With payment context => premium handlers succeed
  {
    const { app, calls } = createTestApp()
    await withServer(app, async (baseUrl) => {
      const research = await requestJson(baseUrl, '/api/premium/research?topic=my-topic', true)
      assert.strictEqual(research.status, 200)
      assert.strictEqual(research.body.agent, 'research-bot')
      assert.strictEqual(research.body.paidVia, 'x402')
      assert.strictEqual(research.body.cost, '0.01 USDC')

      const summarize = await requestJson(baseUrl, '/api/premium/summarize?text=my-text', true)
      assert.strictEqual(summarize.status, 200)
      assert.strictEqual(summarize.body.agent, 'summary-bot')
      assert.strictEqual(summarize.body.paidVia, 'x402')
      assert.strictEqual(summarize.body.cost, '0.01 USDC')

      const analyze = await requestJson(baseUrl, '/api/premium/analyze?topic=my-topic', true)
      assert.strictEqual(analyze.status, 200)
      assert.strictEqual(analyze.body.agent, 'analyst-bot')
      assert.strictEqual(analyze.body.paidVia, 'x402')
      assert.strictEqual(analyze.body.cost, '0.05 USDC')

      const code = await requestJson(baseUrl, '/api/premium/code?prompt=my-prompt', true)
      assert.strictEqual(code.status, 200)
      assert.strictEqual(code.body.agent, 'code-bot')
      assert.strictEqual(code.body.paidVia, 'x402')
      assert.strictEqual(code.body.cost, '0.03 USDC')
    })

    assert.deepStrictEqual(
      calls,
      { research: 1, summary: 1, analysis: 1, code: 1 },
      'Each premium handler should run exactly once with payment'
    )
  }

  console.log('✅ premium endpoint integration tests passed')
}

run().catch((err) => {
  console.error('❌ premium endpoint integration tests failed')
  console.error(err)
  process.exit(1)
})
