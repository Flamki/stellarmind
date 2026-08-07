/**
 * Provider Factory — selects and caches the configured LLM provider.
 * Usage: import { getProvider } from './providers/index.js'
 */
import { config } from '../config.js'
import { validateProvider } from './interface.js'
import { getProvider as getAnthropic } from './anthropic-provider.js'
import { getProvider as getOpenAI } from './openai-provider.js'

const REGISTRY = { anthropic: getAnthropic, openai: getOpenAI }
const NAMES = Object.keys(REGISTRY)
let _cached = null

export function getProvider() {
  if (_cached) return _cached
  const name = (config.provider || 'anthropic').toLowerCase()
  if (!REGISTRY[name]) {
    console.warn(`[provider] Unknown "${name}", using anthropic. Available: ${NAMES.join(', ')}`)
    _cached = REGISTRY.anthropic()
    return _cached
  }
  _cached = REGISTRY[name]()
  const v = validateProvider(_cached)
  if (!v.valid) {
    console.error(`[provider] "${name}" incomplete: ${v.missing.join(', ')}. Using anthropic.`)
    _cached = REGISTRY.anthropic()
  }
  return _cached
}

export function listProviders() {
  return NAMES.map((n) => { const p = REGISTRY[n](); return { name: n, available: p.isAvailable ? p.isAvailable() : true, capabilities: p.capabilities } })
}

export function resetProvider() { _cached = null }
export { validateProvider, PROVIDER_MODES } from './interface.js'
