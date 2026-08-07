/**
 * Anthropic Provider — default implementation. Behavior unchanged from services.js.
 */
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'

export const name = 'anthropic'
// eslint-disable-next-line no-unused-vars
const _anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey })
let available = true

export const capabilities = {
  research: { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  summary: { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  analysis: { model: 'claude-sonnet-4-5-20250929', fallback: 'claude-haiku-4-5-20251001', label: 'Claude Sonnet 4.5' },
  code: { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
}

export function setApiKey(newKey) {
  _anthropicClient = new Anthropic({ apiKey: newKey })
  config.anthropicApiKey = newKey
  available = true
}

export const isAvailable = () => available

import { runResearch, runSummary, runAnalysis, runCode, createAnthropicMessage } from '../agents/services.js'
export const research = runResearch
export const summary = runSummary
export const analysis = runAnalysis
export const code = runCode
export const createMessage = createAnthropicMessage

export function getProvider() {
  return { name, capabilities, research, summary, analysis, code, createMessage, setApiKey, isAvailable }
}
