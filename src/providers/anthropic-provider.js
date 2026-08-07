/**
 * Anthropic Provider — default implementation wrapping the Anthropic SDK.
 * Behavior is unchanged from the original services.js.
 */
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'

export const name = 'anthropic'

let anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey })
let claudeAvailable = true

export const capabilities = {
  research: { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (research)' },
  summary: { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (summary)' },
  analysis: { model: 'claude-sonnet-4-5-20250929', fallback: 'claude-haiku-4-5-20251001', label: 'Claude Sonnet 4.5 (analysis)' },
  code: { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (code)' },
}

export function setApiKey(newKey) {
  anthropicClient = new Anthropic({ apiKey: newKey })
  config.anthropicApiKey = newKey
  claudeAvailable = true
  console.log('  [anthropic-provider] API key updated (session-only)')
}

export const isAvailable = () => claudeAvailable

// Thin wrappers over existing service functions — same behavior, new home
import { runResearch, runSummary, runAnalysis, runCode, createAnthropicMessage } from '../agents/services.js'

export const research = runResearch
export const summary = runSummary
export const analysis = runAnalysis
export const code = runCode
export const createMessage = createAnthropicMessage

export function getProvider() {
  return { name, capabilities, research, summary, analysis, code, createMessage, setApiKey, isAvailable }
}
