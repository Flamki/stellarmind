import cors from 'cors'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config } from './config.js'
import { pricingConfig } from './pricing.config.js'
import { validateAll, formatValidationErrors } from './pricing.validator.js'
import { logger } from './logger.js'
import { createRunHistoryStore } from './storage/run-history.js'
import { createApp } from './app.js'

// x402 imports
import { paymentMiddlewareFromConfig } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { ExactStellarScheme } from '@x402/stellar/exact/server'

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

// ─── Initialize Storage ─────────────────────────────────────
const runHistoryStore = await createRunHistoryStore(config)

// ─── Initialize x402 Payment Middleware ─────────────────────
let paymentMiddleware = null
if (config.serverAddress) {
  try {
    const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl })
    const stellarScheme = new ExactStellarScheme()

    const x402PricingConfig = pricingConfig.getX402Config({
      network: config.network,
      payTo: config.serverAddress,
    })

    paymentMiddleware = paymentMiddlewareFromConfig(x402PricingConfig, facilitatorClient, [
      { network: config.network, server: stellarScheme },
    ])
    logger.info('x402_middleware_active')
  } catch (err) {
    logger.warn('x402_middleware_init_failed', { error: err.message })
  }
} else {
  logger.warn('x402_paywall_disabled', { reason: 'SERVER_STELLAR_ADDRESS not configured' })
}

// ─── Create Application with Dependencies ───────────────────
const { app, close, admissionQueue } = createApp({
  config,
  pricingConfig,
  runHistoryStore,
  paymentMiddleware,
})

// ─── Start Server ────────────────────────────────────────────
const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isMainModule) {
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
}

export { app, admissionQueue }
