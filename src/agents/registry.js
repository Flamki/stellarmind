/**
 * Agent Registry — Marketplace service catalog
 * Each agent is a Claude-powered AI service with its own capability and pricing
 */
import { MODEL_LABELS } from './services.js'
import { AssetAmount, DEFAULT_ASSET } from './amount.js'
import { getAgentPrice, pricingConfig } from '../pricing.config.js'

export const AGENT_DEFINITIONS = [
  {
    id: 'research-bot',
    name: '🔬 Research Agent',
    endpoint: '/api/research',
    currency: 'USDC',
    model: MODEL_LABELS.research,
    capability: 'Deep web research and fact-finding on any topic',
    description:
      'Uses Claude Haiku for fast, accurate research synthesis. Returns well-sourced analysis.',
    status: 'online',
  },
  {
    id: 'summary-bot',
    name: '📝 Summary Agent',
    endpoint: '/api/summarize',
    currency: 'USDC',
    model: MODEL_LABELS.summary,
    capability: 'Text summarization and key insight extraction',
    description: 'Condenses long texts into concise, actionable summaries powered by Claude Haiku.',
    status: 'online',
  },
  {
    id: 'analyst-bot',
    name: '📊 Analysis Agent',
    endpoint: '/api/analyze',
    currency: 'USDC',
    model: MODEL_LABELS.analysis,
    capability: 'Deep strategic analysis with structured insights',
    description:
      'Uses Claude Sonnet for premium-tier analysis with automatic Haiku fallback when needed.',
    status: 'online',
  },
  {
    id: 'code-bot',
    name: '💻 Code Agent',
    endpoint: '/api/code',
    currency: 'USDC',
    model: MODEL_LABELS.code,
    capability: 'Code generation, review, and debugging',
    description: 'Generates, reviews, and debugs code across multiple languages.',
    status: 'online',
  },
]

function createDynamicAgentDescriptor(def, cfg = pricingConfig) {
  const descriptor = { ...def }
  Object.defineProperty(descriptor, 'price', {
    enumerable: true,
    configurable: true,
    get() {
      return getAgentPrice(def.id, cfg)
    },
  })
  return descriptor
}

/**
 * Build the marketplace agent catalog with prices derived from a pricing configuration.
 * Validates that every registered agent has a unique price mapping in `cfg`.
 *
 * @param {Object} [cfg=pricingConfig]
 * @returns {Array<Object>}
 */
export function buildAgentsCatalog(cfg = pricingConfig) {
  return AGENT_DEFINITIONS.map((def) => {
    // Eagerly resolve once to fail fast on missing/duplicate mappings in `cfg`.
    getAgentPrice(def.id, cfg)
    return createDynamicAgentDescriptor(def, cfg)
  })
}

export const AGENTS = buildAgentsCatalog(pricingConfig)

/**
 * Discover agents by capability keyword
 */
export function discoverAgents(query, cfg = pricingConfig) {
  const q = query.toLowerCase()
  const catalog = cfg === pricingConfig ? AGENTS : buildAgentsCatalog(cfg)
  return catalog.filter(
    (a) =>
      a.capability.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.id.includes(q)
  )
}

/**
 * Get agent by ID, resolving its price from `cfg` (defaults to global `pricingConfig`).
 */
export function getAgentById(id, cfg = pricingConfig) {
  if (cfg === pricingConfig) {
    return AGENTS.find((a) => a.id === id)
  }
  const def = AGENT_DEFINITIONS.find((a) => a.id === id)
  if (!def) return undefined
  getAgentPrice(def.id, cfg)
  return createDynamicAgentDescriptor(def, cfg)
}

/**
 * Get total cost estimate for a set of agent IDs using exact asset amounts.
 * @param {string[]} agentIds
 * @param {string} [asset='USDC']
 * @param {Object} [cfg=pricingConfig]
 * @returns {AssetAmount}
 */
export function estimateCost(agentIds, asset = DEFAULT_ASSET, cfg = pricingConfig) {
  let total = AssetAmount.zero(asset)
  for (const id of agentIds || []) {
    const agent = getAgentById(id, cfg)
    if (agent?.price) {
      total = total.plus(AssetAmount.from(agent.price, agent.currency || asset))
    }
  }
  return total
}
