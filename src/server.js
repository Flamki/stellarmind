import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { config } from './config.js'
import { pricingConfig } from './pricing.config.js'
import { validateAll, formatValidationErrors } from './pricing.validator.js'
import { AGENTS, discoverAgents, getAgentById } from './agents/registry.js'
import {
  runResearch,
  runSummary,
  runAnalysis,
  runCode,
  setApiKey,
  MODEL_LABELS,
} from './agents/services.js'
import { orchestrate } from './agents/orchestrator.js'
import { getBalance, getTransactions } from './stellar/wallet.js'
import { requestId, requestLogger, errorHandler } from './middleware/errorHandler.js'
import { apikeyLimiter } from './middleware/rateLimiter.js'
import { logger } from './logger.js'
import { adminAuth } from './middleware/auth.js'
import { registerPremiumRoutes } from './routes/premium-routes.js'
import { createRunHistoryStore } from './storage/run-history.js'

// x402 imports
import { paymentMiddlewareFromConfig } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { ExactStellarScheme } from '@x402/stellar/exact/server'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

// ─── Validate Pricing Configuration at Startup ──────────────
const pricingValidation = validateAll(pricingConfig, {
  network: config.network,
  payTo: config.serverAddress,
})

if (!pricingValidation.valid) {
  logger.error('pricing_config_validation_failed', { errors: pricingValidation.errors })
  logger.error('pricing_config_validation_details', {
    details: formatValidationErrors(pricingValidation),
  })
  process.exit(1)
}
logger.info('pricing_config_validated')

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '..', 'public')))
app.use(requestId)
app.use(requestLogger)

// ─── SSE Event Stream ────────────────────────────────────────
const sseClients = []
let x402MiddlewareReady = false
const runHistoryStore = await createRunHistoryStore(config)

function broadcast(event) {
  const data = JSON.stringify(event)
  sseClients.forEach((res) => {
    res.write(`data: ${data}\n\n`)
  })
}

function buildReadinessPayload() {
  const anthropicConfigured = !!config.anthropicApiKey
  const x402Enabled = !!config.serverAddress

  const components = {
    app: {
      ready: true,
      description: 'Core HTTP server initialized',
    },
    anthropic: {
      configured: anthropicConfigured,
      ready: anthropicConfigured,
      description: anthropicConfigured
        ? 'Anthropic API key is configured for Claude-powered agents'
        : 'Missing Anthropic API key; demo fallback responses are available',
    },
    x402: {
      enabled: x402Enabled,
      ready: !x402Enabled || (x402MiddlewareReady && !!config.facilitatorUrl),
      description: x402Enabled
        ? x402MiddlewareReady
          ? 'x402 payment middleware initialized'
          : 'x402 is enabled but middleware initialization failed'
        : 'x402 paywall is disabled; premium endpoints are not protected by payments',
    },
  }

  const ready = Object.values(components).every((component) => component.ready)
  return {
    status: ready ? 'ready' : 'not_ready',
    ready,
    timestamp: new Date().toISOString(),
    components,
  }
}

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

app.get('/readyz', (req, res) => {
  const payload = buildReadinessPayload()
  res.status(payload.ready ? 200 : 503).json(payload)
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // Send initial connection event
  res.write(
    `data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`
  )

  sseClients.push(res)
  req.on('close', () => {
    const idx = sseClients.indexOf(res)
    if (idx !== -1) sseClients.splice(idx, 1)
  })
})

// ─── x402 Middleware (paywall for premium endpoints) ─────────
if (config.serverAddress) {
  try {
    const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl })
    const stellarScheme = new ExactStellarScheme()

    // Use pricing config to generate x402 middleware configuration
    const x402PricingConfig = pricingConfig.getX402Config({
      network: config.network,
      payTo: config.serverAddress,
    })

    app.use(
      paymentMiddlewareFromConfig(x402PricingConfig, facilitatorClient, [
        { network: config.network, server: stellarScheme },
      ])
    )
    x402MiddlewareReady = true
    logger.info('x402_middleware_active')
  } catch (err) {
    x402MiddlewareReady = false
    logger.warn('x402_middleware_init_failed', { error: err.message })
  }
} else {
  x402MiddlewareReady = false
  logger.warn('x402_paywall_disabled', { reason: 'SERVER_STELLAR_ADDRESS not configured' })
}

// ─── Premium x402-Protected Endpoints ────────────────────────
app.get('/api/premium/research', validatePremiumQuery, async (req, res, next) => {
  try {
    const topic = req.validated.topic
    const priceInfo = pricingConfig.getEndpointInfo('GET /api/premium/research')
    const cost = priceInfo.price.slice(1) // Remove '$' for display
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

app.get('/api/premium/summarize', validatePremiumQuery, async (req, res, next) => {
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

app.get('/api/premium/analyze', validatePremiumQuery, async (req, res, next) => {
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

app.get('/api/premium/code', validatePremiumQuery, async (req, res, next) => {
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
registerPremiumRoutes(app, {
  pricingConfig,
  broadcast,
  runResearch,
  runSummary,
  runAnalysis,
  runCode,
  MODEL_LABELS,
})

// ─── Free Agent Endpoints (for internal orchestrator use) ────
app.get('/api/research', async (req, res, next) => {
  try {
    const topic = req.query.topic || 'AI payments'
    const result = await runResearch(topic)
    res.json({
      agent: 'research-bot',
      topic,
      result,
      model: MODEL_LABELS.research,
      cost: '0.01 USDC',
    })
  } catch (err) {
    next(err)
  }
})

app.get('/api/summarize', async (req, res, next) => {
  try {
    const text = req.query.text || ''
    const result = await runSummary(text)
    res.json({ agent: 'summary-bot', result, model: MODEL_LABELS.summary, cost: '0.01 USDC' })
  } catch (err) {
    next(err)
  }
})

app.get('/api/analyze', async (req, res, next) => {
  try {
    const topic = req.query.topic || ''
    const result = await runAnalysis(topic)
    res.json({
      agent: 'analyst-bot',
      topic,
      result,
      model: MODEL_LABELS.analysis,
      cost: '0.05 USDC',
    })
  } catch (err) {
    next(err)
  }
})

app.get('/api/code', async (req, res, next) => {
  try {
    const prompt = req.query.prompt || ''
    const result = await runCode(prompt)
    res.json({ agent: 'code-bot', result, model: MODEL_LABELS.code, cost: '0.03 USDC' })
  } catch (err) {
    next(err)
  }
})

// ─── Orchestrator Endpoint ───────────────────────────────────
app.post('/api/orchestrate', validateOrchestrate, async (req, res, next) => {
  try {
    const { task, budget } = req.validated
    const run = await runHistoryStore.createRun({
      task,
      budget,
      source: 'POST /api/orchestrate',
    })
    const runBroadcast = (event) => {
      const eventWithRun = { ...event, runId: run.id }
      broadcast(eventWithRun)
      runHistoryStore.appendEvent(run.id, eventWithRun).catch((persistErr) => {
        logger.warn('run_history_append_failed', { runId: run.id, error: persistErr.message })
      })
    }

    let result
    try {
      result = await orchestrate(task, budget, runBroadcast, { correlationId: req.requestId })
      await runHistoryStore.completeRun(run.id, result)
    } catch (err) {
      await runHistoryStore.failRun(run.id, err)
      throw err
    }

    result.runId = run.id
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Also support GET for easy testing
app.get('/api/orchestrate', validateOrchestrate, async (req, res, next) => {
  try {
    const { task, budget } = req.validated
    const run = await runHistoryStore.createRun({
      task,
      budget,
      source: 'GET /api/orchestrate',
    })
    const runBroadcast = (event) => {
      const eventWithRun = { ...event, runId: run.id }
      broadcast(eventWithRun)
      runHistoryStore.appendEvent(run.id, eventWithRun).catch((persistErr) => {
        logger.warn('run_history_append_failed', { runId: run.id, error: persistErr.message })
      })
    }

    let result
    try {
      result = await orchestrate(task, budget, runBroadcast, { correlationId: req.requestId })
      await runHistoryStore.completeRun(run.id, result)
    } catch (err) {
      await runHistoryStore.failRun(run.id, err)
      throw err
    }

    result.runId = run.id
    res.json(result)
  } catch (err) {
    next(err)
  }
})

app.get('/api/runs', async (req, res, next) => {
  try {
    const limit = req.query.limit || 20
    const runs = await runHistoryStore.listRecent(limit)
    res.json({
      storage: config.runHistoryStorage,
      file: config.runHistoryStorage === 'file' ? config.runHistoryFile : null,
      count: runs.length,
      runs,
    })
  } catch (err) {
    next(err)
  }
})

// ─── Agent Registry Endpoints ────────────────────────────────
app.get('/api/agents', (req, res) => {
  res.json(AGENTS)
})

app.get('/api/agents/discover/:capability', (req, res) => {
  const results = discoverAgents(req.params.capability)
  res.json(results)
})

app.get('/api/agents/:id', (req, res, next) => {
  const agent = getAgentById(req.params.id)
  if (!agent) {
    const err = new Error('Agent not found')
    err.status = 404
    err.code = 'NOT_FOUND'
    return next(err)
  }
  res.json(agent)
})

// ─── Wallet Endpoints ────────────────────────────────────────
app.get('/api/wallet/balances', async (req, res, next) => {
  try {
    const wallets = {}
    if (config.serverAddress) {
      wallets.server = {
        address: config.serverAddress,
        balances: await getBalance(config.serverAddress),
      }
    }
    if (config.orchestratorAddress) {
      wallets.orchestrator = {
        address: config.orchestratorAddress,
        balances: await getBalance(config.orchestratorAddress),
      }
    }
    if (config.buyerAddress) {
      wallets.buyer = {
        address: config.buyerAddress,
        balances: await getBalance(config.buyerAddress),
      }
    }
    res.json(wallets)
  } catch (err) {
    next(err)
  }
})

app.get('/api/wallet/transactions', validateWalletTransactions, async (req, res, next) => {
  try {
    const address = req.validated?.address || config.orchestratorAddress || config.serverAddress
    if (!address) return res.json([])

    // 1. Validate & clamp "limit"
    let limit = 20 // default
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(req.query.limit, 10)
      if (
        isNaN(parsedLimit) ||
        parsedLimit <= 0 ||
        String(parsedLimit) !== String(req.query.limit)
      ) {
        const err = new Error('Invalid query parameter "limit". Must be a positive integer.')
        err.status = 400
        err.code = 'INVALID_LIMIT'
        return next(err)
      }
      limit = Math.max(1, Math.min(200, parsedLimit))
    }

    // 2. Validate "order"/"direction"
    let order = 'desc' // default
    const directionParam = req.query.direction || req.query.order
    if (directionParam !== undefined) {
      const normalizedDir = String(directionParam).toLowerCase()
      if (normalizedDir !== 'asc' && normalizedDir !== 'desc') {
        const err = new Error(
          'Invalid query parameter "direction"/"order". Must be "asc" or "desc".'
        )
        err.status = 400
        err.code = 'INVALID_DIRECTION'
        return next(err)
      }
      order = normalizedDir
    }

    // 3. Extract & validate "cursor" / "page" (supporting both)
    const cursor = req.query.cursor || req.query.page || null
    if (cursor !== null && typeof cursor !== 'string') {
      const err = new Error('Invalid query parameter "cursor"/"page". Must be a string.')
      err.status = 400
      err.code = 'INVALID_CURSOR'
      return next(err)
    }

    const txs = await getTransactions(address, limit, cursor, order)
    res.json(txs)
  } catch (err) {
    next(err)
  }
})

// ─── System Status ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const premiumEndpoints = pricingConfig
    .getAllPricingInfo()
    .map((info) => `${info.endpoint} (${info.price})`)

  res.json({
    name: 'StellarMind',
    version: '1.0.0',
    description: 'AI Agent Marketplace with x402 Micropayments on Stellar',
    status: 'online',
    network: config.network,
    facilitator: config.facilitatorUrl,
    agents: AGENTS.length,
    x402: {
      enabled: !!config.serverAddress,
      middleware: '@x402/express (paymentMiddlewareFromConfig)',
      client: '@x402/fetch (wrapFetchWithPayment + ExactStellarScheme)',
      premiumEndpoints,
      pricing: pricingConfig.getAllPricingInfo(),
      flow: '402 → wrapFetchWithPayment signs USDC tx → retry with X-PAYMENT → facilitator settles on-chain → 200',
    },
    wallets: {
      server: config.serverAddress ? `${config.serverAddress.slice(0, 8)}...` : 'not configured',
      orchestrator: config.orchestratorAddress
        ? `${config.orchestratorAddress.slice(0, 8)}...`
        : 'not configured',
      buyer: config.buyerAddress ? `${config.buyerAddress.slice(0, 8)}...` : 'not configured',
    },
    claudeEnabled: !!config.anthropicApiKey,
    runHistory: {
      storage: config.runHistoryStorage,
      file: config.runHistoryStorage === 'file' ? config.runHistoryFile : null,
      maxRuns: config.runHistoryMaxRuns,
    },
  })
})

// ─── API Key Configuration ───────────────────────────────────
app.get('/api/config/apikey', apikeyLimiter, (req, res) => {
  const key = config.anthropicApiKey || ''
  res.json({
    configured: !!key,
    masked: key ? `sk-ant-...${key.slice(-6)}` : null,
  })
})

app.post('/api/config/apikey', apikeyLimiter, adminAuth, (req, res, next) => {
  const { apiKey } = req.body
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    const err = new Error('Invalid API key. Must start with sk-ant-')
    err.status = 400
    err.code = 'INVALID_API_KEY'
    return next(err)
  }
  // Security: Log only that a key was updated, never log the key itself
  logger.info('api_key_updated', { correlationId: req.requestId })
  setApiKey(apiKey)
  res.json({ success: true, masked: `sk-ant-...${apiKey.slice(-6)}` })
})

// ─── Serve Dashboard ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

// ─── Centralized Error Handler ───────────────────────────────
app.use(errorHandler)

// ─── Start Server ────────────────────────────────────────────
const PORT = config.port
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║         🧠 StellarMind — AI Agent Marketplace     ║
║         x402 Micropayments on Stellar Testnet     ║
╠══════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}               ║
║  API:        http://localhost:${PORT}/api/status     ║
║  Agents:     http://localhost:${PORT}/api/agents     ║
║  Events:     http://localhost:${PORT}/api/events     ║
╠══════════════════════════════════════════════════╣
║  Network:    ${config.network.padEnd(34)}║
║  Claude AI:  ${(config.anthropicApiKey ? '✅ Connected' : '❌ No API key').padEnd(34)}║
║  x402:       ${(config.serverAddress ? '✅ Active' : '⚠️  No wallet').padEnd(34)}║
╚══════════════════════════════════════════════════╝
  `)
})
