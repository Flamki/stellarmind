import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { usageFromMessage, unavailableUsage } from './usage.js'
import { normalizeContent } from './response-normalization.js'
import { promptDigest, renderPromptTemplate } from './provenance.js'

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
 * Instruction templates for each agent. `{input}` is replaced with the caller's
 * text. The digest of the template is the stable prompt revision recorded with
 * every live output (issue #153): edit the wording and the revision changes.
 */
export const PROMPT_TEMPLATES = {
  research:
    'You are a research agent. Research this topic thoroughly but concisely (4-5 sentences with key facts and data points): {input}',
  summary:
    'You are a summarization agent. Summarize the following text in 2-3 clear, concise sentences capturing the key points:\n\n{input}',
  analysis: `You are a strategic analysis agent. Provide a structured analysis of the following topic. Include:
1. **Key Findings** (3-4 bullet points)
2. **Risks** (2-3 potential concerns)
3. **Opportunities** (2-3 actionable opportunities)

Topic: {input}`,
  code: 'You are a code assistant agent. Help with the following code task. Be concise and provide working code:\n\n{input}',
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

function codedError(message, code, status) {
  const err = new Error(message)
  err.code = code
  if (status) err.status = status
  return err
}

function timeoutError(timeoutMs) {
  return codedError(`Anthropic request timed out after ${timeoutMs}ms`, 'ANTHROPIC_TIMEOUT', 408)
}

function deadlineError(overallTimeoutMs, cause) {
  const err = codedError(
    `Anthropic request exceeded the overall deadline of ${overallTimeoutMs}ms`,
    'ANTHROPIC_DEADLINE_EXCEEDED',
    408
  )
  if (cause) err.cause = cause
  return err
}

function abortedError(signal) {
  const err = codedError('Anthropic request was cancelled', 'ANTHROPIC_ABORTED')
  err.name = 'AbortError'
  if (signal?.reason !== undefined) err.cause = signal.reason
  return err
}

/**
 * Wait `ms`, but wake up immediately (and clear the timer) if `signal` aborts.
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal))
      return
    }
    let onAbort
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    onAbort = () => {
      clearTimeout(timer)
      reject(abortedError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run ONE upstream attempt under an abortable deadline.
 *
 * - The provider call receives an AbortSignal; on timeout or caller
 *   cancellation the signal is aborted BEFORE this function rejects, so the
 *   underlying request is cancelled before any new attempt can start.
 * - `maxRetries: 0` turns off the SDK's own retries: the application loop in
 *   `createAnthropicMessage` is the single retry budget.
 * - The deadline timer and the caller-signal listener are always cleaned up
 *   (success, failure, timeout, cancellation).
 */
async function runAttempt(client, payload, { timeoutMs, onTimeout, callerSignal }) {
  const controller = new AbortController()
  let timer
  let onCallerAbort

  const guard = new Promise((_, reject) => {
    const fail = (err) => {
      reject(err)
      controller.abort(err)
    }
    timer = setTimeout(() => fail(onTimeout()), timeoutMs)
    if (callerSignal) {
      onCallerAbort = () => fail(abortedError(callerSignal))
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
  })
  const call = Promise.resolve().then(() =>
    client.messages.create(payload, { signal: controller.signal, maxRetries: 0 })
  )
  // Whichever side loses the race must not surface as an unhandled rejection.
  guard.catch(() => {})
  call.catch(() => {})

  try {
    return await Promise.race([call, guard])
  } finally {
    clearTimeout(timer)
    if (onCallerAbort) callerSignal.removeEventListener('abort', onCallerAbort)
  }
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

/**
 * Call the Anthropic Messages API with one retry budget.
 *
 * Real upstream attempts: at most `1 + maxRetries` (default
 * `1 + ANTHROPIC_MAX_RETRIES`); the SDK's own retries are disabled.
 *
 * @param {object} payload - Messages API payload
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - per-attempt deadline
 * @param {number} [options.maxRetries] - application retries after the first attempt
 * @param {number} [options.baseDelayMs] - exponential backoff base
 * @param {number} [options.overallTimeoutMs] - deadline across all attempts and delays (0 = none)
 * @param {AbortSignal} [options.signal] - cancels the in-flight attempt and any retry delay
 * @param {object} [options.client] - Anthropic client override (tests)
 * @param {Function} [options.onRetryAttempt]
 */
export async function createAnthropicMessage(payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.anthropicRequestTimeoutMs
  const maxRetries = options.maxRetries ?? config.anthropicMaxRetries
  const baseDelayMs = options.baseDelayMs ?? config.anthropicRetryBaseDelayMs
  const overallTimeoutMs = options.overallTimeoutMs ?? config.anthropicOverallTimeoutMs ?? 0
  const onRetryAttempt = options.onRetryAttempt
  const callerSignal = options.signal
  const client = options.client ?? anthropic

  const deadlineAt = overallTimeoutMs > 0 ? Date.now() + overallTimeoutMs : Infinity

  let attempt = 0
  while (true) {
    if (callerSignal?.aborted) throw abortedError(callerSignal)
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) throw deadlineError(overallTimeoutMs)

    // The last attempt may be cut short by the overall deadline instead.
    const deadlineLimited = remainingMs < timeoutMs
    try {
      return await runAttempt(client, payload, {
        timeoutMs: deadlineLimited ? remainingMs : timeoutMs,
        onTimeout: () =>
          deadlineLimited ? deadlineError(overallTimeoutMs) : timeoutError(timeoutMs),
        callerSignal,
      })
    } catch (err) {
      // Cancellation and the overall deadline are final: never retried.
      if (err?.code === 'ANTHROPIC_ABORTED' || err?.code === 'ANTHROPIC_DEADLINE_EXCEEDED') {
        throw err
      }

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
      // A retry that cannot even start before the overall deadline is pointless.
      if (delayMs >= deadlineAt - Date.now()) throw deadlineError(overallTimeoutMs, err)

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
      await abortableSleep(delayMs, callerSignal)
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

// Demo output was not produced by any model, so it must not claim one. The
// model that would have served the call is kept separately as `intendedModel`.
function demoModelFields(intendedModel) {
  return { provider: null, model: null, intendedModel, promptRevision: null, promptDigest: null }
}

/**
 * Try Claude API, fall back to cached/demo response if credits exhausted
 * Returns { text, provenance } where provenance indicates the source
 */
async function callClaude(model, maxTokens, promptId, input, fallbackFn, options = {}) {
  const template = PROMPT_TEMPLATES[promptId]
  const prompt = renderPromptTemplate(template, input)
  const fallbackInput = input
  if (!config.anthropicApiKey) {
    console.log('  ℹ️  No API key — using demo response')
    options.onUsage?.(unavailableUsage(model, 'no_api_key'))
    return {
      text: fallbackFn(fallbackInput),
      provenance: {
        source: 'demo',
        reason: 'no_api_key',
        message: 'Anthropic API key not configured',
        ...demoModelFields(model),
        illustrative: true,
      },
    }
  }

  try {
    const msg = await createAnthropicMessage(
      {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        onRetryAttempt: options.onRetryAttempt,
        signal: options.signal,
      }
    )
    claudeAvailable = true
    options.onUsage?.(usageFromMessage(msg, model))

    // Combine every text block (not just content[0]) and surface
    // stop/completion metadata so callers can tell a truncated or empty
    // response apart from a normal, complete one.
    const normalized = normalizeContent(msg)
    options.onResponseMeta?.(normalized)
    if (normalized.truncated) {
      console.warn(`  WARNING: Claude response truncated at token limit (model: ${model})`)
    }
    if (normalized.empty) {
      console.warn(
        `  WARNING: Claude response had no text content (model: ${model}, blocks: ${
          normalized.blockTypes.join(', ') || 'none'
        })`
      )
    }
    return {
      text: normalized.text,
      provenance: {
        source: 'live',
        provider: 'anthropic',
        // The model the API reports it used; falls back to the requested id
        // only when the response omits it.
        model: typeof msg?.model === 'string' && msg.model ? msg.model : model,
        requestedModel: model,
        responseId: typeof msg?.id === 'string' ? msg.id : null,
        promptId,
        promptRevision: promptDigest(template),
        promptDigest: promptDigest(prompt),
        maxTokens,
        illustrative: false,
      },
    }
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
      return {
        text: fallbackFn(fallbackInput),
        provenance: {
          source: 'demo',
          reason: 'credits_exhausted',
          message: 'Claude API credits exhausted, using illustrative response',
          ...demoModelFields(model),
          illustrative: true,
        },
      }
    }
    options.onUsage?.(unavailableUsage(model, 'error'))
    throw err
  }
}

async function callClaudeWithModelFallback(
  primaryModel,
  fallbackModel,
  maxTokens,
  promptId,
  input,
  fallbackFn,
  options = {}
) {
  try {
    return await callClaude(primaryModel, maxTokens, promptId, input, fallbackFn, options)
  } catch (err) {
    const message = String(err?.message || '').toLowerCase()
    const isModelResolutionError =
      message.includes('model') || message.includes('not found') || message.includes('unsupported')
    if (!isModelResolutionError || !fallbackModel || fallbackModel === primaryModel) throw err

    console.warn(`  Primary model ${primaryModel} unavailable, retrying with ${fallbackModel}`)
    const result = await callClaude(fallbackModel, maxTokens, promptId, input, fallbackFn, options)
    // Add model fallback info to provenance
    if (result.provenance && result.provenance.source === 'live') {
      result.provenance.modelFallback = {
        primary: primaryModel,
        used: result.provenance.model,
        reason: 'primary_model_unavailable',
      }
    }
    return result
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
  const result = await callClaude(
    AGENT_MODELS.research,
    512,
    'research',
    topic,
    FALLBACKS.research,
    options
  )
  // Return { text, provenance } for caller to handle
  return result
}

/**
 * Summary Agent — Claude Haiku for summarization
 */
export async function runSummary(text, options = {}) {
  const result = await callClaude(
    AGENT_MODELS.summary,
    256,
    'summary',
    text,
    FALLBACKS.summary,
    options
  )
  return result
}

/**
 * Analysis Agent — Claude Sonnet for deep analysis (premium tier)
 */
export async function runAnalysis(topic, options = {}) {
  const result = await callClaudeWithModelFallback(
    AGENT_MODELS.analysisPrimary,
    AGENT_MODELS.analysisFallback,
    800,
    'analysis',
    topic,
    FALLBACKS.analysis,
    options
  )
  return result
}

/**
 * Code Agent — Claude Haiku for code tasks
 */
export async function runCode(prompt, options = {}) {
  const result = await callClaude(AGENT_MODELS.code, 600, 'code', prompt, FALLBACKS.code, options)
  return result
}
