/**
 * Agent Registry — Marketplace service catalog
 * Each agent is a Claude-powered AI service with its own capability and pricing
 */
export const AGENTS = [
  {
    id: 'research-bot',
    name: '🔬 Research Agent',
    endpoint: '/api/research',
    price: '0.01',
    currency: 'USDC',
    model: 'claude-haiku-4-5-20251001',
    capability: 'Deep web research and fact-finding on any topic',
    description: 'Uses Claude Haiku for fast, accurate research synthesis. Returns well-sourced analysis.',
    status: 'online',
  },
  {
    id: 'summary-bot',
    name: '📝 Summary Agent',
    endpoint: '/api/summarize',
    price: '0.01',
    currency: 'USDC',
    model: 'claude-haiku-4-5-20251001',
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
    model: 'claude-sonnet-4-5-20250514',
    capability: 'Deep strategic analysis with structured insights',
    description: 'Uses Claude Sonnet for premium-tier analysis. Returns structured findings, risks, and opportunities.',
    status: 'online',
  },
  {
    id: 'code-bot',
    name: '💻 Code Agent',
    endpoint: '/api/code',
    price: '0.03',
    currency: 'USDC',
    model: 'claude-haiku-4-5-20251001',
    capability: 'Code generation, review, and debugging',
    description: 'Generates, reviews, and debugs code across multiple languages.',
    status: 'online',
  },
];

/**
 * Discover agents by capability keyword
 */
export function discoverAgents(query) {
  const q = query.toLowerCase();
  return AGENTS.filter(a =>
    a.capability.toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q) ||
    a.id.includes(q)
  );
}

/**
 * Get agent by ID
 */
export function getAgentById(id) {
  return AGENTS.find(a => a.id === id);
}

/**
 * Get total cost estimate for a set of agent IDs
 */
export function estimateCost(agentIds) {
  return agentIds.reduce((total, id) => {
    const agent = getAgentById(id);
    return total + (agent ? parseFloat(agent.price) : 0);
  }, 0);
}
