/**
 * Provider Interface — contract for LLM provider implementations.
 * Required: name, capabilities, research(), summary(), analysis(), code()
 */
export function validateProvider(provider) {
  const required = ['name', 'research', 'summary', 'analysis', 'code', 'capabilities']
  const missing = required.filter((key) => typeof provider[key] === 'undefined')
  return { valid: missing.length === 0, missing }
}
export const PROVIDER_MODES = ['research', 'summary', 'analysis', 'code']
