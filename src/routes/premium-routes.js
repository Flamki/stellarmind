export function registerPremiumRoutes(app, deps) {
  const { pricingConfig, broadcast, runResearch, runSummary, runAnalysis, runCode, MODEL_LABELS } =
    deps

  app.get('/api/premium/research', async (req, res, next) => {
    try {
      const topic = req.query.topic || 'AI and blockchain payments'
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

  app.get('/api/premium/summarize', async (req, res, next) => {
    try {
      const text = req.query.text || 'Please provide text to summarize via ?text= parameter'
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

  app.get('/api/premium/analyze', async (req, res, next) => {
    try {
      const topic = req.query.topic || 'AI agent economies'
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

  app.get('/api/premium/code', async (req, res, next) => {
    try {
      const prompt = req.query.prompt || 'Write a hello world function'
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
