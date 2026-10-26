import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { AGENTS, discoverAgents, getAgentById } from './agents/registry.js'
import { validateWalletTransactions } from './requestValidation.js'
import {
  runResearch,
  runSummary,
  runAnalysis,
  runCode,
  setApiKey,
  MODEL_LABELS,
} from './agents/services.js'
import { orchestrate, activePlansStore } from './agents/orchestrator.js'
import { OrchestrationAdmissionQueue } from './agents/orchestration-queue.js'
import { getBalance, getTransactions } from './stellar/wallet.js'
import { requestId, requestLogger, errorHandler } from './middleware/errorHandler.js'
import { apikeyLimiter } from './middleware/rateLimiter.js'
import { logger } from './logger.js'
import { adminAuth } from './middleware/auth.js'
import { registerPremiumRoutes } from './routes/premium-routes.js'
import { registerOrchestrationRoutes } from './routes/orchestration-routes.js'
import { INTERRUPTED_REASON_SHUTDOWN_TIMEOUT } from './storage/run-history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Create and configure the Express application with injected dependencies.
 * This function does not open sockets or make external requests.
 *
 * @param {Object} dependencies - Injected dependencies
 * @param {Object} dependencies.config - Application configuration
 * @param {Object} dependencies.pricingConfig - Pricing configuration
 * @param {Object} dependencies.runHistoryStore - Run history storage instance
 * @param {Object} dependencies.broadcast - SSE broadcast function
 * @param {Function} [dependencies.paymentMiddleware] - Optional x402 payment middleware
 * @param {Object} [dependencies.admissionQueue] - Optional orchestration admission queue
 * @param {Object} [dependencies.premiumServices] - Optional premium handler injections
 *   ({ runResearch, runSummary, runAnalysis, runCode, MODEL_LABELS })
 * @returns {Object} { app, close } - Express app and cleanup function
 */
export function createApp(dependencies = {}) {
  const {
    config,
    pricingConfig,
    runHistoryStore,
    broadcast,
    paymentMiddleware,
    paymentProbe,
    orchestrate: orchestrateFn = orchestrate,
    admissionQueue = new OrchestrationAdmissionQueue(config.orchestrationQueue),
    premiumServices = {},
  } = dependencies

  const app = express()

  // Graceful shutdown state
  let draining = false
  let refusingNewWork = false
  let shutdownPromise = null

  const shutdownState = {
    isDraining: () => draining,
    isRefusingNewWork: () => refusingNewWork,
    markNotReady: () => {
      draining = true
    },
    refuseNewWork: () => {
      draining = true
      refusingNewWork = true
    },
  }

  // Basic middleware
  app.use(cors())
  app.use(express.json())
  app.use(express.static(path.join(__dirname, '..', 'public')))
  app.use(requestId)
  app.use(requestLogger)

  // SSE Event Stream clients (state per app instance)
  const sseClients = []

  function broadcastEvent(event) {
    const data = JSON.stringify(event)
    sseClients.forEach((res) => {
      try {
        res.write(`data: ${data}\n\n`)
      } catch {
        // Ignore write errors on closing clients
      }
    })
  }

  // Use injected broadcast or local implementation
  const actualBroadcast = broadcast || broadcastEvent

  // Track x402 middleware readiness for readiness checks
  let x402MiddlewareReady = !!paymentMiddleware

  function buildReadinessPayload() {
    const anthropicConfigured = !!config.anthropicApiKey
    const x402Enabled = !!config.serverAddress

    const components = {
      app: {
        ready: !draining,
        draining,
        description: draining
          ? 'Server is draining for graceful shutdown'
          : 'Core HTTP server initialized',
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

    const ready = !draining && Object.values(components).every((component) => component.ready)
    return {
      status: ready ? 'ready' : 'not_ready',
      ready,
      draining,
      timestamp: new Date().toISOString(),
      components,
    }
  }

  // Health check endpoint
  app.get('/healthz', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    })
  })

  // Readiness check endpoint
  app.get('/readyz', (req, res) => {
    const payload = buildReadinessPayload()
    res.status(payload.ready ? 200 : 503).json(payload)
  })

  // SSE Events endpoint
  app.get('/api/events', (req, res) => {
    if (draining) {
      res.setHeader('Retry-After', '5')
      return res.status(503).json({
        error: {
          message: 'Server is draining for shutdown and not accepting new SSE connections',
          code: 'SERVER_DRAINING',
          status: 503,
        },
      })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    res.write(
      `data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`
    )

    sseClients.push(res)
    req.on('close', () => {
      const idx = sseClients.indexOf(res)
      if (idx !== -1) sseClients.splice(idx, 1)
    })
  })

  // Apply x402 payment middleware once, before the routes it protects
  if (paymentMiddleware) {
    app.use(paymentMiddleware)
    x402MiddlewareReady = true
  }

  // Premium routes are registered only here, by their route module (issue
  // #128). Registering the same paths a second time in this factory meant
  // requests never reached the module the integration suite exercised, so
  // validated input and handler behaviour could silently diverge.
  registerPremiumRoutes(app, {
    pricingConfig,
    broadcast: actualBroadcast,
    runResearch,
    runSummary,
    runAnalysis,
    runCode,
    MODEL_LABELS,
    ...premiumServices,
  })

  // Free Agent Endpoints (for internal orchestrator use)
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

  // Orchestrator Endpoint (sync + async modes)
  const orchestrationController = registerOrchestrationRoutes(app, {
    runHistoryStore,
    orchestrate: orchestrateFn,
    broadcast: actualBroadcast,
    paymentProbe,
    admissionQueue,
    shutdownState,
  })

  // Agent Registry Endpoints
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

  // Wallet Endpoints
  app.get('/api/wallet/balances', async (req, res, next) => {
    try {
      const wallets = {}
      const walletConfigs = []

      if (config.serverAddress) {
        walletConfigs.push({ key: 'server', address: config.serverAddress })
      }
      if (config.orchestratorAddress) {
        walletConfigs.push({ key: 'orchestrator', address: config.orchestratorAddress })
      }
      if (config.buyerAddress) {
        walletConfigs.push({ key: 'buyer', address: config.buyerAddress })
      }

      const results = await Promise.all(
        walletConfigs.map(async ({ key, address }) => {
          const result = await getBalance(address)
          return { key, address, ...result }
        })
      )

      let hasAnyError = false
      for (const result of results) {
        const { key, address, success, balances, error, errorType, timestamp } = result

        if (success) {
          wallets[key] = {
            address,
            balances,
            available: true,
          }
        } else {
          hasAnyError = true
          wallets[key] = {
            address,
            available: false,
            error: error || 'Unknown error',
            errorType: errorType || 'UPSTREAM_ERROR',
            timestamp: timestamp || new Date().toISOString(),
          }
        }
      }

      const response = {
        wallets,
        timestamp: new Date().toISOString(),
        correlationId: req.requestId,
      }

      if (hasAnyError) {
        response.partialAvailability = true
        response.message =
          'Some wallet data could not be retrieved. Check individual wallet status.'
      }

      res.json(response)
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/wallet/transactions', validateWalletTransactions, async (req, res, next) => {
    try {
      const address = req.validated?.address || config.orchestratorAddress || config.serverAddress
      if (!address) {
        return res.json({
          success: true,
          transactions: [],
          message: 'No wallet address configured',
        })
      }

      let limit = 20
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

      let order = 'desc'
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

      const cursor = req.query.cursor || req.query.page || null
      if (cursor !== null && typeof cursor !== 'string') {
        const err = new Error('Invalid query parameter "cursor"/"page". Must be a string.')
        err.status = 400
        err.code = 'INVALID_CURSOR'
        return next(err)
      }

      const result = await getTransactions(address, limit, cursor, order)

      if (result.success) {
        res.json({
          success: true,
          transactions: result.transactions,
          address,
          count: result.transactions.length,
          correlationId: req.requestId,
        })
      } else {
        const statusCode = result.errorType === 'ACCOUNT_NOT_FOUND' ? 404 : 503
        res.status(statusCode).json({
          success: false,
          error: result.error,
          errorType: result.errorType,
          message: getTransactionErrorMessage(result.errorType),
          timestamp: result.timestamp,
          correlationId: req.requestId,
          retryable: result.errorType !== 'ACCOUNT_NOT_FOUND',
        })
      }
    } catch (err) {
      next(err)
    }
  })

  function getTransactionErrorMessage(errorType) {
    const messages = {
      ACCOUNT_NOT_FOUND: 'Account not found on the Stellar network. It may not be funded yet.',
      TIMEOUT: 'Request timed out while fetching transactions. Please try again.',
      NETWORK_ERROR:
        'Network error connecting to Horizon. Please check your connection and try again.',
      UPSTREAM_ERROR: 'Horizon service is temporarily unavailable. Please try again later.',
    }
    return messages[errorType] || 'An unexpected error occurred while fetching transactions.'
  }

  // System Status
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
      orchestrationQueue: {
        ...admissionQueue.getState(),
        multiReplicaCoordination: false,
        note: 'In-process admission queue bounds concurrency on this node; no cross-node distributed coordination.',
      },
      runHistory: {
        storage: config.runHistoryStorage,
        file: config.runHistoryStorage === 'file' ? config.runHistoryFile : null,
        maxRuns: config.runHistoryMaxRuns,
      },
    })
  })

  // API Key Configuration
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
    logger.info('api_key_updated', { correlationId: req.requestId })
    setApiKey(apiKey)
    res.json({ success: true, masked: `sk-ant-...${apiKey.slice(-6)}` })
  })

  // Serve Dashboard
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
  })

  // Centralized Error Handler
  app.use(errorHandler)

  // Cleanup function to close SSE connections
  function close(reason = 'shutdown') {
    const payload = JSON.stringify({
      type: 'server_shutdown',
      reason,
      timestamp: new Date().toISOString(),
    })
    sseClients.forEach((res) => {
      try {
        res.write(`data: ${payload}\n\n`)
        res.end()
      } catch {
        // Ignore errors during cleanup
      }
    })
    sseClients.length = 0
  }

  /**
   * Coordinate a bounded graceful shutdown:
   * 1. Switch readiness to not_ready before refusing new work
   * 2. Refuse new orchestration work with 503 SERVER_DRAINING
   * 3. Give accepted work the configured drain window
   * 4. Record remaining work at deadline as interrupted (preserving uncertain payments)
   * 5. Close SSE connections, timers, listener, and flush the storage queue
   */
  async function shutdown(options = {}) {
    if (shutdownPromise) {
      return shutdownPromise
    }

    const {
      signal = 'SIGTERM',
      server = null,
      drainTimeoutMs = config?.shutdownDrainTimeoutMs ?? 10000,
      onReadinessChanged = null,
    } = options

    shutdownPromise = (async () => {
      const startedAt = Date.now()
      logger.info('graceful_shutdown_started', { signal, drainTimeoutMs })

      // 1. Switch readiness to not_ready before refusing new work
      shutdownState.markNotReady()
      if (typeof onReadinessChanged === 'function') {
        await onReadinessChanged(buildReadinessPayload())
      }

      // 2. Refuse new orchestration work
      shutdownState.refuseNewWork()

      // 3. Give accepted work the configured drain window
      const drainOutcome = await orchestrationController.waitForActiveRuns(drainTimeoutMs)

      // 4. At deadline, record remaining work accurately, including uncertain payments
      let interruptedRunIds = []
      if (drainOutcome.timedOut || orchestrationController.getActiveRunCount() > 0) {
        interruptedRunIds = await orchestrationController.abortRemainingRuns(
          INTERRUPTED_REASON_SHUTDOWN_TIMEOUT
        )
      } else if (typeof runHistoryStore?.recoverInterruptedRuns === 'function') {
        interruptedRunIds = await runHistoryStore.recoverInterruptedRuns(
          INTERRUPTED_REASON_SHUTDOWN_TIMEOUT
        )
      }

      // 5. Close SSE connections, timers, listener, and flush storage queue
      close(signal)
      admissionQueue.clear?.(INTERRUPTED_REASON_SHUTDOWN_TIMEOUT)
      activePlansStore.clear()

      if (server && server.listening) {
        server.closeIdleConnections?.()
        await new Promise((resolve) => {
          const forceTimer = setTimeout(() => {
            server.closeAllConnections?.()
            resolve()
          }, 250)
          forceTimer.unref?.()
          server.close(() => {
            clearTimeout(forceTimer)
            resolve()
          })
        })
      }

      await orchestrationController.flushPendingWrites()

      const elapsedMs = Date.now() - startedAt
      logger.info('graceful_shutdown_complete', {
        signal,
        timedOut: drainOutcome.timedOut,
        interruptedRunIds,
        elapsedMs,
      })

      return {
        status: 'shutdown_complete',
        signal,
        drained: !drainOutcome.timedOut,
        timedOut: drainOutcome.timedOut,
        interruptedRunIds,
        elapsedMs,
      }
    })()

    return shutdownPromise
  }

  return {
    app,
    close,
    shutdown,
    isDraining: () => draining,
    admissionQueue,
  }
}
