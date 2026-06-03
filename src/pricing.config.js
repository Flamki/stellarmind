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

export const pricingConfig = {
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
    const x402Config = {}
    for (const [endpoint, info] of Object.entries(this.endpoints)) {
      x402Config[endpoint] = {
        accepts: {
          scheme: 'exact',
          price: info.price,
          network: config.network,
          payTo: config.payTo,
        },
      }
    }
    return x402Config
  },
}

// Build lookup maps for fast access
Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  pricingConfig.byEndpoint[endpoint] = info
  pricingConfig.byAgent[info.agent] = { endpoint, ...info }
  const priceKey = info.price
  if (!pricingConfig.byPrice[priceKey]) {
    pricingConfig.byPrice[priceKey] = []
  }
  pricingConfig.byPrice[priceKey].push({ endpoint, agent: info.agent })
})
