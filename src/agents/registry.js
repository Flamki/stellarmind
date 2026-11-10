/**
 * Agent Registry — Marketplace service catalog
 * Each agent is a Claude-powered AI service with its own capability and pricing
 */
import { MODEL_LABELS } from './services.js'
import { AssetAmount, DEFAULT_ASSET } from './amount.js'

export const AGENTS = [
  {
    id: 'research-bot',
    name: '🔬 Research Agent',
    endpoint: '/api/research',
    price: '0.01',
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
    price: '0.01',
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
    price: '0.05',
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
    price: '0.03',
    currency: 'USDC',
    model: MODEL_LABELS.code,
    capability: 'Code generation, review, and debugging',
    description: 'Generates, reviews, and debugs code across multiple languages.',
    status: 'online',
  },
]

/**
 * Discover agents by capability keyword
 */
export function discoverAgents(query) {
  const q = String(query || '')
    .trim()
    .toLowerCase()
  if (!q) return [...AGENTS]
  return AGENTS.filter(
    (a) =>
      (a.capability || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.name || '').toLowerCase().includes(q) ||
      (a.id || '').toLowerCase().includes(q)
  )
}

/**
 * Compare two agents by normalized numeric price within an asset.
 * Prices in the same asset are compared using exact AssetAmount scaled integers.
 */
export function compareAgentPrices(a, b, direction = 'asc') {
  const assetA = String(a?.currency || DEFAULT_ASSET)
    .trim()
    .toUpperCase()
  const assetB = String(b?.currency || DEFAULT_ASSET)
    .trim()
    .toUpperCase()

  if (assetA !== assetB) {
    if (assetA === DEFAULT_ASSET) return -1
    if (assetB === DEFAULT_ASSET) return 1
    return assetA.localeCompare(assetB)
  }

  const cleanA = String(a?.price ?? '0')
    .trim()
    .replace(/^\$/, '')
  const cleanB = String(b?.price ?? '0')
    .trim()
    .replace(/^\$/, '')
  const amtA = AssetAmount.from(cleanA || '0', assetA)
  const amtB = AssetAmount.from(cleanB || '0', assetB)

  if (amtA.baseUnits !== amtB.baseUnits) {
    const cmp = amtA.baseUnits < amtB.baseUnits ? -1 : 1
    return direction === 'desc' ? -cmp : cmp
  }

  return String(a?.name || a?.id || '').localeCompare(String(b?.name || b?.id || ''))
}

/**
 * Filter and sort an agent catalog using search query, status, capability, and sort mode.
 */
export function queryAgentCatalog(catalog = AGENTS, options = {}) {
  const list = Array.isArray(catalog) ? catalog : []
  const query = String(options.query || '')
    .trim()
    .toLowerCase()
  const status = String(options.status || 'all')
    .trim()
    .toLowerCase()
  const capability = String(options.capability || 'all')
    .trim()
    .toLowerCase()
  const sort = String(options.sort || 'default')
    .trim()
    .toLowerCase()

  const tokens = query ? query.split(/\s+/).filter(Boolean) : []

  const filtered = list.filter((agent) => {
    if (!agent || typeof agent !== 'object') return false
    const agentStatus = String(agent.status || 'online')
      .trim()
      .toLowerCase()
    if (status && status !== 'all' && agentStatus !== status) {
      return false
    }

    if (capability && capability !== 'all') {
      const capText = [
        agent.capability || '',
        agent.category || '',
        Array.isArray(agent.capabilities) ? agent.capabilities.join(' ') : '',
      ]
        .join(' ')
        .toLowerCase()
      if (!capText.includes(capability)) {
        return false
      }
    }

    if (tokens.length > 0) {
      const haystack = [
        agent.id || '',
        agent.name || '',
        agent.capability || '',
        agent.description || '',
        agent.model || '',
        agent.endpoint || '',
        agent.category || '',
        Array.isArray(agent.capabilities) ? agent.capabilities.join(' ') : '',
      ]
        .join(' ')
        .toLowerCase()
      for (const token of tokens) {
        if (!haystack.includes(token)) return false
      }
    }

    return true
  })

  const sorted = [...filtered]
  if (sort === 'price-asc') {
    sorted.sort((a, b) => compareAgentPrices(a, b, 'asc'))
  } else if (sort === 'price-desc') {
    sorted.sort((a, b) => compareAgentPrices(a, b, 'desc'))
  } else if (sort === 'name-asc') {
    sorted.sort((a, b) =>
      String(a.name || '')
        .replace(/^[^\w]+/, '')
        .localeCompare(String(b.name || '').replace(/^[^\w]+/, ''))
    )
  }

  return sorted
}

/**
 * Get agent by ID
 */
export function getAgentById(id) {
  return AGENTS.find((a) => a.id === id)
}

/**
 * Get total cost estimate for a set of agent IDs using exact asset amounts.
 * @param {string[]} agentIds
 * @param {string} [asset='USDC']
 * @returns {AssetAmount}
 */
export function estimateCost(agentIds, asset = DEFAULT_ASSET) {
  let total = AssetAmount.zero(asset)
  for (const id of agentIds || []) {
    const agent = getAgentById(id)
    if (agent?.price) {
      total = total.plus(AssetAmount.from(agent.price, agent.currency || asset))
    }
  }
  return total
}
