import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { usageFromMessage, unavailableUsage } from './usage.js'
import { normalizeContent } from './response-normalization.js'
import { AGENT_PROMPT_TEMPLATES, buildPromptRevision } from '../prompts/index.js'

export let anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

// Track whether Claude API is available
let claudeAvailable = true

export const AGENT_MODELS = {
  research: 'claude-haiku-4-5-20251001',
  summary: 'claude-haiku-4-5-20251001',
  analysisPrimary: 'claude-sonnet-4-5-20250929',
  analysisFallback: 'claude-haiku-4-5-20251001',
  code: 'claude-haiku-4-5-20251001',
}

export const MODEL_LABELS = {
  research: AGENT_MODELS.research,
  summary: AGENT_MODELS.summary,
  analysis: `${AGENT_MODELS.analysisPrimary} (fallback: ${AGENT_MODELS.analysisFallback})`,
  code: AGENT_MODELS.code,
}

/**
 * Update the Anthropic API key at runtime.
 * Allows users to plug in their own key without restarting the server.
 * Security: Key is stored in memory only, never logged or persisted.
 */
export function setApiKey(newKey) {
  anthropic = new Anthropic({ apiKey: newKey })
  config.anthropicApiKey = newKey
  claudeAvailable = true
  // Security: Never log the actual key, only confirm it was set
  console.log('  🔑 Anthropic API key updated at runtime (ephemeral, session-only)')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error(`Anthropic request timed out after ${timeoutMs}ms`)
        err.code = 'ANTHROPIC_TIMEOUT'
        err.status = 408
        reject(err)
      }, timeoutMs)
    }),
  ])
}

function isTransientAnthropicError(err) {
  const status = err?.status
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true

  const msg = String(err?.message || '').toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('temporar') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('network')
  )
}

function formatAnthropicError(err) {
  const status = err?.status ? `status ${err.status}` : 'no-status'
  const code = err?.code ? `code ${err.code}` : 'no-code'
  const message = err?.message || 'Unknown Anthropic error'
  return `${status}, ${code}: ${message}`
}

export async function createAnthropicMessage(payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.anthropicRequestTimeoutMs
  const maxRetries = options.maxRetries ?? config.anthropicMaxRetries
  const baseDelayMs = options.baseDelayMs ?? config.anthropicRetryBaseDelayMs
  const onRetryAttempt = options.onRetryAttempt

  let attempt = 0
  while (true) {
    try {
      return await withTimeout(anthropic.messages.create(payload), timeoutMs)
    } catch (err) {
      const transient = isTransientAnthropicError(err)
      if (!transient) {
        const fastFail = new Error(
          `Non-transient Anthropic API error (${formatAnthropicError(err)})`
        )
        fastFail.status = err?.status
        fastFail.code = err?.code
        fastFail.cause = err
        throw fastFail
      }

      if (attempt >= maxRetries) {
        const exhausted = new Error(
          `Anthropic API retries exhausted after ${attempt} retries (${formatAnthropicError(err)})`
        )
        exhausted.status = err?.status
        exhausted.code = err?.code
        exhausted.cause = err
        throw exhausted
      }

      const nextAttempt = attempt + 1
      const delayMs = baseDelayMs * 2 ** attempt
      console.warn(
        `Anthropic transient error, retrying attempt ${nextAttempt}/${maxRetries} in ${delayMs}ms: ${err.message}`
      )
      onRetryAttempt?.({
        attempt: nextAttempt,
        maxRetries,
        delayMs,
        status: err?.status || null,
        error: err?.message || 'unknown error',
      })
      await sleep(delayMs)
      attempt += 1
    }
  }
}

/**
 * Intelligent fallback responses — used when Claude API credits are exhausted.
 * These demonstrate the agent architecture even without live AI.
 * In production, every call would use real Claude API.
 */
const FALLBACKS = {
  research: (topic) => `[Research Agent — Powered by Claude Haiku]

Research findings on "${topic}":

• The global AI-powered payments market is projected to exceed $40B by 2027, driven by the convergence of machine learning and blockchain settlement layers.
• Stellar's x402 protocol enables HTTP-native micropayments, allowing AI agents to autonomously pay for API services without human intervention — settlement occurs in ~5 seconds with fees under $0.001.
• Key players include Anthropic (Claude), OpenAI, and emerging agent frameworks like AutoGPT, which are exploring on-chain payment rails for agent-to-agent commerce.
• The intersection of agentic AI and programmable money represents a paradigm shift: agents can now discover, negotiate, and pay for services in real-time using stablecoins on networks like Stellar.

Sources: Stellar Development Foundation, x402 Protocol Specification, Anthropic Research 2025.`,

  summary: (text) => `[Summary Agent — Powered by Claude Haiku]

Key Takeaway: ${text.substring(0, 80)}...

The core insight is that autonomous AI agents require programmable payment infrastructure to operate at scale. Stellar's x402 protocol provides this by enabling HTTP 402 "Payment Required" flows where agents can discover service pricing, sign transactions, and receive responses — all without human intervention. This represents a fundamental shift from subscription-based API access to per-call micropayment models.`,

  analysis: (topic) => `[Analysis Agent — Powered by Claude Sonnet]

Strategic Analysis: "${topic}"

**Key Findings:**
• Agent-to-agent payment systems are an emerging category with significant first-mover advantage potential
• The x402 protocol on Stellar provides sub-5-second settlement and near-zero fees, making per-call micropayments economically viable for the first time
• Claude and similar LLMs can serve as autonomous orchestrators, decomposing complex tasks and hiring specialist agents
• Budget enforcement (spending policies) is a critical differentiator for enterprise adoption

**Risks:**
• Claude API latency (1-3s per call) may limit real-time agent workflows
• Testnet-to-mainnet migration requires USDC liquidity and regulatory considerations
• Dependency on centralized AI providers creates single points of failure

**Opportunities:**
• First-mover advantage in the AI agent marketplace vertical on Stellar
• Soroban smart contracts could enable on-chain spending policies
• Multi-model support (Claude, GPT-4, Gemini) would widen the marketplace appeal`,

  code: (prompt) => `[Code Agent — Powered by Claude Haiku]

\`\`\`javascript
// Solution for: ${prompt.substring(0, 60)}
import { Keypair, Networks, TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk';

async function executeAgentPayment(senderSecret, recipientPublic, amount) {
  const keypair = Keypair.fromSecret(senderSecret);
  const server = new Horizon.Server('https://horizon-testnet.stellar.org');
  const account = await server.loadAccount(keypair.publicKey());
  
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({
      destination: recipientPublic,
      asset: Asset.native(),
      amount: String(amount),
    }))
    .setTimeout(30)
    .build();
  
  tx.sign(keypair);
  return await server.submitTransaction(tx);
}
\`\`\`

This function handles a basic Stellar payment operation suitable for agent-to-agent micropayments.`,
}

/**
 * Try Claude API, fall back to cached/demo response if credits exhausted
 */
async function callClaude(model, maxTokens, prompt, fallbackFn, fallbackInput, options = {}) {
  const promptName = options.promptName || 'inline'
  const templateForRevision = options.promptTemplate || prompt
  const promptRev = buildPromptRevision(promptName, templateForRevision)
  const configuredModel = options.configuredModel || model
  const apiKeyPresent =
    options.apiKey !== undefined ? Boolean(options.apiKey) : Boolean(config.anthropicApiKey)

  if (!apiKeyPresent && typeof options.createMessage !== 'function') {
    console.log('  ℹ️  No API key — using demo response')
    options.onUsage?.(unavailableUsage(model, 'no_api_key'))
    options.onExecutionMeta?.({
      provider: 'demo',
      actualModel: 'demo',
      configuredModel,
      fallbackUsed: true,
      fallbackReason: 'no_api_key',
      isDemo: true,
      promptVersion: promptRev.revision,
      promptDigest: promptRev.digest,
      promptTemplate: promptRev.template,
    })
    return fallbackFn(fallbackInput)
  }

  try {
    const createFn =
      typeof options.createMessage === 'function' ? options.createMessage : createAnthropicMessage
    const msg = await createFn(
      {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        onRetryAttempt: options.onRetryAttempt,
      }
    )
    claudeAvailable = true
    const actualModel = msg?.model || model
    options.onUsage?.(usageFromMessage(msg, actualModel))
    options.onExecutionMeta?.({
      provider: 'anthropic',
      actualModel,
      configuredModel,
      fallbackUsed: Boolean(options.modelFallbackUsed),
      fallbackReason: options.modelFallbackUsed ? 'primary_model_unavailable' : null,
      isDemo: false,
      promptVersion: promptRev.revision,
      promptDigest: promptRev.digest,
      promptTemplate: promptRev.template,
    })

    // Combine every text block (not just content[0]) and surface
    // stop/completion metadata so callers can tell a truncated or empty
    // response apart from a normal, complete one.
    const normalized = normalizeContent(msg)
    options.onResponseMeta?.(normalized)
    if (normalized.truncated) {
      console.warn(`  WARNING: Claude response truncated at token limit (model: ${actualModel})`)
    }
    if (normalized.empty) {
      console.warn(
        `  WARNING: Claude response had no text content (model: ${actualModel}, blocks: ${
          normalized.blockTypes.join(', ') || 'none'
        })`
      )
    }
    return normalized.text
  } catch (err) {
    console.error(`Claude API error: ${err.message}`)
    if (
      err.message?.includes('credit balance') ||
      err.message?.includes('rate_limit') ||
      err.status === 429
    ) {
      if (claudeAvailable) {
        console.log('  ⚠️  Claude API credits exhausted — switching to demo responses')
        claudeAvailable = false
      }
      options.onUsage?.(unavailableUsage(model, 'credits_exhausted_fallback'))
      options.onExecutionMeta?.({
        provider: 'demo',
        actualModel: 'demo',
        configuredModel,
        fallbackUsed: true,
        fallbackReason: 'credits_exhausted',
        isDemo: true,
        promptVersion: promptRev.revision,
        promptDigest: promptRev.digest,
        promptTemplate: promptRev.template,
      })
      return fallbackFn(fallbackInput)
    }
    options.onUsage?.(unavailableUsage(model, 'error'))
    throw err
  }
}

async function callClaudeWithModelFallback(
  primaryModel,
  fallbackModel,
  maxTokens,
  prompt,
  fallbackFn,
  fallbackInput,
  options = {}
) {
  const configuredModel = options.configuredModel || `${primaryModel} (fallback: ${fallbackModel})`
  try {
    return await callClaude(primaryModel, maxTokens, prompt, fallbackFn, fallbackInput, {
      ...options,
      configuredModel,
      modelFallbackUsed: false,
    })
  } catch (err) {
    const message = String(err?.message || '').toLowerCase()
    const isModelResolutionError =
      message.includes('model') || message.includes('not found') || message.includes('unsupported')
    if (!isModelResolutionError || !fallbackModel || fallbackModel === primaryModel) throw err

    console.warn(`  Primary model ${primaryModel} unavailable, retrying with ${fallbackModel}`)
    return callClaude(fallbackModel, maxTokens, prompt, fallbackFn, fallbackInput, {
      ...options,
      configuredModel,
      modelFallbackUsed: true,
    })
  }
}

/**
 * Check if Claude API is currently available
 */
export function isClaudeAvailable() {
  return claudeAvailable
}

/**
 * Research Agent — Claude Haiku for fast research
 */
export async function runResearch(topic, options = {}) {
  const promptTemplate = options.promptTemplate || AGENT_PROMPT_TEMPLATES['research-bot']
  const prompt = options.promptOverride || promptTemplate.replace('{topic}', topic)
  return callClaude(AGENT_MODELS.research, 512, prompt, FALLBACKS.research, topic, {
    ...options,
    promptName: 'research-bot',
    promptTemplate: options.promptOverride || promptTemplate,
  })
}

/**
 * Summary Agent — Claude Haiku for summarization
 */
export async function runSummary(text, options = {}) {
  const promptTemplate = options.promptTemplate || AGENT_PROMPT_TEMPLATES['summary-bot']
  const prompt = options.promptOverride || promptTemplate.replace('{text}', text)
  return callClaude(AGENT_MODELS.summary, 256, prompt, FALLBACKS.summary, text, {
    ...options,
    promptName: 'summary-bot',
    promptTemplate: options.promptOverride || promptTemplate,
  })
}

/**
 * Analysis Agent — Claude Sonnet for deep analysis (premium tier)
 */
export async function runAnalysis(topic, options = {}) {
  const promptTemplate = options.promptTemplate || AGENT_PROMPT_TEMPLATES['analyst-bot']
  const prompt = options.promptOverride || promptTemplate.replace('{topic}', topic)
  return callClaudeWithModelFallback(
    AGENT_MODELS.analysisPrimary,
    AGENT_MODELS.analysisFallback,
    800,
    prompt,
    FALLBACKS.analysis,
    topic,
    {
      ...options,
      promptName: 'analyst-bot',
      promptTemplate: options.promptOverride || promptTemplate,
      configuredModel: MODEL_LABELS.analysis,
    }
  )
}

/**
 * Code Agent — Claude Haiku for code tasks
 */
export async function runCode(promptInput, options = {}) {
  const promptTemplate = options.promptTemplate || AGENT_PROMPT_TEMPLATES['code-bot']
  const prompt = options.promptOverride || promptTemplate.replace('{prompt}', promptInput)
  return callClaude(AGENT_MODELS.code, 600, prompt, FALLBACKS.code, promptInput, {
    ...options,
    promptName: 'code-bot',
    promptTemplate: options.promptOverride || promptTemplate,
  })
}
