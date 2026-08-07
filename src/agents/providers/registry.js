/**
 * Provider Registry - Manages available LLM providers
 */
import { AnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai-placeholder.js'
const providers = new Map()
let activeProvider = 'anthropic'
export function initProviders(config={}) {
  if (config.anthropicApiKey) {
    providers.set('anthropic', new AnthropicProvider({
      apiKey: config.anthropicApiKey,
      requestTimeoutMs: config.anthropicRequestTimeoutMs,
      maxRetries: config.anthropicMaxRetries,
      retryBaseDelayMs: config.anthropicRetryBaseDelayMs,
    }))
  }
  const openai = createOpenAIProvider(config.openaiApiKey)
  if (openai) providers.set('openai', openai)
  return providers.size
}
export function getProvider(name) {
  const pn = name || activeProvider
  const p = providers.get(pn)
  if (!p) throw new Error('Provider "'+pn+'" not found')
  return p
}
export function setActiveProvider(name) {
  if (!providers.has(name)) throw new Error('Provider "'+name+'" not registered')
  activeProvider = name
}
export async function listProviders() {
  const r = []
  for (const [n, p] of providers) {
    const a = await p.healthCheck().catch(()=>false)
    r.push({ name: n, available: a, capabilities: p.capabilities })
  }
  return r
}
export function getActiveProviderName() { return activeProvider }