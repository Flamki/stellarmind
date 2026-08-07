/**
 * Provider Interface — contract that all LLM providers must implement.
 *
 * Required exports: name, capabilities, research(), summary(), analysis(), code()
 * Optional: createMessage(), setApiKey(), isAvailable()
 */

/**
 * @typedef {Object} Provider
 * @property {string} name
 * @property {Object} capabilities
 * @property {Function} research
 * @property {Function} summary
 * @property {Function} analysis
 * @property {Function} code
 */

export function validateProvider(provider) {
  const required = ['name', 'research', 'summary', 'analysis', 'code', 'capabilities']
  const missing = required.filter((key) => typeof provider[key] === 'undefined')
  return { valid: missing.length === 0, missing }
}

export const PROVIDER_MODES = ['research', 'summary', 'analysis', 'code']
