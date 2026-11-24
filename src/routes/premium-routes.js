import { validatePremiumQuery } from '../requestValidation.js'

/**
 * Registers the four premium GET handlers.
 *
 * This module is the sole owner of the premium routes (issue #128): the
 * application registers them here once, behind the payment middleware, and
 * every handler reads the normalized input produced by
 * `validatePremiumQuery` (`req.validated`) instead of re-reading raw query
 * parameters. That keeps the production handlers and the integration suite
 * on the same code path, and keeps validated input, pricing, broadcast
 * events, and public response fields identical for every route.
 *
 * @param {Object} app - Express application
 * @param {Object} deps - Handler dependencies
 * @param {Object} deps.pricingConfig - Pricing configuration (`getEndpointInfo`)
 * @param {Function} [deps.broadcast] - SSE broadcast function
 * @param {Function} deps.runResearch - Research service
 * @param {Function} deps.runSummary - Summary service
 * @param {Function} deps.runAnalysis - Analysis service
 * @param {Function} deps.runCode - Code service
 * @param {Object} deps.MODEL_LABELS - Model label map exposed in responses
 * @param {Function} [deps.validate] - Request validator (defaults to validatePremiumQuery)
 */
export function registerPremiumRoutes(app, deps = {}) {
  const {
    pricingConfig,
    broadcast = () => {},
    runResearch,
    runSummary,
    runAnalysis,
    runCode,
    MODEL_LABELS,
    validate = validatePremiumQuery,
  } = deps

  app.get('/api/premium/research', validate, async (req, res, next) => {
    try {
      const topic = req.validated.topic
      const priceInfo = pricingConfig.getEndpointInfo('GET /api/premium/research')
      const cost = priceInfo.price.slice(1)
      broadcast({
        type: 'agent_call',
        agent: `${priceInfo.emoji} Research Agent`,
        agentId: 'research-bot',
        input: topic,
        cost,
        timestamp: new Date().toISOString(),
      })
      const result = await runResearch(topic)
      broadcast({
        type: 'agent_response',
        agent: `${priceInfo.emoji} Research Agent`,
        agentId: 'research-bot',
        resultPreview: result.substring(0, 150),
        cost,
        timestamp: new Date().toISOString(),
      })
      res.json({
        agent: 'research-bot',
        topic,
        result,
        model: MODEL_LABELS.research,
        cost: `${cost} USDC`,
        paidVia: 'x402',
      })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/premium/summarize', validate, async (req, res, next) => {
    try {
      const text = req.validated.text
      const priceInfo = pricingConfig.getEndpointInfo('GET /api/premium/summarize')
      const cost = priceInfo.price.slice(1)
      broadcast({
        type: 'agent_call',
        agent: `${priceInfo.emoji} Summary Agent`,
        agentId: 'summary-bot',
        input: text.substring(0, 100),
        cost,
        timestamp: new Date().toISOString(),
      })
      const result = await runSummary(text)
      broadcast({
        type: 'agent_response',
        agent: `${priceInfo.emoji} Summary Agent`,
        agentId: 'summary-bot',
        resultPreview: result.substring(0, 150),
        cost,
        timestamp: new Date().toISOString(),
      })
      res.json({
        agent: 'summary-bot',
        result,
        model: MODEL_LABELS.summary,
        cost: `${cost} USDC`,
        paidVia: 'x402',
      })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/premium/analyze', validate, async (req, res, next) => {
    try {
      const topic = req.validated.topic
      const priceInfo = pricingConfig.getEndpointInfo('GET /api/premium/analyze')
      const cost = priceInfo.price.slice(1)
      broadcast({
        type: 'agent_call',
        agent: `${priceInfo.emoji} Analysis Agent`,
        agentId: 'analyst-bot',
        input: topic,
        cost,
        timestamp: new Date().toISOString(),
      })
      const result = await runAnalysis(topic)
      broadcast({
        type: 'agent_response',
        agent: `${priceInfo.emoji} Analysis Agent`,
        agentId: 'analyst-bot',
        resultPreview: result.substring(0, 150),
        cost,
        timestamp: new Date().toISOString(),
      })
      res.json({
        agent: 'analyst-bot',
        topic,
        result,
        model: MODEL_LABELS.analysis,
        cost: `${cost} USDC`,
        paidVia: 'x402',
      })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/premium/code', validate, async (req, res, next) => {
    try {
      const prompt = req.validated.prompt
      const priceInfo = pricingConfig.getEndpointInfo('GET /api/premium/code')
      const cost = priceInfo.price.slice(1)
      broadcast({
        type: 'agent_call',
        agent: `${priceInfo.emoji} Code Agent`,
        agentId: 'code-bot',
        input: prompt.substring(0, 100),
        cost,
        timestamp: new Date().toISOString(),
      })
      const result = await runCode(prompt)
      broadcast({
        type: 'agent_response',
        agent: `${priceInfo.emoji} Code Agent`,
        agentId: 'code-bot',
        resultPreview: result.substring(0, 150),
        cost,
        timestamp: new Date().toISOString(),
      })
      res.json({
        agent: 'code-bot',
        prompt,
        result,
        model: MODEL_LABELS.code,
        cost: `${cost} USDC`,
        paidVia: 'x402',
      })
    } catch (err) {
      next(err)
    }
  })
}
