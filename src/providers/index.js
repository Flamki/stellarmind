/**
 * Provider Abstraction Module — StellarMind
 * Multi-LLM provider support with unified interface.
 * Stellar Wave bounty #25
 */

const PROVIDER_REGISTRY = new Map();

class ProviderInterface {
  /**
   * @param {Object} config
   * @param {string} config.apiKey
   * @param {string} [config.baseUrl]
   * @param {Object} [config.defaultOptions]
   */
  constructor(config) {
    this.config = config;
    this.name = 'base';
  }

  /** Returns the list of supported models */
  async listModels() {
    throw new Error('Not implemented');
  }

  /** Execute a completion request */
  async complete(_params) {
    throw new Error('Not implemented');
  }

  /** Execute a chat completion request */
  async chat(messages, options = {}) {
    throw new Error('Not implemented');
  }

  /** Health check against the provider */
  async healthCheck() {
    throw new Error('Not implemented');
  }

  /** Provider-specific token counting */
  async countTokens(text) {
    // Default: rough estimate (4 chars ~= 1 token)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Register a provider implementation.
 * @param {string} name
 * @param {typeof ProviderInterface} ProviderClass
 */
function registerProvider(name, ProviderClass) {
  PROVIDER_REGISTRY.set(name.toLowerCase(), ProviderClass);
}

/**
 * Create a provider instance.
 * @param {string} name — provider name (e.g., 'openai', 'anthropic', 'local')
 * @param {Object} config — provider-specific configuration
 * @returns {ProviderInterface}
 */
function createProvider(name, config) {
  const ProviderClass = PROVIDER_REGISTRY.get(name.toLowerCase());
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${name}. Available: ${[...PROVIDER_REGISTRY.keys()].join(', ')}`);
  }
  return new ProviderClass(config);
}

/**
 * List all registered provider names.
 */
function listProviders() {
  return [...PROVIDER_REGISTRY.keys()];
}

/**
 * Suggested usage pattern:
 *
 * const { createProvider } = require('./providers');
 * const provider = createProvider('openai', { apiKey: process.env.OPENAI_API_KEY });
 * const models = await provider.listModels();
 * const response = await provider.chat([{ role: 'user', content: 'Hello' }]);
 */

module.exports = {
  ProviderInterface,
  registerProvider,
  createProvider,
  listProviders,
  PROVIDER_REGISTRY
};
