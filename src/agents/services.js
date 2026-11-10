import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { usageFromMessage, unavailableUsage } from './usage.js'
import { normalizeContent } from './response-normalization.js'

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

export const DEMO_DISCLAIMER =
  'Note: Illustrative demo output only — no live model or external sources were queried.'

export function buildProvenance({
  source = 'live',
  isDemo = false,
  fallbackReason = null,
  model = null,
  configuredModel = null,
} = {}) {
  return {
    source,
    isDemo: Boolean(isDemo),
    fallbackReason: fallbackReason || null,
    model: isDemo ? 'demo' : model,
    configuredModel: configuredModel || model || null,
  }
}

export function summarizeRunProvenance(results = []) {
  const executed = (results || []).filter((item) => !item?.skipped && !item?.error)
  let liveStepCount = 0
  let modelFallbackStepCount = 0
  let demoStepCount = 0
  const fallbackReasons = new Set()

  for (const step of executed) {
    const prov = step?.provenance
    const source = prov?.source || (step?.isDemo ? 'demo' : 'live')
    if (source === 'demo' || prov?.isDemo || step?.isDemo) {
      demoStepCount += 1
    } else if (source === 'model-fallback') {
      modelFallbackStepCount += 1
      liveStepCount += 1
    } else {
      liveStepCount += 1
    }
    if (prov?.fallbackReason) {
      fallbackReasons.add(prov.fallbackReason)
    }
  }

  let provenanceMode = 'live'
  if (demoStepCount > 0 && liveStepCount > 0) {
    provenanceMode = 'mixed'
  } else if (demoStepCount > 0 && liveStepCount === 0) {
    provenanceMode = 'demo'
  }

  return {
    provenanceMode,
    isDemo: demoStepCount > 0,
    liveStepCount,
    modelFallbackStepCount,
    demoStepCount,
    fallbackReasons: Array.from(fallbackReasons),
  }
}

/**
 * Illustrative demo fallback responses — used when Claude API credentials are absent or rate-limited.
 * Explicitly labeled as illustrative demo content so callers never mistake them for live retrieved data.
 */
export const FALLBACKS = {
  research: (topic) => `[DEMO — Research Agent Illustrative Output]

Illustrative overview for "${topic}":

• Programmable payment protocols can pair with autonomous software agents to automate per-request settlement.
• Stellar's x402 HTTP 402 flow illustrates how an agent can receive a price quote, authorize a payment, and retry with proof of settlement.
• Spending guardrails and per-run budgets help bound autonomous agent expenditures during multi-step workflows.

${DEMO_DISCLAIMER}`,

  summary: (text) => `[DEMO — Summary Agent Illustrative Output]

Illustrative Summary: ${text.substring(0, 80)}...

This illustrative summary demonstrates how a downstream agent condenses prior step context within an x402 micropayment workflow without invoking a live language model.

${DEMO_DISCLAIMER}`,

  analysis: (topic) => `[DEMO — Analysis Agent Illustrative Output]

Illustrative Strategic Analysis: "${topic}"

**Key Findings (Illustrative):**
• Agent-to-agent micropayment workflows benefit from explicit budget caps and deterministic settlement tracking
• Separating payment settlement state from model output provenance prevents conflating paid calls with live model execution

**Risks (Illustrative):**
• Upstream model rate limits or missing credentials can trigger fallback demo responses
• Network latency requires bounded timeouts and retry policies

**Opportunities (Illustrative):**
• Auditable per-step provenance lets operators distinguish live model outputs from demo fallbacks

${DEMO_DISCLAIMER}`,

  code: (prompt) => `[DEMO — Code Agent Illustrative Output]

\`\`\`javascript
// Illustrative snippet for: ${prompt.substring(0, 60)}
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

${DEMO_DISCLAIMER}`,
}

/**
 * Try Claude API, fall back to cached/demo response if credits exhausted
 */
async function callClaude(model, maxTokens, prompt, fallbackFn, fallbackInput, options = {}) {
  const configuredModel = options.configuredModel || model
  const apiKeyPresent =
    options.apiKey !== undefined ? Boolean(options.apiKey) : Boolean(config.anthropicApiKey)

  if (!apiKeyPresent && typeof options.createMessage !== 'function') {
    console.log('  ℹ️  No API key — using demo response')
    options.onUsage?.(unavailableUsage(model, 'no_api_key'))
    const provenance = buildProvenance({
      source: 'demo',
      isDemo: true,
      fallbackReason: 'no_api_key',
      model: 'demo',
      configuredModel,
    })
    options.onProvenance?.(provenance)
    const text = fallbackFn(fallbackInput)
    return options.withProvenance ? { text, provenance } : text
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
    const provenance = buildProvenance({
      source: options.modelFallbackUsed ? 'model-fallback' : 'live',
      isDemo: false,
      fallbackReason: options.modelFallbackUsed ? 'primary_model_unavailable' : null,
      model: actualModel,
      configuredModel,
    })
    options.onProvenance?.(provenance)

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
    return options.withProvenance ? { text: normalized.text, provenance } : normalized.text
  } catch (err) {
    console.error(`Claude API error: ${err.message}`)
    const isRateLimit = err.message?.includes('rate_limit') || err.status === 429
    const isCreditsExhausted = err.message?.includes('credit balance')
    if (isCreditsExhausted || isRateLimit) {
      if (claudeAvailable) {
        console.log('  ⚠️  Claude API credits exhausted — switching to demo responses')
        claudeAvailable = false
      }
      const fallbackReason = isRateLimit ? 'rate_limited' : 'credits_exhausted'
      options.onUsage?.(unavailableUsage(model, 'credits_exhausted_fallback'))
      const provenance = buildProvenance({
        source: 'demo',
        isDemo: true,
        fallbackReason,
        model: 'demo',
        configuredModel,
      })
      options.onProvenance?.(provenance)
      const text = fallbackFn(fallbackInput)
      return options.withProvenance ? { text, provenance } : text
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
  return callClaude(
    AGENT_MODELS.research,
    512,
    `You are a research agent. Research this topic thoroughly but concisely (4-5 sentences with key facts and data points): ${topic}`,
    FALLBACKS.research,
    topic,
    options
  )
}

/**
 * Summary Agent — Claude Haiku for summarization
 */
export async function runSummary(text, options = {}) {
  return callClaude(
    AGENT_MODELS.summary,
    256,
    `You are a summarization agent. Summarize the following text in 2-3 clear, concise sentences capturing the key points:\n\n${text}`,
    FALLBACKS.summary,
    text,
    options
  )
}

/**
 * Analysis Agent — Claude Sonnet for deep analysis (premium tier)
 */
export async function runAnalysis(topic, options = {}) {
  return callClaudeWithModelFallback(
    AGENT_MODELS.analysisPrimary,
    AGENT_MODELS.analysisFallback,
    800,
    `You are a strategic analysis agent. Provide a structured analysis of the following topic. Include:
1. **Key Findings** (3-4 bullet points)
2. **Risks** (2-3 potential concerns)
3. **Opportunities** (2-3 actionable opportunities)

Topic: ${topic}`,
    FALLBACKS.analysis,
    topic,
    options
  )
}

/**
 * Code Agent — Claude Haiku for code tasks
 */
export async function runCode(prompt, options = {}) {
  return callClaude(
    AGENT_MODELS.code,
    600,
    `You are a code assistant agent. Help with the following code task. Be concise and provide working code:\n\n${prompt}`,
    FALLBACKS.code,
    prompt,
    options
  )
}
