import { config } from '../config.js'
import { AGENTS, getAgentById } from './registry.js'
import { validatePlan } from './plan-validator.js'
import {
  runResearch,
  runSummary,
  runAnalysis,
  runCode,
  createAnthropicMessage,
} from './services.js'
import { getBalance, sendPayment } from '../stellar/wallet.js'
import { logger } from '../logger.js'

import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
import { ExactStellarScheme, createEd25519Signer } from '@x402/stellar'
import { parseSettlementHeader, extractTxHash } from './settlement-header.js'
import {
  canAttemptFallback,
  confirmPaymentAttempt,
  createPaymentAttempt,
  failPaymentAttempt,
  markPaymentAttemptUnknown,
  reconcilePaymentAttempt,
  summarizePaymentAttempts,
  upsertPaymentAttempt,
} from './payment-attempts.js'
import {
  AssetAmount,
  agentCost,
  exceedsBudget,
  buildSkipResult,
  buildBudgetLimitEvent,
  formatAmount,
  paymentBucket,
  paymentProtocolSummary,
  isBudgetExhausted,
  countUsed,
  countSkipped,
} from './budget.js'
import {
  usageFromMessage,
  unavailableUsage,
  recordUsageEntry,
  summarizeUsageByPhase,
} from './usage.js'
import { normalizeContent } from './response-normalization.js'

// const anthropic = ... (imported from services.js)

const SERVICE_MAP = {
  'research-bot': runResearch,
  'summary-bot': runSummary,
  'analyst-bot': runAnalysis,
  'code-bot': runCode,
}

const PREMIUM_ENDPOINT_MAP = {
  'research-bot': (input) => `/api/premium/research?topic=${encodeURIComponent(input)}`,
  'summary-bot': (input) => `/api/premium/summarize?text=${encodeURIComponent(input)}`,
  'analyst-bot': (input) => `/api/premium/analyze?topic=${encodeURIComponent(input)}`,
  'code-bot': (input) => `/api/premium/code?prompt=${encodeURIComponent(input)}`,
}

const EXPLORER_NETWORK_SEGMENT = config.network.includes('testnet') ? 'testnet' : 'public'
const EXPLORER_BASE_URL = `https://stellar.expert/explorer/${EXPLORER_NETWORK_SEGMENT}/tx/`

let x402Fetch = null
let x402InitError = null
let x402WalletReady = null
let x402WalletHint = null

if (config.orchestratorSecret) {
  try {
    const signer = createEd25519Signer(config.orchestratorSecret, config.network)
    const rpcConfig = config.stellarRpcUrl ? { url: config.stellarRpcUrl } : undefined
    const stellarClientScheme = new ExactStellarScheme(signer, rpcConfig)

    const client = x402Client.fromConfig({
      schemes: [{ network: config.network, client: stellarClientScheme }],
    })

    const httpClient = new x402HTTPClient(client)
    x402Fetch = wrapFetchWithPayment(fetch, httpClient)

    logger.info('x402_client_configured')
  } catch (err) {
    x402InitError = err?.message || 'unknown x402 client init error'
    logger.warn('x402_client_init_failed', { error: x402InitError })
  }
} else {
  x402InitError = 'ORCHESTRATOR_STELLAR_SECRET is not configured'
  logger.warn('x402_client_disabled', { reason: x402InitError })
}

async function checkX402WalletReadiness() {
  if (!config.orchestratorAddress) {
    x402WalletReady = false
    x402WalletHint = 'ORCHESTRATOR_STELLAR_ADDRESS is not configured'
    logger.warn('x402_wallet_not_ready', { reason: x402WalletHint })
    return
  }

  try {
    const balances = await getBalance(config.orchestratorAddress)
    const usdcBalance = balances.find((balance) => balance.asset === 'USDC')
    const usdcAmount = Number.parseFloat(usdcBalance?.balance || '0')

    if (!usdcBalance) {
      x402WalletReady = false
      x402WalletHint = 'No USDC trustline on orchestrator wallet. Run: npm run setup:usdc'
      logger.warn('x402_wallet_not_ready', { reason: x402WalletHint })
      return
    }

    if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
      x402WalletReady = false
      x402WalletHint = 'USDC balance is 0. Fund testnet USDC via https://faucet.circle.com'
      logger.warn('x402_wallet_not_ready', { reason: x402WalletHint })
      return
    }

    x402WalletReady = true
    x402WalletHint = null
    logger.info('x402_wallet_ready', { usdcBalance: usdcBalance.balance })
  } catch (err) {
    x402WalletReady = false
    x402WalletHint = `Unable to verify x402 wallet readiness: ${summarizeError(err)}`
    logger.warn('x402_wallet_not_ready', { reason: x402WalletHint })
  }
}

if (x402Fetch) {
  checkX402WalletReadiness().catch((err) => {
    x402WalletReady = false
    x402WalletHint = `Wallet readiness check failed: ${summarizeError(err)}`
    logger.warn('x402_wallet_not_ready', { reason: x402WalletHint })
  })
}

function summarizeError(err) {
  return (err?.message || 'unknown error').substring(0, 180)
}

function buildExplorerUrl(txHash) {
  return txHash ? `${EXPLORER_BASE_URL}${txHash}` : null
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json()

  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { result: text }
  }
}

async function callAgentViaX402(agent, input, broadcastFn, context = {}) {
  const baseUrl = config.internalBaseUrl
  const endpointFn = PREMIUM_ENDPOINT_MAP[agent.id]

  // One persisted attempt per (run, step) — see payment-attempts.js. The id
  // is derived from the run and step, so a reconciliation after a restart
  // addresses the same logical charge instead of opening a new one.
  let paymentAttempt = createPaymentAttempt({
    runId: context.runId || context.correlationId || 'local',
    stepId: agent.id,
    agentId: agent.id,
    amount: agent.price,
    currency: agent.currency,
  })
  // The direct-payment path is a *fallback settlement* for the same logical
  // charge, so it is only permitted once that charge is known to have
  // failed terminally. With no x402 attempt there is nothing to reconcile.
  let fallbackPermitted = !(x402Fetch && endpointFn)
  let x402FailureReason = null

  if (x402Fetch && endpointFn) {
    try {
      const url = `${baseUrl}${endpointFn(input)}`
      logger.info('x402_request_start', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: 'x402',
        endpoint: url,
      })

      const response = await x402Fetch(url)
      const data = await parseResponseBody(response)

      if (response.ok) {
        const settle = parseSettlementHeader(response)
        const txHash = extractTxHash(settle)
        const settlementFailed =
          settle?.success === false || Boolean(settle?.error || settle?.errorReason)
        if (settlementFailed) {
          const reason = settle?.errorReason || settle?.error || 'x402 settlement failed'
          // The settlement header is definitive evidence that nothing was
          // charged, which is exactly what makes this a terminal failure.
          paymentAttempt = failPaymentAttempt(paymentAttempt, 'x402_settlement_reported_failure')
          x402FailureReason = reason
          logger.warn('x402_settlement_reported_failure', {
            correlationId: context.correlationId,
            agentId: agent.id,
            paymentMethod: 'x402',
            reason,
          })
        } else {
          const verification = txHash ? 'verified' : 'unverified'
          paymentAttempt = confirmPaymentAttempt(paymentAttempt, {
            txHash,
            explorerUrl: buildExplorerUrl(txHash),
            proof: txHash ? { source: 'x402-settlement-header', txHash } : null,
          })
          broadcastFn?.({
            type: 'x402_payment',
            agent: agent.name,
            agentId: agent.id,
            flow: '402 -> sign -> settle -> 200',
            protocol: 'x402',
            amount: agent.price,
            currency: agent.currency,
            verification,
            txHash: txHash || null,
            explorerUrl: buildExplorerUrl(txHash),
            timestamp: new Date().toISOString(),
          })
        }

        return {
          result: data.result || JSON.stringify(data),
          paymentMethod: 'x402',
          paymentSuccess: !settlementFailed,
          paidVia: !settlementFailed ? 'x402' : 'none',
          txHash: !settlementFailed ? txHash || null : null,
          explorerUrl: !settlementFailed ? buildExplorerUrl(txHash) : null,
          warning:
            !settlementFailed && !txHash
              ? 'x402 settlement completed without transaction hash header'
              : undefined,
          // The premium endpoint served this call remotely - we never touched
          // the Anthropic client ourselves, so provider token usage is
          // genuinely unknown here, not zero.
          usage: unavailableUsage(agent.model || null, 'x402_remote_call'),
          // Likewise, there's no raw Anthropic content-block response to
          // normalize for a remote x402 call.
          responseMeta: null,
          // The settled attempt travels with the result so run history can
          // persist it and the run summary can report it (#131).
          paymentAttempt,
          paymentReconciliationRequired: false,
        }
      }

      const responseExcerpt =
        typeof data === 'string' ? data.substring(0, 120) : JSON.stringify(data).substring(0, 120)
      const reason = `x402 endpoint returned ${response.status}: ${responseExcerpt}`
      // A 4xx is a rejection, so nothing was settled. A 5xx does not
      // establish whether the request reached settlement, so it stays
      // unknown rather than authorising a second charge.
      paymentAttempt =
        response.status >= 500
          ? markPaymentAttemptUnknown(paymentAttempt, 'http_5xx')
          : failPaymentAttempt(paymentAttempt, 'http_4xx_rejected')
      x402FailureReason = reason
      logger.warn('x402_request_failed_status', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: 'x402',
        reason,
      })
    } catch (err) {
      const reason = summarizeError(err)
      // No response came back. That says nothing about whether the request
      // settled — this is precisely the case that must not pay again.
      paymentAttempt = markPaymentAttemptUnknown(paymentAttempt, 'transport_error')
      x402FailureReason = reason
      logger.warn('x402_flow_failed', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: 'x402',
        reason,
      })
    }

    // Reconcile before deciding anything: an unresolved outcome is not a
    // licence to settle again. The probe only answers whether the earlier
    // settlement completed; without one the attempt stays visibly pending
    // until a later reconciliation pass resolves it.
    if (paymentAttempt.outcome === 'unknown' && typeof context.paymentProbe === 'function') {
      paymentAttempt = await reconcilePaymentAttempt(paymentAttempt, {
        probe: context.paymentProbe,
      })
      logger.info('x402_settlement_reconciled', {
        correlationId: context.correlationId,
        agentId: agent.id,
        attemptId: paymentAttempt.id,
        paymentOutcome: paymentAttempt.outcome,
        failureReason: paymentAttempt.failureReason,
      })
    }

    fallbackPermitted = canAttemptFallback(paymentAttempt)

    if (fallbackPermitted) {
      broadcastFn?.({
        type: 'x402_retry',
        agent: agent.name,
        agentId: agent.id,
        attemptId: paymentAttempt.id,
        paymentOutcome: paymentAttempt.outcome,
        failureReason: paymentAttempt.failureReason,
        reason: x402FailureReason,
        fallback: true,
        timestamp: new Date().toISOString(),
      })
      logger.warn('x402_flow_failed_falling_back', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: 'x402',
        attemptId: paymentAttempt.id,
        failureReason: paymentAttempt.failureReason,
        reason: x402FailureReason,
      })
    } else {
      // The earlier attempt may already have settled. Surface it as an
      // unresolved payment instead of starting a second settlement that
      // would charge one logical call twice.
      broadcastFn?.({
        type: 'x402_settlement_unresolved',
        agent: agent.name,
        agentId: agent.id,
        attemptId: paymentAttempt.id,
        paymentOutcome: paymentAttempt.outcome,
        failureReason: paymentAttempt.failureReason,
        reason: x402FailureReason,
        fallback: false,
        paymentAttempt,
        timestamp: new Date().toISOString(),
      })
      logger.warn('x402_settlement_awaiting_reconciliation', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: 'x402',
        attemptId: paymentAttempt.id,
        failureReason: paymentAttempt.failureReason,
        reason: x402FailureReason,
      })
    }
  }

  const serviceFn = context.serviceMap?.[agent.id] || SERVICE_MAP[agent.id]
  if (context.agentDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, context.agentDelayMs))
  }
  let result
  let capturedUsage = null
  let capturedResponseMeta = null
  try {
    result = await serviceFn(input, {
      onRetryAttempt: (retry) => {
        broadcastFn?.({
          type: 'anthropic_retry',
          agent: agent.name,
          agentId: agent.id,
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          delayMs: retry.delayMs,
          status: retry.status,
          error: retry.error,
          timestamp: new Date().toISOString(),
        })
      },
      // Services may report more than one attempt (e.g. a failed primary
      // model call followed by a successful fallback-model call). Keep the
      // most recent report - the one that actually produced `result`.
      onUsage: (usage) => {
        capturedUsage = usage
      },
      // Same for normalized content metadata (truncation, empty/unsupported
      // content) - only a call that actually produced `result` reports one.
      onResponseMeta: (meta) => {
        capturedResponseMeta = meta
      },
    })
  } catch (err) {
    result = `Error: ${err.message}`
  }

  let paymentResult = { success: false, txHash: null }
  // Direct payment is the fallback settlement, so it only runs when the
  // x402 attempt is a documented terminal failure (or when there was no
  // x402 attempt at all) — never while its outcome is unknown.
  if (fallbackPermitted && config.orchestratorSecret && config.serverAddress) {
    try {
      paymentResult = await sendPayment(
        config.orchestratorSecret,
        config.serverAddress,
        parseFloat(agent.price).toFixed(2),
        `pay:${agent.id}`
      )
    } catch (err) {
      logger.error('xlm_fallback_payment_failed', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: 'stellar-xlm-direct',
        error: err.message,
      })
    }
  }

  const txHash = paymentResult.txHash || null
  // A successful fallback settles the *same* logical charge, so it resolves
  // the original attempt (with its proof) instead of leaving a paid call
  // looking failed in run history.
  if (paymentResult.success) {
    paymentAttempt = confirmPaymentAttempt(paymentAttempt, {
      txHash,
      explorerUrl: paymentResult.explorerUrl || buildExplorerUrl(txHash),
      proof: x402FailureReason
        ? { source: 'stellar-xlm-fallback', settledAfter: paymentAttempt.failureReason }
        : null,
    })
  }

  const paymentReconciliationRequired = paymentAttempt.outcome === 'unknown'
  // Reconciliation can also establish that the x402 charge *did* settle. That
  // is a paid call — the response was simply lost — so it is reported as one
  // instead of being counted as unpaid.
  const reconciledX402Settlement = !paymentResult.success && paymentAttempt.outcome === 'confirmed'
  const settled = paymentResult.success || reconciledX402Settlement
  const settledTxHash = paymentResult.success
    ? txHash
    : reconciledX402Settlement
      ? paymentAttempt.txHash
      : null
  return {
    result,
    paymentMethod: settled ? (paymentResult.success ? 'stellar-xlm' : 'x402') : 'none',
    paymentSuccess: settled,
    paidVia: settled ? (paymentResult.success ? 'stellar-xlm-direct' : 'x402') : 'none',
    txHash: settledTxHash,
    explorerUrl: paymentResult.explorerUrl || buildExplorerUrl(settledTxHash),
    usage: capturedUsage || unavailableUsage(agent.model || null, 'no_usage_captured'),
    responseMeta: capturedResponseMeta,
    paymentAttempt,
    paymentReconciliationRequired,
    warning: paymentReconciliationRequired
      ? 'x402 settlement outcome is unresolved; no fallback settlement was attempted'
      : undefined,
  }
}

/**
 * Normalize and validate a raw planning message response into a usable
 * plan, or throw with a specific `code` explaining why it was rejected.
 *
 * This is the "planning rejects an incomplete JSON result before execution"
 * guardrail (issue #150): a truncated response, a response with no text
 * content, invalid JSON, or JSON missing a `subtasks` array must never reach
 * subtask execution - each is rejected explicitly here rather than being
 * silently accepted (e.g. `{}` parses successfully but has no subtasks).
 */
export function parsePlanResponse(planResponse) {
  const meta = normalizeContent(planResponse)

  if (meta.truncated) {
    const err = new Error(
      `Planning response was truncated at the token limit (stop_reason: ${meta.stopReason})`
    )
    err.code = 'PLAN_TRUNCATED'
    throw err
  }

  if (meta.empty) {
    const err = new Error(
      `Planning response contained no text content (blocks: ${meta.blockTypes.join(', ') || 'none'})`
    )
    err.code = 'PLAN_EMPTY'
    throw err
  }

  const cleanJson = meta.text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()

  let parsed
  try {
    parsed = JSON.parse(cleanJson)
  } catch (parseErr) {
    const err = new Error(`Planning response was not valid JSON: ${parseErr.message}`)
    err.code = 'PLAN_INVALID_JSON'
    throw err
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.subtasks)) {
    const err = new Error('Planning response is missing a valid "subtasks" array')
    err.code = 'PLAN_MISSING_SUBTASKS'
    throw err
  }

  return parsed
}

const PLANNING_MODEL = 'claude-haiku-4-5-20251001'

export async function orchestrate(task, budget, broadcastFn, context = {}) {
  if (context.signal?.aborted) {
    const abortErr = new Error('Orchestration aborted before start')
    abortErr.code = 'REQUEST_ABORTED'
    throw abortErr
  }

  const startTime = Date.now()
  const results = []
  const payments = []
  const usageEntries = []
  // Every payment attempt this run produced, upserted by id so one logical
  // charge keeps one record (#131).
  let paymentAttempts = []
  const exactBudget = AssetAmount.from(budget, 'USDC')
  let totalSpent = AssetAmount.zero('USDC')
  let x402PaymentCount = 0
  let xlmFallbackCount = 0
  let unpaidCount = 0
  let accumulatedContext = ''

  broadcastFn?.({
    type: 'orchestrator_start',
    task,
    budget,
    x402Configured: !!x402Fetch,
    x402InitError,
    x402WalletReady,
    x402WalletHint,
    paymentFlow: x402Fetch ? 'x402-http402' : 'stellar-xlm-fallback',
    timestamp: new Date().toISOString(),
  })

  const agentList = AGENTS.map(
    (a) => `- ${a.id}: ${a.capability} (cost: ${a.price} ${a.currency})`
  ).join('\n')

  let plan
  let planningUsageEntry = null
  if (context.initialDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, context.initialDelayMs))
  }
  if (context.plan) {
    plan = context.plan
    planningUsageEntry = recordUsageEntry('planning', null, null)
  } else {
    try {
      const planResponse = await createAnthropicMessage(
        {
          model: PLANNING_MODEL,
          max_tokens: 400,
          messages: [
            {
              role: 'user',
              content: `You are a task orchestrator for an AI agent marketplace. Break this task into 2-3 subtasks and choose which agents to use.

Available agents:
${agentList}

Task: "${task}"
Budget: ${budget} USDC

IMPORTANT: Only select agents whose total cost fits within the budget of ${budget} USDC.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "plan": "brief description of your approach",
  "subtasks": [
    {"agentId": "agent-id-here", "input": "what to send to the agent", "cost": "0.01"}
  ]
}`,
            },
          ],
        },
        {
          onRetryAttempt: (retry) => {
            broadcastFn?.({
              type: 'anthropic_retry',
              phase: 'planning',
              attempt: retry.attempt,
              maxRetries: retry.maxRetries,
              delayMs: retry.delayMs,
              status: retry.status,
              error: retry.error,
              timestamp: new Date().toISOString(),
            })
          },
        }
      )

      // Capture usage from the successful call before parsing - a rejected
      // plan (truncated, empty, invalid JSON, or missing subtasks) still
      // consumed real provider tokens.
      planningUsageEntry = recordUsageEntry(
        'planning',
        null,
        usageFromMessage(planResponse, PLANNING_MODEL)
      )

      plan = parsePlanResponse(planResponse)

      const validated = validatePlan(plan)
      if (!validated.valid) {
        throw new Error(`plan_validation_failed:${validated.reason}`)
      }
      plan = validated.plan
    } catch (err) {
      logger.warn('orchestrator_planning_fallback', {
        correlationId: context.correlationId,
        code: err.code || null,
        error: err.message?.substring(0, 120),
      })
      // Only record "unavailable" if we didn't already capture real usage
      // above (e.g. the API call itself failed/timed out, vs. the call
      // succeeding but returning unparseable JSON).
      if (!planningUsageEntry) {
        planningUsageEntry = recordUsageEntry(
          'planning',
          null,
          unavailableUsage(PLANNING_MODEL, 'planning_call_failed')
        )
      }
      const subtasks = []
      let remaining = exactBudget

      const researchCost = AssetAmount.from('0.01', 'USDC')
      const summaryCost = AssetAmount.from('0.01', 'USDC')
      const analystCost = AssetAmount.from('0.05', 'USDC')
      const codeCost = AssetAmount.from('0.03', 'USDC')

      if (remaining.isGreaterThanOrEqualTo(researchCost)) {
        subtasks.push({ agentId: 'research-bot', input: task, cost: '0.01' })
        remaining = remaining.minus(researchCost)
      }
      if (remaining.isGreaterThanOrEqualTo(summaryCost)) {
        subtasks.push({
          agentId: 'summary-bot',
          input: `Summarize findings about: ${task}`,
          cost: '0.01',
        })
        remaining = remaining.minus(summaryCost)
      }
      if (remaining.isGreaterThanOrEqualTo(analystCost)) {
        subtasks.push({ agentId: 'analyst-bot', input: task, cost: '0.05' })
        remaining = remaining.minus(analystCost)
      }
      if (remaining.isGreaterThanOrEqualTo(codeCost)) {
        subtasks.push({
          agentId: 'code-bot',
          input: `Write an implementation related to: ${task}`,
          cost: '0.03',
        })
        remaining = remaining.minus(codeCost)
      }

      subtasks.forEach((s, i) => {
        s.stepId = `step-${i}`
      })

      plan = {
        plan: `Multi-agent workflow: ${subtasks.map((s) => s.agentId).join(' -> ')} (${subtasks.length} agents, ${budget} USDC budget)`,
        subtasks,
      }
    }
  }

  usageEntries.push(planningUsageEntry)

  broadcastFn?.({
    type: 'orchestrator_plan',
    plan: plan.plan,
    subtaskCount: plan.subtasks?.length || 0,
    timestamp: new Date().toISOString(),
  })

  for (const subtask of plan.subtasks || []) {
    if (context.signal?.aborted) {
      const abortErr = new Error('Orchestration aborted')
      abortErr.code = 'REQUEST_ABORTED'
      throw abortErr
    }

    const agent = getAgentById(subtask.agentId)
    if (!agent) {
      results.push({ agentId: subtask.agentId, stepId: subtask.stepId, error: 'Agent not found' })
      continue
    }

    const cost = agentCost(agent)

    if (exceedsBudget(totalSpent, cost, exactBudget)) {
      broadcastFn?.({
        ...buildBudgetLimitEvent(agent, exactBudget, totalSpent),
        timestamp: new Date().toISOString(),
      })
      results.push(buildSkipResult(agent, exactBudget, totalSpent))
      continue
    }

    let activeInput = subtask.input
    if (accumulatedContext) {
      if (agent.id === 'summary-bot')
        activeInput = `Summarize the following findings related to "${subtask.input}":\n\n${accumulatedContext.substring(0, 3000)}`
      else if (agent.id === 'analyst-bot')
        activeInput = `Analyze this topic: "${subtask.input}"\n\nContext:\n${accumulatedContext.substring(0, 3000)}`
      else if (agent.id === 'code-bot')
        activeInput = `Action: "${subtask.input}"\n\nContext:\n${accumulatedContext.substring(0, 3000)}`
    }

    broadcastFn?.({
      type: 'agent_call',
      agent: agent.name,
      agentId: agent.id,
      input: activeInput.substring(0, 100) + (activeInput.length > 100 ? '...' : ''),
      cost: agent.price,
      paymentFlow: x402Fetch ? 'x402-http402' : 'stellar-xlm-fallback',
      timestamp: new Date().toISOString(),
    })

    const agentResponse = await callAgentViaX402(agent, activeInput, broadcastFn, context)

    if (agentResponse?.paymentAttempt) {
      paymentAttempts = upsertPaymentAttempt(paymentAttempts, agentResponse.paymentAttempt)
    }

    if (agentResponse?.paymentReconciliationRequired) {
      broadcastFn?.({
        type: 'payment_reconciliation_required',
        agent: agent.name,
        agentId: agent.id,
        attemptId: agentResponse.paymentAttempt.id,
        paymentOutcome: agentResponse.paymentAttempt.outcome,
        failureReason: agentResponse.paymentAttempt.failureReason,
        amount: agent.price,
        currency: agent.currency,
        paymentAttempt: agentResponse.paymentAttempt,
        timestamp: new Date().toISOString(),
      })
    }

    if (agentResponse && agentResponse.result) {
      accumulatedContext =
        typeof agentResponse.result === 'string'
          ? agentResponse.result
          : JSON.stringify(agentResponse.result)
    }
    totalSpent = totalSpent.plus(cost)

    const bucket = paymentBucket(agentResponse.paidVia)
    if (bucket === 'x402') x402PaymentCount += 1
    else if (bucket === 'stellar-xlm') xlmFallbackCount += 1
    else unpaidCount += 1

    // Provider token usage is tracked independently of the settled
    // marketplace charge (agent.price / cost, accumulated into totalSpent
    // above) - it never alters or substitutes for that settled amount.
    const stepUsageEntry = recordUsageEntry('agent', agent.id, agentResponse.usage)
    usageEntries.push(stepUsageEntry)

    // Surface truncation/empty-content explicitly rather than letting a
    // cut-off or blank agent output pass silently as a normal result.
    if (agentResponse.responseMeta?.truncated || agentResponse.responseMeta?.empty) {
      broadcastFn?.({
        type: 'agent_response_incomplete',
        agent: agent.name,
        agentId: agent.id,
        truncated: !!agentResponse.responseMeta.truncated,
        empty: !!agentResponse.responseMeta.empty,
        stopReason: agentResponse.responseMeta.stopReason,
        timestamp: new Date().toISOString(),
      })
    }

    const agentResult = {
      agentId: agent.id,
      stepId: subtask.stepId,
      agentName: agent.name,
      model: agent.model,
      input: subtask.input,
      output: agentResponse.result,
      cost: agent.price,
      currency: agent.currency,
      paidVia: agentResponse.paidVia,
      paymentSuccess: agentResponse.paymentSuccess,
      txHash: agentResponse.txHash || null,
      explorerUrl: agentResponse.explorerUrl || null,
      usage: stepUsageEntry,
      // Content-block normalization metadata (issue #150) - null for x402
      // remote calls, where no raw Anthropic response exists to normalize.
      responseMeta: agentResponse.responseMeta || null,
      // The persisted attempt for this step (#131) — an `unknown` outcome
      // stays visible here as a pending charge, never as a settled one.
      paymentAttempt: agentResponse.paymentAttempt || null,
      paymentReconciliationRequired: !!agentResponse.paymentReconciliationRequired,
    }

    results.push(agentResult)
    payments.push(agentResponse)

    broadcastFn?.({
      type: 'agent_response',
      agent: agent.name,
      agentId: agent.id,
      resultPreview:
        typeof agentResponse.result === 'string' ? agentResponse.result.substring(0, 150) : '',
      cost: agent.price,
      paidVia: agentResponse.paidVia,
      txHash: agentResponse.txHash || null,
      explorerUrl: agentResponse.explorerUrl || null,
      // The step's payment attempt, persisted by the route as soon as it
      // is observed so it survives a crash before completeRun (#131).
      paymentAttempt: agentResponse.paymentAttempt || null,
      timestamp: new Date().toISOString(),
    })

    if (agentResponse.paymentSuccess) {
      logger.info('payment_settled', {
        correlationId: context.correlationId,
        agentId: agent.id,
        paymentMethod: agentResponse.paidVia,
        txHash: agentResponse.txHash || null,
      })
      broadcastFn?.({
        type: 'payment',
        from: 'Orchestrator',
        to: agent.name,
        amount: agent.price,
        currency: agent.currency,
        method: agentResponse.paidVia,
        txHash: agentResponse.txHash,
        explorerUrl: agentResponse.explorerUrl,
        timestamp: new Date().toISOString(),
      })
    }
  }

  const elapsed = Date.now() - startTime
  const budgetExhausted = isBudgetExhausted(totalSpent, exactBudget)
  const paymentProtocol = paymentProtocolSummary(x402PaymentCount, xlmFallbackCount)
  const successfulPayments = payments.filter((p) => p.paymentSuccess)
  const successfulTxs = successfulPayments.filter((p) => p.txHash)
  const paymentAttemptSummary = summarizePaymentAttempts(paymentAttempts)
  const pendingPaymentCount = paymentAttempts.filter(
    (attempt) => attempt.outcome === 'unknown' || attempt.outcome === 'pending'
  ).length
  // Provider token usage, aggregated separately from the settled marketplace
  // totals above (totalSpent / paymentProtocol / etc. are untouched by this).
  const usageSummary = summarizeUsageByPhase(usageEntries)

  broadcastFn?.({
    type: 'orchestrator_complete',
    totalSpent: formatAmount(totalSpent),
    totalSpentExact: totalSpent.toJSON(),
    agentsUsed: countUsed(results),
    agentsSkipped: countSkipped(results),
    elapsed: `${elapsed}ms`,
    budgetExhausted,
    paymentProtocol,
    x402PaymentCount,
    xlmFallbackCount,
    unpaidCount,
    x402WalletReady,
    x402WalletHint,
    usageSummary,
    paymentAttemptSummary,
    pendingPaymentCount,
    timestamp: new Date().toISOString(),
  })

  return {
    task,
    plan: plan.plan,
    budget: typeof budget === 'number' ? budget : exactBudget.toNumber(),
    budgetExact: exactBudget.toJSON(),
    totalSpent: formatAmount(totalSpent),
    totalSpentExact: totalSpent.toJSON(),
    budgetExhausted,
    agentsUsed: countUsed(results),
    agentsSkipped: countSkipped(results),
    paymentProtocol,
    x402PaymentCount,
    xlmFallbackCount,
    unpaidCount,
    x402Configured: !!x402Fetch,
    x402WalletReady,
    x402WalletHint,
    results,
    payments: successfulPayments,
    txCount: successfulTxs.length,
    elapsed: `${elapsed}ms`,
    // Provider token usage - kept as its own namespace, never merged into
    // or masquerading as the settled marketplace charges above.
    usage: {
      entries: usageEntries,
      summary: usageSummary,
    },
    // Payment attempts, so run history can persist them and a later
    // reconciliation pass can resolve the unknown ones (#131).
    paymentAttempts,
    paymentAttemptSummary,
    pendingPaymentCount,
  }
}
