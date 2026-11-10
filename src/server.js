import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config } from './config.js'
import { pricingConfig } from './pricing.config.js'
import { validateAll, formatValidationErrors } from './pricing.validator.js'
import { logger } from './logger.js'
import { createRunHistoryStore } from './storage/run-history.js'
import { createApp } from './app.js'
import { AGENTS } from './agents/registry.js'
import { validateWalletTransactions } from './requestValidation.js'
import {
  OFFLINE_DEMO_FIXTURES,
  OFFLINE_DEMO_WALLETS,
  OFFLINE_PREMIUM_SERVICES,
  OFFLINE_SERVICE_MAP,
  SYNTHETIC_RECEIPT_LABEL,
  SYNTHETIC_TX_PREFIX,
  buildSyntheticPaymentReceipt,
  getOfflineWalletBalances,
  getOfflineWalletTransactions,
  isOfflineDemoEnabled,
  listOfflineDemoFixtures,
  setOfflineDemoMode,
} from './providers/index.js'

// x402 imports
import { paymentMiddlewareFromConfig } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { ExactStellarScheme } from '@x402/stellar/exact/server'

// ─── Validate Pricing Configuration at Startup ──────────────
const pricingValidation = validateAll(pricingConfig, {
  network: config.network,
  payTo: config.serverAddress || OFFLINE_DEMO_WALLETS.server.address,
})

if (!pricingValidation.valid) {
  logger.error('pricing_config_validation_failed', { errors: pricingValidation.errors })
  logger.error('pricing_config_validation_details', {
    details: formatValidationErrors(pricingValidation),
  })
  process.exit(1)
}
logger.info('pricing_config_validated')

function createOfflineServerMiddleware({ effectiveConfig, activePricingConfig }) {
  return async function offlineServerMiddleware(req, res, next) {
    setOfflineDemoMode(true)

    if (req.method === 'GET' && req.path === '/api/status') {
      const premiumEndpoints = activePricingConfig
        .getAllPricingInfo()
        .map((info) => `${info.endpoint} (${info.price})`)

      return res.json({
        name: 'StellarMind',
        version: '1.0.0',
        description:
          'AI Agent Marketplace with x402 Micropayments on Stellar (Offline Deterministic Demo Mode)',
        status: 'online',
        offlineMode: true,
        demoMode: 'offline-deterministic',
        executionMode: 'offline-demo',
        receiptMode: 'synthetic-stub',
        receiptLabel: SYNTHETIC_RECEIPT_LABEL,
        offlineFixtures: listOfflineDemoFixtures().map((fixture) => ({
          id: fixture.id,
          name: fixture.name,
          description: fixture.description,
          task: fixture.task,
          budget: fixture.budget,
        })),
        network: effectiveConfig.network,
        facilitator: 'offline://synthetic-facilitator-stub',
        agents: AGENTS.length,
        x402: {
          enabled: true,
          offlineMode: true,
          syntheticReceipts: true,
          receiptPrefix: SYNTHETIC_TX_PREFIX,
          explorerLinksEnabled: false,
          middleware: 'offline-synthetic-x402-stub',
          client: 'offline-deterministic-x402-fetch',
          premiumEndpoints,
          pricing: activePricingConfig.getAllPricingInfo(),
          flow: 'offline deterministic plan → stub agent response → synthetic receipt (no external network requests)',
        },
        wallets: {
          server: `${OFFLINE_DEMO_WALLETS.server.address.slice(0, 12)}... (synthetic)`,
          orchestrator: `${OFFLINE_DEMO_WALLETS.orchestrator.address.slice(0, 12)}... (synthetic)`,
          buyer: `${OFFLINE_DEMO_WALLETS.buyer.address.slice(0, 12)}... (synthetic)`,
        },
        claudeEnabled: true,
        claudeMode: 'offline-deterministic-stub',
        runHistory: {
          storage: effectiveConfig.runHistoryStorage,
          file:
            effectiveConfig.runHistoryStorage === 'file' ? effectiveConfig.runHistoryFile : null,
          maxRuns: effectiveConfig.runHistoryMaxRuns,
        },
      })
    }

    if (req.method === 'GET' && req.path === '/api/wallet/balances') {
      return res.json(getOfflineWalletBalances(req.requestId))
    }

    if (req.method === 'GET' && req.path === '/api/wallet/transactions') {
      return validateWalletTransactions(req, res, (validationErr) => {
        if (validationErr) return next(validationErr)
        const address =
          req.validated?.address ||
          effectiveConfig.orchestratorAddress ||
          OFFLINE_DEMO_WALLETS.orchestrator.address
        let limit = 20
        if (req.query.limit !== undefined) {
          const parsedLimit = Number.parseInt(req.query.limit, 10)
          if (
            Number.isNaN(parsedLimit) ||
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
        return res.json(getOfflineWalletTransactions(address, limit, req.requestId))
      })
    }

    if (
      req.method === 'GET' &&
      (req.path === '/api/fixtures' || req.path === '/api/demo/fixtures')
    ) {
      return res.json({
        offlineMode: true,
        executionMode: 'offline-demo',
        receiptMode: 'synthetic-stub',
        fixtures: listOfflineDemoFixtures(),
      })
    }

    if (req.method === 'GET' && req.path === '/api/research') {
      const topic = req.query.topic || 'AI payments'
      const result = await OFFLINE_SERVICE_MAP['research-bot'](topic)
      return res.json({
        agent: 'research-bot',
        topic,
        result,
        model: OFFLINE_PREMIUM_SERVICES.MODEL_LABELS.research,
        cost: '0.01 USDC',
        offlineMode: true,
        executionMode: 'offline-demo',
        receiptMode: 'synthetic-stub',
        synthetic: true,
        explorerUrl: null,
      })
    }

    if (req.method === 'GET' && req.path === '/api/summarize') {
      const text = req.query.text || ''
      const result = await OFFLINE_SERVICE_MAP['summary-bot'](text)
      return res.json({
        agent: 'summary-bot',
        result,
        model: OFFLINE_PREMIUM_SERVICES.MODEL_LABELS.summary,
        cost: '0.01 USDC',
        offlineMode: true,
        executionMode: 'offline-demo',
        receiptMode: 'synthetic-stub',
        synthetic: true,
        explorerUrl: null,
      })
    }

    if (req.method === 'GET' && req.path === '/api/analyze') {
      const topic = req.query.topic || ''
      const result = await OFFLINE_SERVICE_MAP['analyst-bot'](topic)
      return res.json({
        agent: 'analyst-bot',
        topic,
        result,
        model: OFFLINE_PREMIUM_SERVICES.MODEL_LABELS.analysis,
        cost: '0.05 USDC',
        offlineMode: true,
        executionMode: 'offline-demo',
        receiptMode: 'synthetic-stub',
        synthetic: true,
        explorerUrl: null,
      })
    }

    if (req.method === 'GET' && req.path === '/api/code') {
      const prompt = req.query.prompt || ''
      const result = await OFFLINE_SERVICE_MAP['code-bot'](prompt)
      return res.json({
        agent: 'code-bot',
        result,
        model: OFFLINE_PREMIUM_SERVICES.MODEL_LABELS.code,
        cost: '0.03 USDC',
        offlineMode: true,
        executionMode: 'offline-demo',
        receiptMode: 'synthetic-stub',
        synthetic: true,
        explorerUrl: null,
      })
    }

    if (req.method === 'GET' && req.path.startsWith('/api/premium/')) {
      const originalJson = res.json.bind(res)
      res.json = (body) => {
        if (body && typeof body === 'object' && body.agent) {
          const receipt = buildSyntheticPaymentReceipt({
            scenario: 'premium-direct',
            stepIndex: 0,
            agentId: body.agent,
            method: 'x402',
            amount: String(body.cost || '0.01').replace(/\s*USDC$/i, ''),
            asset: 'USDC',
            issuer: effectiveConfig.networkProfile?.usdc?.issuer,
            network: effectiveConfig.network,
            task: body.topic || body.prompt || body.result || req.path,
          })
          res.setHeader(
            'PAYMENT-RESPONSE',
            JSON.stringify({
              success: true,
              transaction: receipt.txHash,
              network: effectiveConfig.network,
              synthetic: true,
              offlineMode: true,
              receiptLabel: SYNTHETIC_RECEIPT_LABEL,
            })
          )
          return originalJson({
            ...body,
            offlineMode: true,
            executionMode: 'offline-demo',
            receiptMode: 'synthetic-stub',
            synthetic: true,
            txHash: receipt.txHash,
            explorerUrl: null,
            receiptLabel: SYNTHETIC_RECEIPT_LABEL,
            receipt,
          })
        }
        return originalJson(body)
      }
    }

    if (req.path === '/api/orchestrate' || req.path === '/api/orchestrate/preview') {
      const source = req.method === 'GET' ? req.query : req.body
      const fixtureId = source?.fixture || req.query?.fixture
      if (fixtureId && OFFLINE_DEMO_FIXTURES[fixtureId] && source && typeof source === 'object') {
        const fixture = OFFLINE_DEMO_FIXTURES[fixtureId]
        if (!source.task) source.task = fixture.task
        if (source.budget === undefined || source.budget === null || source.budget === '') {
          source.budget = fixture.budget
        }
      }
    }

    return next()
  }
}

function createLiveServerStatusMiddleware() {
  return function liveServerStatusMiddleware(req, res, next) {
    if (req.method === 'GET' && req.path === '/api/status') {
      const originalJson = res.json.bind(res)
      res.json = (body) => {
        if (body && typeof body === 'object') {
          return originalJson({
            ...body,
            offlineMode: false,
            demoMode: 'live',
            executionMode: 'live',
            receiptMode: 'on-chain',
          })
        }
        return originalJson(body)
      }
    }
    return next()
  }
}

/**
 * Create a configured server application instance.
 * Offline demo mode is strictly opt-in (`options.offlineMode === true`,
 * `OFFLINE_DEMO_MODE=true`, or `--offline` CLI flag).
 */
export async function createServerApp(options = {}) {
  const offlineMode =
    options.offlineMode !== undefined ? Boolean(options.offlineMode) : isOfflineDemoEnabled()

  const baseConfig = options.config || config
  const activePricingConfig = options.pricingConfig || pricingConfig
  const effectiveConfig = offlineMode
    ? {
        ...baseConfig,
        offlineMode: true,
        runHistoryStorage: options.runHistoryStorage || 'memory',
        anthropicApiKey: baseConfig.anthropicApiKey || 'offline-demo-stub',
        facilitatorUrl: baseConfig.facilitatorUrl || 'offline://synthetic-facilitator-stub',
        serverAddress: baseConfig.serverAddress || OFFLINE_DEMO_WALLETS.server.address,
        orchestratorAddress:
          baseConfig.orchestratorAddress || OFFLINE_DEMO_WALLETS.orchestrator.address,
        buyerAddress: baseConfig.buyerAddress || OFFLINE_DEMO_WALLETS.buyer.address,
      }
    : {
        ...baseConfig,
        offlineMode: false,
      }

  const runHistoryStore = options.runHistoryStore || (await createRunHistoryStore(effectiveConfig))

  let paymentMiddleware = options.paymentMiddleware ?? null
  if (offlineMode) {
    paymentMiddleware = createOfflineServerMiddleware({
      effectiveConfig,
      activePricingConfig,
    })
    logger.info('offline_demo_mode_active', {
      executionMode: 'offline-demo',
      receiptMode: 'synthetic-stub',
      fixtures: Object.keys(OFFLINE_DEMO_FIXTURES),
    })
  } else if (!paymentMiddleware) {
    if (effectiveConfig.serverAddress) {
      try {
        const facilitatorClient = new HTTPFacilitatorClient({
          url: effectiveConfig.facilitatorUrl,
        })
        const stellarScheme = new ExactStellarScheme()

        const x402PricingConfig = activePricingConfig.getX402Config({
          network: effectiveConfig.network,
          payTo: effectiveConfig.serverAddress,
        })

        const x402Middleware = paymentMiddlewareFromConfig(x402PricingConfig, facilitatorClient, [
          { network: effectiveConfig.network, server: stellarScheme },
        ])
        const statusMiddleware = createLiveServerStatusMiddleware()
        paymentMiddleware = (req, res, next) => {
          statusMiddleware(req, res, (err) => {
            if (err) return next(err)
            return x402Middleware(req, res, next)
          })
        }
        logger.info('x402_middleware_active')
      } catch (err) {
        logger.warn('x402_middleware_init_failed', { error: err.message })
        paymentMiddleware = createLiveServerStatusMiddleware()
      }
    } else {
      logger.warn('x402_paywall_disabled', { reason: 'SERVER_STELLAR_ADDRESS not configured' })
      paymentMiddleware = createLiveServerStatusMiddleware()
    }
  }

  const {
    app,
    close: baseClose,
    admissionQueue,
  } = createApp({
    config: effectiveConfig,
    pricingConfig: activePricingConfig,
    runHistoryStore,
    paymentMiddleware,
    premiumServices: offlineMode ? OFFLINE_PREMIUM_SERVICES : options.premiumServices,
  })

  const originalHandle = app.handle.bind(app)
  app.handle = function handleWithMode(req, res, callback) {
    setOfflineDemoMode(offlineMode)
    return originalHandle(req, res, callback)
  }

  const baseResponseJson = app.response.json
  app.response.json = function jsonWithMode(body) {
    setOfflineDemoMode(offlineMode)
    const reqPath = this.req?.path || (this.req?.url || '').split('?')[0]
    if (reqPath === '/readyz' && body && typeof body === 'object') {
      if (offlineMode) {
        this.status(200)
        return baseResponseJson.call(this, {
          ...body,
          status: 'ready',
          ready: true,
          offlineMode: true,
          demoMode: 'offline-deterministic',
          executionMode: 'offline-demo',
          receiptMode: 'synthetic-stub',
        })
      }
      return baseResponseJson.call(this, {
        ...body,
        offlineMode: false,
        demoMode: 'live',
        executionMode: 'live',
        receiptMode: 'on-chain',
      })
    }
    return baseResponseJson.call(this, body)
  }

  function close() {
    baseClose()
  }

  return {
    app,
    close,
    admissionQueue,
    runHistoryStore,
    offlineMode,
  }
}

const defaultServer = await createServerApp()
const { app, close, admissionQueue } = defaultServer

// ─── Start Server ────────────────────────────────────────────
const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isMainModule) {
  const PORT = config.port
  const offlineActive = defaultServer.offlineMode
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
║  Mode:       ${(offlineActive ? '🧪 OFFLINE DEMO (synthetic stubs)' : '🌐 LIVE').padEnd(34)}║
║  Network:    ${config.network.padEnd(34)}║
║  Claude AI:  ${(offlineActive ? '🧪 Deterministic Offline Stubs' : config.anthropicApiKey ? '✅ Connected' : '❌ No API key').padEnd(34)}║
║  x402:       ${(offlineActive ? '🧾 Synthetic Receipts (no explorer)' : config.serverAddress ? '✅ Active' : '⚠️  No wallet').padEnd(34)}║
╚══════════════════════════════════════════════════╝
  `)
  })
}

export { app, close, admissionQueue }
