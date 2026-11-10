/**
 * Unit tests for shared pricing configuration derivation (Issue #148).
 *
 * Verifies:
 *  - One price change updates premium quotes, catalog prices, estimates, and fallback planning.
 *  - Fallback planning selects steps using current prices and exact budget arithmetic.
 *  - Startup validation detects missing or duplicate agent-to-price mappings.
 *  - No agent price literals remain in registry or fallback selection logic.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  pricingConfig,
  getAgentPrice,
  rebuildPricingMaps,
  REGISTERED_AGENT_IDS,
} from '../src/pricing.config.js'
import {
  validatePricingConfig,
  validateAgentPriceMappings,
  validateAll,
} from '../src/pricing.validator.js'
import { AGENTS, buildAgentsCatalog, getAgentById, estimateCost } from '../src/agents/registry.js'
import { buildFallbackPlan } from '../src/agents/plan-validator.js'
import { buildQuote } from '../src/agents/settlement.js'
import { config } from '../src/config.js'

console.log('=== Issue #148: Shared Pricing Config Derivation Tests ===')

// 1. Verify no hardcoded price literals remain in registry.js or plan-validator.js
{
  const registrySource = fs.readFileSync(
    new URL('../src/agents/registry.js', import.meta.url),
    'utf8'
  )
  const validatorSource = fs.readFileSync(
    new URL('../src/agents/plan-validator.js', import.meta.url),
    'utf8'
  )
  assert.equal(
    /['"]0\.0[135]['"]/.test(registrySource),
    false,
    'registry.js must not contain hardcoded agent price literals'
  )
  assert.equal(
    /\b0\.0[135]\b/.test(validatorSource),
    false,
    'plan-validator.js must not contain hardcoded fallback price literals'
  )
  console.log('✓ No hardcoded agent price literals in registry.js or plan-validator.js')
}

// 2. Changing one price in a fixture configuration updates catalog, estimate, fallback steps, and x402 paywall quote
{
  const originalAnalyzePrice = pricingConfig.endpoints['GET /api/premium/analyze'].price
  try {
    // Baseline at $0.05 for analyst-bot: total for all 4 agents is 0.01 + 0.01 + 0.05 + 0.03 = 0.10 USDC
    assert.equal(getAgentById('analyst-bot').price, '0.05')
    assert.equal(estimateCost(REGISTERED_AGENT_IDS).toDecimalString(), '0.1000000')

    const baselineFallback = buildFallbackPlan('Analyze market structure', '0.07')
    // 0.07 fits research (0.01) + summary (0.01) + analyst (0.05) = 0.07; code-bot (0.03) skipped
    assert.deepEqual(
      baselineFallback.subtasks.map((s) => s.agentId),
      ['research-bot', 'summary-bot', 'analyst-bot']
    )

    // Mutate analyst-bot price in pricingConfig from $0.05 -> $0.08
    pricingConfig.endpoints['GET /api/premium/analyze'].price = '$0.08'
    rebuildPricingMaps(pricingConfig)

    // Verify catalog price updated
    assert.equal(getAgentPrice('analyst-bot'), '0.08')
    assert.equal(getAgentById('analyst-bot').price, '0.08')
    assert.equal(AGENTS.find((a) => a.id === 'analyst-bot').price, '0.08')

    // Verify estimateCost updated (0.01 + 0.01 + 0.08 + 0.03 = 0.13 USDC)
    assert.equal(estimateCost(REGISTERED_AGENT_IDS).toDecimalString(), '0.1300000')

    // Verify x402 paywall quote and settlement quote updated
    const x402Cfg = pricingConfig.getX402Config({
      network: 'stellar:testnet',
      payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
    })
    assert.equal(x402Cfg['GET /api/premium/analyze'].accepts.price, '$0.08')

    const quote = buildQuote(getAgentById('analyst-bot'), config.networkProfile)
    assert.equal(quote.amount, '0.08')

    // Verify fallback plan with 0.07 USDC budget now skips analyst-bot ($0.08) and selects code-bot ($0.03) instead!
    const updatedFallback = buildFallbackPlan('Analyze market structure', '0.07')
    assert.deepEqual(
      updatedFallback.subtasks.map((s) => s.agentId),
      ['research-bot', 'summary-bot', 'code-bot']
    )

    // And with exact 0.10 USDC budget (0.01 + 0.01 + 0.08), analyst-bot fits exactly using exact arithmetic
    const exactFitFallback = buildFallbackPlan('Analyze market structure', '0.10')
    assert.deepEqual(
      exactFitFallback.subtasks.map((s) => s.agentId),
      ['research-bot', 'summary-bot', 'analyst-bot']
    )
    console.log(
      '✓ Single price change propagates to registry, estimateCost, x402 quotes, and fallback plan selection'
    )
  } finally {
    pricingConfig.endpoints['GET /api/premium/analyze'].price = originalAnalyzePrice
    rebuildPricingMaps(pricingConfig)
  }
}

// 3. Startup validation detects missing or duplicate agent-to-price mappings
{
  const missingAgentCfg = {
    requiredAgents: [...REGISTERED_AGENT_IDS],
    endpoints: {
      'GET /api/premium/research': {
        price: '$0.01',
        agent: 'research-bot',
        description: 'Research Agent',
      },
      'GET /api/premium/summarize': {
        price: '$0.01',
        agent: 'summary-bot',
        description: 'Summary Agent',
      },
      'GET /api/premium/analyze': {
        price: '$0.05',
        agent: 'analyst-bot',
        description: 'Analysis Agent',
      },
      // code-bot intentionally omitted
    },
  }

  const missingCheck = validatePricingConfig(missingAgentCfg)
  assert.equal(missingCheck.valid, false)
  assert.ok(
    missingCheck.errors.some((e) =>
      e.includes("Missing pricing mapping for registered agent 'code-bot'")
    ),
    `Expected missing code-bot error, got: ${missingCheck.errors.join('; ')}`
  )

  const mappingValidation = validateAgentPriceMappings(missingAgentCfg)
  assert.equal(mappingValidation.valid, false)

  assert.throws(
    () => buildAgentsCatalog(missingAgentCfg),
    /Missing pricing mapping for agent 'code-bot'/
  )

  const duplicateAgentCfg = {
    requiredAgents: [...REGISTERED_AGENT_IDS],
    endpoints: {
      'GET /api/premium/research': {
        price: '$0.01',
        agent: 'research-bot',
        description: 'Research Agent',
      },
      'GET /api/premium/summarize': {
        price: '$0.01',
        agent: 'research-bot',
        description: 'Duplicate Research Agent',
      },
      'GET /api/premium/analyze': {
        price: '$0.05',
        agent: 'analyst-bot',
        description: 'Analysis Agent',
      },
      'GET /api/premium/code': {
        price: '$0.03',
        agent: 'code-bot',
        description: 'Code Agent',
      },
    },
  }

  const dupCheck = validateAll(duplicateAgentCfg, {
    network: 'stellar:testnet',
    payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
  })
  assert.equal(dupCheck.valid, false)
  assert.ok(dupCheck.errors.some((e) => e.includes("Duplicate agent: 'research-bot'")))
  assert.ok(
    dupCheck.errors.some((e) =>
      e.includes("Missing pricing mapping for registered agent 'summary-bot'")
    )
  )

  assert.throws(
    () => buildAgentsCatalog(duplicateAgentCfg),
    /Duplicate pricing mappings for agent 'research-bot'/
  )

  console.log('✓ Startup validation detects missing and duplicate agent-to-price mappings')
}

console.log('=== All Issue #148 tests passed ===')
