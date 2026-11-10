/**
 * Centralized Pricing Configuration for StellarMind Premium Endpoints
 *
 * This is the single source of truth for all premium endpoint pricing.
 * Changes here automatically propagate to:
 * - x402 payment middleware configuration
 * - Status endpoint output
 * - Broadcast events
 * - Integration tests
 *
 * Price format: "$X.XX" (USD equivalent in USDC)
 */

export const REGISTERED_AGENT_IDS = ['research-bot', 'summary-bot', 'analyst-bot', 'code-bot']

/**
 * Normalize a price string (e.g. '$0.01' or '0.01') into a plain decimal string ('0.01')
 * suitable for AssetAmount and registry metadata.
 * @param {string} rawPrice
 * @returns {string}
 */
export function normalizePriceAmount(rawPrice) {
  if (typeof rawPrice !== 'string' || rawPrice.trim().length === 0) {
    throw new Error(`Invalid price value: ${String(rawPrice)}`)
  }
  const trimmed = rawPrice.trim()
  return trimmed.startsWith('$') ? trimmed.slice(1) : trimmed
}

/**
 * Format a plain or $-prefixed price string into canonical '$X.XX' format.
 * @param {string} rawPrice
 * @returns {string}
 */
export function formatDollarPrice(rawPrice) {
  const normalized = normalizePriceAmount(rawPrice)
  return `$${normalized}`
}

/**
 * Rebuild lookup indices (`byEndpoint`, `byAgent`, `byPrice`) on a pricing config object.
 * Throws if duplicate agent mappings are encountered when `strict` is true.
 * @param {Object} cfg
 * @param {{ strict?: boolean }} [options]
 * @returns {Object} cfg
 */
export function rebuildPricingMaps(cfg, { strict = false } = {}) {
  if (!cfg || typeof cfg !== 'object' || !cfg.endpoints) {
    return cfg
  }
  cfg.byEndpoint = {}
  cfg.byAgent = {}
  cfg.byPrice = {}

  for (const [endpoint, info] of Object.entries(cfg.endpoints)) {
    if (!info || typeof info !== 'object') continue
    cfg.byEndpoint[endpoint] = info
    if (info.agent) {
      if (strict && cfg.byAgent[info.agent]) {
        throw new Error(
          `Duplicate agent '${info.agent}' mapped in pricing configuration ('${cfg.byAgent[info.agent].endpoint}' and '${endpoint}')`
        )
      }
      cfg.byAgent[info.agent] = { endpoint, ...info }
    }
    if (info.price) {
      const priceKey = info.price
      if (!cfg.byPrice[priceKey]) {
        cfg.byPrice[priceKey] = []
      }
      cfg.byPrice[priceKey].push({ endpoint, agent: info.agent })
    }
  }

  return cfg
}

/**
 * Resolve the endpoint pricing entry for a given agent ID from a pricing configuration.
 * Scans `cfg.endpoints` directly so in-place mutations to `cfg.endpoints[...].price`
 * take effect immediately without requiring a manual index rebuild.
 *
 * @param {string} agentId
 * @param {Object} [cfg=pricingConfig]
 * @returns {{ endpoint: string, price: string, normalizedPrice: string, agent: string, description?: string, emoji?: string }}
 */
export function getAgentPricingEntry(agentId, cfg = pricingConfig) {
  const endpoints = cfg?.endpoints
  if (!endpoints || typeof endpoints !== 'object') {
    throw new Error('Pricing configuration is missing an endpoints map')
  }

  const matches = []
  for (const [endpoint, info] of Object.entries(endpoints)) {
    if (info && info.agent === agentId) {
      matches.push({ endpoint, ...info })
    }
  }

  if (matches.length === 0) {
    throw new Error(`Missing pricing mapping for agent '${agentId}'`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Duplicate pricing mappings for agent '${agentId}': ${matches.map((m) => m.endpoint).join(', ')}`
    )
  }

  const match = matches[0]
  return {
    ...match,
    price: formatDollarPrice(match.price),
    normalizedPrice: normalizePriceAmount(match.price),
  }
}

/**
 * Look up the normalized decimal price (e.g. '0.01') for an agent ID from a pricing config.
 * @param {string} agentId
 * @param {Object} [cfg=pricingConfig]
 * @returns {string}
 */
export function getAgentPrice(agentId, cfg = pricingConfig) {
  return getAgentPricingEntry(agentId, cfg).normalizedPrice
}

export const pricingConfig = {
  requiredAgents: [...REGISTERED_AGENT_IDS],

  // Premium agent endpoints with x402 payment requirements
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent - Web research and information gathering',
      emoji: '🔬',
    },
    'GET /api/premium/summarize': {
      price: '$0.01',
      agent: 'summary-bot',
      description: 'Summary Agent - Text summarization and condensing',
      emoji: '📝',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'analyst-bot',
      description: 'Analysis Agent - Deep analysis and insights',
      emoji: '📊',
    },
    'GET /api/premium/code': {
      price: '$0.03',
      agent: 'code-bot',
      description: 'Code Agent - Code generation and debugging',
      emoji: '💻',
    },
  },

  // Pricing map for easy lookup by endpoint or agent
  byEndpoint: {},
  byAgent: {},
  byPrice: {},

  /**
   * Get price for a specific endpoint
   * @param {string} endpoint - e.g., 'GET /api/premium/research'
   * @returns {string} Price in format '$X.XX'
   */
  getPrice(endpoint) {
    return this.endpoints[endpoint]?.price
  },

  /**
   * Get normalized decimal price (e.g. '0.01') for an agent ID
   * @param {string} agentId - e.g., 'research-bot'
   * @returns {string}
   */
  getAgentPrice(agentId) {
    return getAgentPrice(agentId, this)
  },

  /**
   * Get pricing entry for an agent ID
   * @param {string} agentId
   * @returns {Object}
   */
  getAgentInfo(agentId) {
    return getAgentPricingEntry(agentId, this)
  },

  /**
   * Get all premium endpoints
   * @returns {Array} Array of endpoint paths
   */
  getPremiumEndpoints() {
    return Object.keys(this.endpoints)
  },

  /**
   * Get pricing info for an endpoint
   * @param {string} endpoint - e.g., 'GET /api/premium/research'
   * @returns {Object} Pricing info object
   */
  getEndpointInfo(endpoint) {
    return this.endpoints[endpoint]
  },

  /**
   * Get all pricing info as array (for status endpoint)
   * @returns {Array} Array of pricing info objects
   */
  getAllPricingInfo() {
    return Object.entries(this.endpoints).map(([endpoint, info]) => ({
      endpoint,
      ...info,
    }))
  },

  /**
   * Get pricing map for x402 middleware configuration
   * @param {Object} config - Network config with network and payTo address
   * @returns {Object} x402 middleware pricing configuration
   */
  getX402Config(config) {
    rebuildPricingMaps(this)
    const x402Config = {}
    for (const [endpoint, info] of Object.entries(this.endpoints)) {
      x402Config[endpoint] = {
        accepts: {
          scheme: 'exact',
          price: formatDollarPrice(info.price),
          network: config.network,
          payTo: config.payTo,
        },
      }
    }
    return x402Config
  },
}

// Build lookup maps for fast access
rebuildPricingMaps(pricingConfig)
