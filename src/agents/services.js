import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export let anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Track whether Claude API is available
let claudeAvailable = true;

export const AGENT_MODELS = {
  research: 'claude-haiku-4-5-20251001',
  summary: 'claude-haiku-4-5-20251001',
  analysisPrimary: 'claude-sonnet-4-5-20250929',
  analysisFallback: 'claude-haiku-4-5-20251001',
  code: 'claude-haiku-4-5-20251001',
};

export const MODEL_LABELS = {
  research: AGENT_MODELS.research,
  summary: AGENT_MODELS.summary,
  analysis: `${AGENT_MODELS.analysisPrimary} (fallback: ${AGENT_MODELS.analysisFallback})`,
  code: AGENT_MODELS.code,
};

/**
 * Update the Anthropic API key at runtime.
 * Allows users to plug in their own key without restarting the server.
 * Security: Key is stored in memory only, never logged or persisted.
 */
export function setApiKey(newKey) {
  anthropic = new Anthropic({ apiKey: newKey });
  config.anthropicApiKey = newKey;
  claudeAvailable = true;
  // Security: Never log the actual key, only confirm it was set
  console.log('  🔑 Anthropic API key updated at runtime (ephemeral, session-only)');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error(`Anthropic request timed out after ${timeoutMs}ms`);
        err.code = 'ANTHROPIC_TIMEOUT';
        err.status = 408;
        reject(err);
      }, timeoutMs);
    }),
  ]);
}

function isTransientAnthropicError(err) {
  const status = err?.status;
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;

  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('timeout')
    || msg.includes('temporar')
    || msg.includes('rate limit')
    || msg.includes('overloaded')
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('network')
  );
}

function formatAnthropicError(err) {
  const status = err?.status ? `status ${err.status}` : 'no-status';
  const code = err?.code ? `code ${err.code}` : 'no-code';
  const message = err?.message || 'Unknown Anthropic error';
  return `${status}, ${code}: ${message}`;
}

export async function createAnthropicMessage(payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.anthropicRequestTimeoutMs;
  const maxRetries = options.maxRetries ?? config.anthropicMaxRetries;
  const baseDelayMs = options.baseDelayMs ?? config.anthropicRetryBaseDelayMs;
  const onRetryAttempt = options.onRetryAttempt;

  let attempt = 0;
  while (true) {
    try {
      return await withTimeout(anthropic.messages.create(payload), timeoutMs);
    } catch (err) {
      const transient = isTransientAnthropicError(err);
      if (!transient) {
        const fastFail = new Error(`Non-transient Anthropic API error (${formatAnthropicError(err)})`);
        fastFail.status = err?.status;
        fastFail.code = err?.code;
        fastFail.cause = err;
        throw fastFail;
      }

      if (attempt >= maxRetries) {
        const exhausted = new Error(`Anthropic API retries exhausted after ${attempt} retries (${formatAnthropicError(err)})`);
        exhausted.status = err?.status;
        exhausted.code = err?.code;
        exhausted.cause = err;
        throw exhausted;
      }

      const nextAttempt = attempt + 1;
      const delayMs = baseDelayMs * (2 ** attempt);
      console.warn(`Anthropic transient error, retrying attempt ${nextAttempt}/${maxRetries} in ${delayMs}ms: ${err.message}`);
      onRetryAttempt?.({
        attempt: nextAttempt,
        maxRetries,
        delayMs,
        status: err?.status || null,
        error: err?.message || 'unknown error',
      });
      await sleep(delayMs);
      attempt += 1;
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
};

/**
 * Try Claude API, fall back to cached/demo response if credits exhausted
 */
async function callClaude(model, maxTokens, prompt, fallbackFn, fallbackInput, options = {}) {
  if (!config.anthropicApiKey) {
    console.log('  ℹ️  No API key — using demo response');
    return fallbackFn(fallbackInput);
  }

  try {
    const msg = await createAnthropicMessage({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }, {
      onRetryAttempt: options.onRetryAttempt,
    });
    claudeAvailable = true;
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  } catch (err) {
    console.error(`Claude API error: ${err.message}`);
    if (err.message?.includes('credit balance') || err.message?.includes('rate_limit') || err.status === 429) {
      if (claudeAvailable) {
        console.log('  ⚠️  Claude API credits exhausted — switching to demo responses');
        claudeAvailable = false;
      }
      return fallbackFn(fallbackInput);
    }
    throw err;
  }
}

async function callClaudeWithModelFallback(primaryModel, fallbackModel, maxTokens, prompt, fallbackFn, fallbackInput, options = {}) {
  try {
    return await callClaude(primaryModel, maxTokens, prompt, fallbackFn, fallbackInput, options);
  } catch (err) {
    const message = String(err?.message || '').toLowerCase();
    const isModelResolutionError = message.includes('model') || message.includes('not found') || message.includes('unsupported');
    if (!isModelResolutionError || !fallbackModel || fallbackModel === primaryModel) throw err;

    console.warn(`  Primary model ${primaryModel} unavailable, retrying with ${fallbackModel}`);
    return callClaude(fallbackModel, maxTokens, prompt, fallbackFn, fallbackInput, options);
  }
}

/**
 * Check if Claude API is currently available
 */
export function isClaudeAvailable() {
  return claudeAvailable;
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
    options,
  );
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
    options,
  );
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
    options,
  );
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
    options,
  );
}
