/**
 * Provider Abstraction & Deterministic Offline Demo Composition — StellarMind
 * Multi-LLM provider support with unified interface and opt-in offline demo stubs.
 * Stellar Wave bounties #25 & #155
 */

import crypto from 'node:crypto'
import { MODEL_LABELS, AGENT_MODELS } from '../agents/services.js'
import { unavailableUsage } from '../agents/usage.js'

const PROVIDER_REGISTRY = new Map()

export class ProviderInterface {
  /**
   * @param {Object} config
   * @param {string} [config.apiKey]
   * @param {string} [config.baseUrl]
   * @param {Object} [config.defaultOptions]
   */
  constructor(config = {}) {
    this.config = config
    this.name = 'base'
  }

  /** Returns the list of supported models */
  async listModels() {
    throw new Error('Not implemented')
  }

  /** Execute a completion request */
  async complete(_params) {
    throw new Error('Not implemented')
  }

  /** Execute a chat completion request */
  async chat(_messages, _options = {}) {
    throw new Error('Not implemented')
  }

  /** Health check against the provider */
  async healthCheck() {
    throw new Error('Not implemented')
  }

  /** Provider-specific token counting */
  async countTokens(text) {
    return Math.ceil(String(text || '').length / 4)
  }
}

/**
 * Register a provider implementation.
 * @param {string} name
 * @param {typeof ProviderInterface} ProviderClass
 */
export function registerProvider(name, ProviderClass) {
  PROVIDER_REGISTRY.set(name.toLowerCase(), ProviderClass)
}

/**
 * Create a provider instance.
 * @param {string} name — provider name (e.g., 'openai', 'anthropic', 'offline')
 * @param {Object} config — provider-specific configuration
 * @returns {ProviderInterface}
 */
export function createProvider(name, config = {}) {
  const ProviderClass = PROVIDER_REGISTRY.get(String(name || '').toLowerCase())
  if (!ProviderClass) {
    throw new Error(
      `Unknown provider: ${name}. Available: ${[...PROVIDER_REGISTRY.keys()].join(', ')}`
    )
  }
  return new ProviderClass(config)
}

/**
 * List all registered provider names.
 */
export function listProviders() {
  return [...PROVIDER_REGISTRY.keys()]
}

// ─── Offline Demo Mode State & Constants (#155) ──────────────────────────────

export const SYNTHETIC_TX_PREFIX = 'synthetic-offline-tx-'
export const SYNTHETIC_RECEIPT_LABEL =
  'SYNTHETIC OFFLINE RECEIPT (stubbed locally; no on-chain transaction)'

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

let offlineDemoOverride = null

/**
 * Check whether deterministic offline demo mode is enabled.
 * Offline mode is strictly opt-in via `OFFLINE_DEMO_MODE=true` (or `1`),
 * `--offline` / `--offline-demo` CLI flags, or `setOfflineDemoMode(true)`.
 */
export function isOfflineDemoEnabled(envOrOptions = process.env, argv = process.argv) {
  if (
    envOrOptions &&
    typeof envOrOptions === 'object' &&
    ('env' in envOrOptions || 'argv' in envOrOptions)
  ) {
    const explicitEnv = envOrOptions.env || {}
    const explicitArgv = envOrOptions.argv || []
    const flag = String(explicitEnv?.OFFLINE_DEMO_MODE || '')
      .trim()
      .toLowerCase()
    if (flag === 'true' || flag === '1' || flag === 'yes') {
      return true
    }
    if (
      Array.isArray(explicitArgv) &&
      explicitArgv.some((arg) => arg === '--offline' || arg === '--offline-demo')
    ) {
      return true
    }
    return false
  }

  if (typeof offlineDemoOverride === 'boolean') {
    return offlineDemoOverride
  }
  const flag = String(envOrOptions?.OFFLINE_DEMO_MODE || '')
    .trim()
    .toLowerCase()
  if (flag === 'true' || flag === '1' || flag === 'yes') {
    return true
  }
  if (Array.isArray(argv) && argv.some((arg) => arg === '--offline' || arg === '--offline-demo')) {
    return true
  }
  return false
}

/**
 * Explicitly enable or disable offline demo mode at runtime (used by CLI
 * entrypoints and tests). Pass `null` to reset to environment detection.
 */
export function setOfflineDemoMode(enabled) {
  if (enabled === null || enabled === undefined) {
    offlineDemoOverride = null
    delete process.env.OFFLINE_DEMO_MODE
    return false
  }
  offlineDemoOverride = Boolean(enabled)
  process.env.OFFLINE_DEMO_MODE = offlineDemoOverride ? 'true' : 'false'
  return offlineDemoOverride
}

/**
 * True when a transaction hash represents a synthetic stub receipt that must
 * never link to a real blockchain explorer transaction.
 */
export function isSyntheticReceiptHash(txHash) {
  if (!txHash || typeof txHash !== 'string') return false
  const normalized = txHash.trim().toLowerCase()
  return (
    normalized.startsWith(SYNTHETIC_TX_PREFIX) ||
    normalized.startsWith('synthetic-') ||
    normalized === 'simulated'
  )
}

function deterministicDigest(seed, length = 10) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, length)
}

/**
 * Build a deterministic, visibly marked synthetic payment receipt.
 * Synthetic receipts never include a real explorer URL (`explorerUrl: null`).
 */
export function buildSyntheticPaymentReceipt({
  scenario = 'custom',
  stepIndex = 0,
  agentId = 'research-bot',
  method = 'x402',
  amount = '0.01',
  asset = 'USDC',
  issuer = TESTNET_USDC_ISSUER,
  network = 'stellar:testnet',
  task = '',
} = {}) {
  const normalizedAsset = String(asset || 'USDC').toUpperCase()
  const resolvedIssuer = normalizedAsset === 'XLM' ? null : issuer
  const digest = deterministicDigest(
    `${scenario}|${stepIndex}|${agentId}|${method}|${amount}|${normalizedAsset}|${task}`
  )
  const stepTag = String(stepIndex + 1).padStart(2, '0')
  const txHash = `${SYNTHETIC_TX_PREFIX}${scenario}-${stepTag}-${agentId}-${digest}`

  return {
    synthetic: true,
    offlineMode: true,
    executionMode: 'offline-demo',
    receiptMode: 'synthetic-stub',
    receiptType: 'synthetic-stub',
    receiptLabel: SYNTHETIC_RECEIPT_LABEL,
    txHash,
    explorerUrl: null,
    method,
    amount: String(amount),
    asset: normalizedAsset,
    issuer: resolvedIssuer,
    network,
    verifiedOnChain: false,
  }
}

// ─── Deterministic Offline Agent Responses & Provider ────────────────────────

export const OFFLINE_AGENT_RESPONSES = {
  'research-bot': (topic) =>
    `[Offline Demo — Research Agent Stub (${MODEL_LABELS.research})]\n\n` +
    `Deterministic research synthesis for "${topic}":\n` +
    `• Autonomous AI agents use HTTP 402 payment challenges to negotiate and settle per-request API calls deterministically.\n` +
    `• Stellar provides predictable finality and sub-cent transaction costs well suited for high-frequency agent commerce.\n` +
    `• Offline demo mode uses canned deterministic outputs and synthetic receipts so contributors can verify workflows without live keys or funding.`,

  'summary-bot': (text) => {
    const headline = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90)
    return (
      `[Offline Demo — Summary Agent Stub (${MODEL_LABELS.summary})]\n\n` +
      `Executive Summary (${headline}${headline.length >= 90 ? '...' : ''}):\n` +
      `Programmable micropayments allow orchestrators to compose specialist AI agents within strict budget guardrails while recording verifiable per-step audit trails.`
    )
  },

  'analyst-bot': (topic) =>
    `[Offline Demo — Analysis Agent Stub (${MODEL_LABELS.analysis})]\n\n` +
    `Strategic Analysis for "${topic}":\n\n` +
    `**Key Findings:**\n` +
    `• Per-call x402 settlement aligns agent expenditure directly with task value.\n` +
    `• Exact base-unit budget accounting prevents floating-point drift across multi-step plans.\n` +
    `• Explicit reconciliation separates confirmed settlements from unresolved transport failures.\n\n` +
    `**Risks:**\n` +
    `• Upstream model or network latency requires bounded admission queues and clear timeout policies.\n` +
    `• Cross-asset fallback transfers (USDC vs XLM) must be reported separately without fabricated exchange rates.\n\n` +
    `**Opportunities:**\n` +
    `• Deterministic offline fixtures enable repeatable CI and contributor onboarding without external credentials.`,

  'code-bot': (prompt) => {
    const cleanPrompt = String(prompt || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70)
    return (
      `[Offline Demo — Code Agent Stub (${MODEL_LABELS.code})]\n\n` +
      '```javascript\n' +
      `// Deterministic offline reference implementation for: ${cleanPrompt}\n` +
      `export function verifySyntheticReceipt(receipt) {\n` +
      `  if (!receipt || receipt.synthetic !== true) {\n` +
      `    throw new Error('Expected a synthetic offline demo receipt');\n` +
      `  }\n` +
      `  return {\n` +
      `    txHash: receipt.txHash,\n` +
      `    explorerUrl: null,\n` +
      '    settled: `${receipt.amount} ${receipt.asset}`,\n' +
      `  };\n` +
      `}\n` +
      '```\n\n' +
      `This deterministic reference helper validates synthetic offline receipts without external RPC calls.`
    )
  },
}

function createOfflineServiceHandler(agentId, model) {
  return async function offlineService(input, options = {}) {
    const renderer = OFFLINE_AGENT_RESPONSES[agentId] || OFFLINE_AGENT_RESPONSES['research-bot']
    const text = renderer(input)
    options.onUsage?.(unavailableUsage(model, 'offline_demo_stub'))
    options.onResponseMeta?.({
      text,
      truncated: false,
      empty: false,
      stopReason: 'end_turn',
      blockTypes: ['text'],
      offlineMode: true,
      synthetic: true,
    })
    return text
  }
}

export const OFFLINE_SERVICE_MAP = Object.freeze({
  'research-bot': createOfflineServiceHandler('research-bot', AGENT_MODELS.research),
  'summary-bot': createOfflineServiceHandler('summary-bot', AGENT_MODELS.summary),
  'analyst-bot': createOfflineServiceHandler('analyst-bot', AGENT_MODELS.analysisPrimary),
  'code-bot': createOfflineServiceHandler('code-bot', AGENT_MODELS.code),
})

export const OFFLINE_PREMIUM_SERVICES = Object.freeze({
  runResearch: OFFLINE_SERVICE_MAP['research-bot'],
  runSummary: OFFLINE_SERVICE_MAP['summary-bot'],
  runAnalysis: OFFLINE_SERVICE_MAP['analyst-bot'],
  runCode: OFFLINE_SERVICE_MAP['code-bot'],
  MODEL_LABELS,
})

export class OfflineDemoProvider extends ProviderInterface {
  constructor(config = {}) {
    super(config)
    this.name = 'offline-demo'
  }

  async listModels() {
    return [
      { id: AGENT_MODELS.research, role: 'research', mode: 'offline-demo' },
      { id: AGENT_MODELS.summary, role: 'summary', mode: 'offline-demo' },
      { id: AGENT_MODELS.analysisPrimary, role: 'analysis', mode: 'offline-demo' },
      { id: AGENT_MODELS.code, role: 'code', mode: 'offline-demo' },
    ]
  }

  async complete(paramsOrPrompt = {}, options = {}) {
    const params =
      typeof paramsOrPrompt === 'string'
        ? { ...options, prompt: paramsOrPrompt }
        : { ...options, ...(paramsOrPrompt || {}) }
    const agentId = params.agentId || params.role || 'research-bot'
    const input = params.prompt || params.input || ''
    const service = OFFLINE_SERVICE_MAP[agentId] || OFFLINE_SERVICE_MAP['research-bot']
    const text = await service(input)
    return {
      provider: this.name,
      offlineMode: true,
      synthetic: true,
      model: params.model || AGENT_MODELS.research,
      text,
      content: text,
    }
  }

  async chat(messages = [], options = {}) {
    const lastMessage = Array.isArray(messages) ? messages[messages.length - 1] : null
    const prompt = lastMessage?.content || ''
    return this.complete({ ...options, prompt })
  }

  async healthCheck() {
    return {
      ok: true,
      provider: this.name,
      offlineMode: true,
      synthetic: true,
    }
  }
}

registerProvider('offline', OfflineDemoProvider)
registerProvider('offline-demo', OfflineDemoProvider)

// ─── Canonical Offline Demo Fixtures (#155) ──────────────────────────────────
//
// Covers the three required workflow classes:
//   1. `successful`: all planned steps execute and settle with synthetic x402 receipts
//   2. `partial`: mixed outcomes (x402 synthetic receipt + 4xx -> XLM fallback synthetic
//      receipt + transport error leaving one step unresolved/unpaid)
//   3. `budget-limited`: affordable steps settle with synthetic x402 receipts while
//      remaining planned steps are skipped by the budget guardrail

export const OFFLINE_DEMO_FIXTURES = Object.freeze({
  successful: Object.freeze({
    id: 'successful',
    name: 'Successful Multi-Agent Run',
    description:
      'All 3 planned agents execute within the 0.15 USDC budget and settle with synthetic x402 USDC receipts.',
    task: 'Research the latest trends in AI-powered payments on blockchain networks',
    budget: 0.15,
    plan: Object.freeze({
      plan: 'Offline deterministic plan (successful): research-bot -> summary-bot -> analyst-bot (0.0700 USDC total quote)',
      subtasks: Object.freeze([
        Object.freeze({
          stepId: 'step-0',
          agentId: 'research-bot',
          input: 'Research the latest trends in AI-powered payments on blockchain networks',
          cost: '0.01',
        }),
        Object.freeze({
          stepId: 'step-1',
          agentId: 'summary-bot',
          input: 'Summarize key findings on AI-powered blockchain payments',
          cost: '0.01',
        }),
        Object.freeze({
          stepId: 'step-2',
          agentId: 'analyst-bot',
          input: 'Strategic analysis of x402 micropayments for autonomous agents',
          cost: '0.05',
        }),
      ]),
    }),
    stepBehaviors: Object.freeze([
      Object.freeze({ mode: 'x402-synthetic' }),
      Object.freeze({ mode: 'x402-synthetic' }),
      Object.freeze({ mode: 'x402-synthetic' }),
    ]),
  }),

  partial: Object.freeze({
    id: 'partial',
    name: 'Partial Settlement & Fallback Run',
    description:
      'Step 1 settles via synthetic x402 USDC, Step 2 rejects on x402 and settles via synthetic XLM fallback, and Step 3 hits an unresolved transport error (no double charge).',
    task: 'Analyze the competitive landscape of decentralized agent marketplaces',
    budget: 0.1,
    plan: Object.freeze({
      plan: 'Offline deterministic plan (partial): research-bot -> analyst-bot -> code-bot (mixed x402, XLM fallback, and unresolved step)',
      subtasks: Object.freeze([
        Object.freeze({
          stepId: 'step-0',
          agentId: 'research-bot',
          input: 'Analyze the competitive landscape of decentralized agent marketplaces',
          cost: '0.01',
        }),
        Object.freeze({
          stepId: 'step-1',
          agentId: 'analyst-bot',
          input: 'Compare decentralized agent marketplace protocols and settlement guarantees',
          cost: '0.05',
        }),
        Object.freeze({
          stepId: 'step-2',
          agentId: 'code-bot',
          input: 'Write a receipt verification helper for marketplace payments',
          cost: '0.03',
        }),
      ]),
    }),
    stepBehaviors: Object.freeze([
      Object.freeze({ mode: 'x402-synthetic' }),
      Object.freeze({ mode: 'xlm-fallback-synthetic' }),
      Object.freeze({ mode: 'transport-unresolved' }),
    ]),
  }),

  'budget-limited': Object.freeze({
    id: 'budget-limited',
    name: 'Budget-Limited Guardrail Run',
    description:
      'A 4-step plan under a 0.02 USDC budget executes the first two 0.01 USDC steps and skips the remaining 0.05 and 0.03 USDC steps.',
    task: 'Research quantum computing impact on cryptography',
    budget: 0.02,
    plan: Object.freeze({
      plan: 'Offline deterministic plan (budget-limited): research-bot -> summary-bot -> analyst-bot -> code-bot (0.0200 USDC budget cap)',
      subtasks: Object.freeze([
        Object.freeze({
          stepId: 'step-0',
          agentId: 'research-bot',
          input: 'Research quantum computing impact on cryptography',
          cost: '0.01',
        }),
        Object.freeze({
          stepId: 'step-1',
          agentId: 'summary-bot',
          input: 'Summarize post-quantum cryptography readiness for Stellar',
          cost: '0.01',
        }),
        Object.freeze({
          stepId: 'step-2',
          agentId: 'analyst-bot',
          input: 'Assess migration risks for Ed25519 signatures under quantum adversaries',
          cost: '0.05',
        }),
        Object.freeze({
          stepId: 'step-3',
          agentId: 'code-bot',
          input: 'Draft a key-rotation migration checklist',
          cost: '0.03',
        }),
      ]),
    }),
    stepBehaviors: Object.freeze([
      Object.freeze({ mode: 'x402-synthetic' }),
      Object.freeze({ mode: 'x402-synthetic' }),
      Object.freeze({ mode: 'x402-synthetic' }),
      Object.freeze({ mode: 'x402-synthetic' }),
    ]),
  }),
})

export function listOfflineDemoFixtures() {
  return Object.values(OFFLINE_DEMO_FIXTURES)
}

/**
 * Resolve one of the canonical fixtures (`successful`, `partial`, `budget-limited`)
 * by explicit id, task match, or budget heuristic, falling back to a deterministic
 * custom offline plan so arbitrary dashboard tasks also run 100% offline.
 */
export function resolveOfflineFixture(task, budget, requestedFixtureId = null) {
  if (requestedFixtureId && OFFLINE_DEMO_FIXTURES[requestedFixtureId]) {
    return OFFLINE_DEMO_FIXTURES[requestedFixtureId]
  }

  const normalizedTask = String(task || '')
    .trim()
    .toLowerCase()
  const numericBudget = Number(budget)

  for (const fixture of Object.values(OFFLINE_DEMO_FIXTURES)) {
    if (fixture.task.toLowerCase() === normalizedTask) {
      return fixture
    }
  }

  if (normalizedTask.includes('partial') || normalizedTask.includes('competitive landscape')) {
    return {
      ...OFFLINE_DEMO_FIXTURES.partial,
      task: String(task || OFFLINE_DEMO_FIXTURES.partial.task),
      budget: Number.isFinite(numericBudget) ? numericBudget : OFFLINE_DEMO_FIXTURES.partial.budget,
    }
  }

  if (
    normalizedTask.includes('quantum') ||
    normalizedTask.includes('budget-limited') ||
    (Number.isFinite(numericBudget) && numericBudget > 0 && numericBudget <= 0.04)
  ) {
    return {
      ...OFFLINE_DEMO_FIXTURES['budget-limited'],
      task: String(task || OFFLINE_DEMO_FIXTURES['budget-limited'].task),
      budget: Number.isFinite(numericBudget)
        ? numericBudget
        : OFFLINE_DEMO_FIXTURES['budget-limited'].budget,
      plan: {
        plan: `Offline deterministic plan (budget-limited): research-bot -> summary-bot -> analyst-bot -> code-bot (${budget} USDC budget)`,
        subtasks: [
          { stepId: 'step-0', agentId: 'research-bot', input: String(task), cost: '0.01' },
          {
            stepId: 'step-1',
            agentId: 'summary-bot',
            input: `Summarize findings about: ${task}`,
            cost: '0.01',
          },
          { stepId: 'step-2', agentId: 'analyst-bot', input: String(task), cost: '0.05' },
          {
            stepId: 'step-3',
            agentId: 'code-bot',
            input: `Write an implementation related to: ${task}`,
            cost: '0.03',
          },
        ],
      },
    }
  }

  return {
    id: 'successful',
    name: 'Successful Deterministic Offline Run',
    description: 'Deterministic offline workflow using synthetic x402 payment receipts.',
    task: String(task || OFFLINE_DEMO_FIXTURES.successful.task),
    budget: Number.isFinite(numericBudget)
      ? numericBudget
      : OFFLINE_DEMO_FIXTURES.successful.budget,
    plan: {
      plan: `Offline deterministic plan: research-bot -> summary-bot -> analyst-bot (${budget} USDC budget)`,
      subtasks: [
        { stepId: 'step-0', agentId: 'research-bot', input: String(task), cost: '0.01' },
        {
          stepId: 'step-1',
          agentId: 'summary-bot',
          input: `Summarize findings about: ${task}`,
          cost: '0.01',
        },
        { stepId: 'step-2', agentId: 'analyst-bot', input: String(task), cost: '0.05' },
      ],
    },
    stepBehaviors: [
      { mode: 'x402-synthetic' },
      { mode: 'x402-synthetic' },
      { mode: 'x402-synthetic' },
    ],
  }
}

function agentIdFromPremiumUrl(url) {
  const pathStr = String(url || '')
  if (pathStr.includes('/api/premium/research')) return { agentId: 'research-bot', amount: '0.01' }
  if (pathStr.includes('/api/premium/summarize')) return { agentId: 'summary-bot', amount: '0.01' }
  if (pathStr.includes('/api/premium/analyze')) return { agentId: 'analyst-bot', amount: '0.05' }
  if (pathStr.includes('/api/premium/code')) return { agentId: 'code-bot', amount: '0.03' }
  return { agentId: 'research-bot', amount: '0.01' }
}

function extractQueryInput(url) {
  try {
    const parsed = new URL(url, 'http://localhost:3001')
    return (
      parsed.searchParams.get('topic') ||
      parsed.searchParams.get('text') ||
      parsed.searchParams.get('prompt') ||
      ''
    )
  } catch {
    return ''
  }
}

/**
 * Build an orchestration execution context that runs 100% offline with
 * deterministic planning, stub agent responses, and synthetic payment receipts.
 */
export function createOfflineExecutionContext(task, budget, baseContext = {}) {
  const fixture = resolveOfflineFixture(task, budget, baseContext.fixture || baseContext.scenario)
  const network = baseContext.network || 'stellar:testnet'
  const issuer = baseContext.issuer || TESTNET_USDC_ISSUER
  let x402CallIndex = 0
  let fallbackCallIndex = 0

  const offlineX402Fetch = async (url) => {
    const stepIndex = x402CallIndex++
    const behavior = fixture.stepBehaviors?.[stepIndex] || { mode: 'x402-synthetic' }
    const { agentId, amount } = agentIdFromPremiumUrl(url)
    const input = extractQueryInput(url) || task

    if (behavior.mode === 'transport-unresolved') {
      throw new Error('Offline simulated x402 transport interruption (no settlement confirmation)')
    }

    if (behavior.mode === 'xlm-fallback-synthetic') {
      const body = {
        error: 'offline_simulated_x402_rejection',
        message: 'Simulated 400 rejection in offline partial fixture; falling back to XLM stub',
        offlineMode: true,
        synthetic: true,
      }
      return {
        ok: false,
        status: 400,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    }

    const serviceFn = OFFLINE_SERVICE_MAP[agentId] || OFFLINE_SERVICE_MAP['research-bot']
    const resultText = await serviceFn(input)
    const receipt = buildSyntheticPaymentReceipt({
      scenario: fixture.id,
      stepIndex,
      agentId,
      method: 'x402',
      amount,
      asset: 'USDC',
      issuer,
      network,
      task: fixture.task,
    })

    const settlementHeaderPayload = JSON.stringify({
      success: true,
      transaction: receipt.txHash,
      network,
      synthetic: true,
      offlineMode: true,
      receiptLabel: SYNTHETIC_RECEIPT_LABEL,
    })

    const responseBody = {
      agent: agentId,
      result: resultText,
      paidVia: 'x402',
      offlineMode: true,
      synthetic: true,
      receipt,
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const lower = String(name || '').toLowerCase()
          if (lower === 'content-type') return 'application/json'
          if (lower === 'payment-response' || lower === 'x-payment-response') {
            return settlementHeaderPayload
          }
          return null
        },
      },
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    }
  }

  const offlineSendPayment = async (_senderSecret, _recipientPublic, amount, memo = '') => {
    const fallbackIndex = fallbackCallIndex++
    const agentId = String(memo || '').startsWith('pay:') ? memo.slice(4) : 'analyst-bot'
    const receipt = buildSyntheticPaymentReceipt({
      scenario: fixture.id,
      stepIndex: fallbackIndex + 1,
      agentId,
      method: 'stellar-xlm-direct',
      amount,
      asset: 'XLM',
      issuer: null,
      network,
      task: fixture.task,
    })

    return {
      success: true,
      txHash: receipt.txHash,
      explorerUrl: null,
      synthetic: true,
      offlineMode: true,
      receiptMode: 'synthetic-stub',
      receiptLabel: SYNTHETIC_RECEIPT_LABEL,
      receipt,
    }
  }

  return {
    ...baseContext,
    _offlineComposed: true,
    offlineMode: true,
    executionMode: 'offline-demo',
    receiptMode: 'synthetic-stub',
    scenario: fixture.id,
    fixtureId: fixture.id,
    plan: baseContext.plan || fixture.plan,
    serviceMap: baseContext.serviceMap || OFFLINE_SERVICE_MAP,
    x402Fetch: baseContext.x402Fetch !== undefined ? baseContext.x402Fetch : offlineX402Fetch,
    sendPayment:
      baseContext.sendPayment !== undefined ? baseContext.sendPayment : offlineSendPayment,
  }
}

// ─── Offline Wallet Balances & Synthetic Transaction History ─────────────────

export const OFFLINE_DEMO_WALLETS = Object.freeze({
  server: Object.freeze({
    address: 'GDEMOSERVEROFFLINEWALLET00000000000000000000000000000000',
    available: true,
    synthetic: true,
    offlineMode: true,
    balances: Object.freeze([
      Object.freeze({ asset: 'XLM', balance: '500.0000000', issuer: null, synthetic: true }),
      Object.freeze({
        asset: 'USDC',
        balance: '125.0000000',
        issuer: TESTNET_USDC_ISSUER,
        synthetic: true,
      }),
    ]),
  }),
  orchestrator: Object.freeze({
    address: 'GDEMOORCHESTRATOROFFLINEWALLET00000000000000000000000000',
    available: true,
    synthetic: true,
    offlineMode: true,
    balances: Object.freeze([
      Object.freeze({ asset: 'XLM', balance: '250.0000000', issuer: null, synthetic: true }),
      Object.freeze({
        asset: 'USDC',
        balance: '50.0000000',
        issuer: TESTNET_USDC_ISSUER,
        synthetic: true,
      }),
    ]),
  }),
  buyer: Object.freeze({
    address: 'GDEMOBUYEROFFLINEWALLET000000000000000000000000000000000',
    available: true,
    synthetic: true,
    offlineMode: true,
    balances: Object.freeze([
      Object.freeze({ asset: 'XLM', balance: '100.0000000', issuer: null, synthetic: true }),
      Object.freeze({
        asset: 'USDC',
        balance: '25.0000000',
        issuer: TESTNET_USDC_ISSUER,
        synthetic: true,
      }),
    ]),
  }),
})

export function getOfflineWalletBalances(correlationId = 'offline-demo') {
  return {
    offlineMode: true,
    executionMode: 'offline-demo',
    receiptMode: 'synthetic-stub',
    synthetic: true,
    wallets: {
      server: {
        address: OFFLINE_DEMO_WALLETS.server.address,
        available: true,
        synthetic: true,
        offlineMode: true,
        balances: OFFLINE_DEMO_WALLETS.server.balances.map((b) => ({ ...b })),
      },
      orchestrator: {
        address: OFFLINE_DEMO_WALLETS.orchestrator.address,
        available: true,
        synthetic: true,
        offlineMode: true,
        balances: OFFLINE_DEMO_WALLETS.orchestrator.balances.map((b) => ({ ...b })),
      },
      buyer: {
        address: OFFLINE_DEMO_WALLETS.buyer.address,
        available: true,
        synthetic: true,
        offlineMode: true,
        balances: OFFLINE_DEMO_WALLETS.buyer.balances.map((b) => ({ ...b })),
      },
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    correlationId,
  }
}

export function getOfflineWalletTransactions(
  address = OFFLINE_DEMO_WALLETS.orchestrator.address,
  limit = 20,
  correlationId = 'offline-demo'
) {
  const sampleReceipts = [
    buildSyntheticPaymentReceipt({
      scenario: 'successful',
      stepIndex: 0,
      agentId: 'research-bot',
      method: 'x402',
      amount: '0.01',
      asset: 'USDC',
      task: OFFLINE_DEMO_FIXTURES.successful.task,
    }),
    buildSyntheticPaymentReceipt({
      scenario: 'successful',
      stepIndex: 1,
      agentId: 'summary-bot',
      method: 'x402',
      amount: '0.01',
      asset: 'USDC',
      task: OFFLINE_DEMO_FIXTURES.successful.task,
    }),
    buildSyntheticPaymentReceipt({
      scenario: 'partial',
      stepIndex: 1,
      agentId: 'analyst-bot',
      method: 'stellar-xlm-direct',
      amount: '0.05',
      asset: 'XLM',
      issuer: null,
      task: OFFLINE_DEMO_FIXTURES.partial.task,
    }),
  ]

  const boundedLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 20))
  const transactions = sampleReceipts.slice(0, boundedLimit).map((receipt, index) => ({
    hash: receipt.txHash,
    paging_token: `offline-cursor-${index + 1}`,
    ledger: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    memo: `offline:${receipt.method}`,
    memo_type: 'text',
    feeCharged: '0',
    operationCount: 1,
    operation_count: 1,
    successful: true,
    synthetic: true,
    offlineMode: true,
    receiptMode: 'synthetic-stub',
    receiptLabel: SYNTHETIC_RECEIPT_LABEL,
    explorerUrl: null,
    operations: [
      {
        id: `offline-op-${index + 1}`,
        type: 'payment',
        amount: receipt.amount,
        asset_code: receipt.asset,
        from: OFFLINE_DEMO_WALLETS.orchestrator.address,
        to: OFFLINE_DEMO_WALLETS.server.address,
        synthetic: true,
      },
    ],
  }))

  return {
    success: true,
    offlineMode: true,
    executionMode: 'offline-demo',
    receiptMode: 'synthetic-stub',
    synthetic: true,
    address: address || OFFLINE_DEMO_WALLETS.orchestrator.address,
    count: transactions.length,
    transactions,
    correlationId,
  }
}

export { PROVIDER_REGISTRY }
