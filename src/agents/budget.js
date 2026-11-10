/**
 * Budget guardrails & payment-outcome accounting for the orchestrator.
 *
 * This module is intentionally dependency-free (no SDK, network, or config
 * imports) so the guardrail logic can be unit-tested deterministically in
 * isolation — mirroring the `settlement-header.js` pattern. `orchestrator.js`
 * imports these helpers so the tests guard the *real* code path rather than a
 * re-implementation.
 *
 * Uses exact integer base units (AssetAmount) with explicit per-asset precision
 * for all monetary comparisons, headroom, and totals, avoiding IEEE-754
 * floating-point inaccuracies.
 *
 * All default monetary values are USDC (precision 7, Stellar base units).
 * Costs are derived from `agent.price` (a string in the registry).
 */

import {
  AssetAmount,
  ASSET_PRECISION,
  DEFAULT_ASSET,
  UnsupportedPrecisionError,
  InvalidAmountError,
  AssetMismatchError,
  getAssetPrecision,
  registerAsset,
  resetCustomAssets,
} from './amount.js'

export {
  AssetAmount,
  ASSET_PRECISION,
  DEFAULT_ASSET,
  UnsupportedPrecisionError,
  InvalidAmountError,
  AssetMismatchError,
  getAssetPrecision,
  registerAsset,
  resetCustomAssets,
}

/**
 * Resolve an agent's per-call cost as an exact AssetAmount.
 * Returns NaN for malformed prices (preserving legacy guardrail failure behavior).
 * @param {{ price?: string, currency?: string }} agent
 * @returns {AssetAmount|number}
 */
export function agentCost(agent) {
  if (
    !agent ||
    typeof agent !== 'object' ||
    agent.price === undefined ||
    agent.price === null ||
    agent.price === ''
  ) {
    return NaN
  }
  try {
    return AssetAmount.from(agent.price, agent.currency || DEFAULT_ASSET)
  } catch {
    return NaN
  }
}

/**
 * Remaining budget headroom as an AssetAmount (may be negative if already overspent).
 * Returns NaN if budget or totalSpent is NaN / unparseable.
 * @param {AssetAmount|number|string} budget
 * @param {AssetAmount|number|string} totalSpent
 * @returns {AssetAmount|number}
 */
export function remainingBudget(budget, totalSpent) {
  if (
    (typeof budget === 'number' && Number.isNaN(budget)) ||
    (typeof totalSpent === 'number' && Number.isNaN(totalSpent)) ||
    budget === undefined ||
    budget === null ||
    totalSpent === undefined ||
    totalSpent === null
  ) {
    return NaN
  }
  try {
    const b = AssetAmount.from(budget)
    const s = AssetAmount.from(totalSpent)
    return b.minus(s)
  } catch {
    return NaN
  }
}

/**
 * Format a USDC amount for display/reporting (4 decimal places by default).
 * Accepts AssetAmount, number, string, or base units bigint.
 * @param {AssetAmount|number|string|bigint} value
 * @param {number} [decimals=4]
 * @returns {string}
 */
export function formatAmount(value, decimals = 4) {
  if (value instanceof AssetAmount) {
    return value.toDecimalString(decimals)
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN'
    return value.toFixed(decimals)
  }
  if (typeof value === 'bigint') {
    return AssetAmount.fromBaseUnits(value).toDecimalString(decimals)
  }
  if (typeof value === 'string') {
    try {
      return AssetAmount.from(value).toDecimalString(decimals)
    } catch {
      return Number(value).toFixed(decimals)
    }
  }
  return Number(value).toFixed(decimals)
}

/**
 * Core guardrail predicate: would running this step push spend over budget?
 * Strict greater-than means a step whose cost exactly consumes the remaining
 * budget is still allowed to run.
 * Uses exact integer base units for calculation.
 * @param {AssetAmount|number|string} totalSpent
 * @param {AssetAmount|number|string} cost
 * @param {AssetAmount|number|string} budget
 * @returns {boolean}
 */
export function exceedsBudget(totalSpent, cost, budget) {
  if (
    (typeof cost === 'number' && Number.isNaN(cost)) ||
    (typeof budget === 'number' && Number.isNaN(budget)) ||
    (typeof totalSpent === 'number' && Number.isNaN(totalSpent)) ||
    cost === undefined ||
    cost === null ||
    budget === undefined ||
    budget === null ||
    totalSpent === undefined ||
    totalSpent === null
  ) {
    return false
  }
  try {
    const spentAmount = AssetAmount.from(totalSpent)
    const costAmount = AssetAmount.from(cost)
    const budgetAmount = AssetAmount.from(budget)
    return spentAmount.plus(costAmount).isGreaterThan(budgetAmount)
  } catch {
    return false
  }
}

/**
 * Build the skipped-step record pushed onto `results` when a step is denied
 * by the budget guardrail.
 * @param {{ id: string, price: string }} agent
 * @param {AssetAmount|number|string} budget
 * @param {AssetAmount|number|string} totalSpent
 * @returns {{ agentId: string, skipped: true, reason: string }}
 */
export function buildSkipResult(agent, budget, totalSpent) {
  return {
    agentId: agent.id,
    skipped: true,
    reason: `Budget limit (${formatAmount(remainingBudget(budget, totalSpent))} USDC remaining, need ${agent.price})`,
  }
}

/**
 * Build the `budget_limit` broadcast event payload (without a timestamp; the
 * caller is responsible for stamping it so this stays deterministic).
 * @param {{ name: string, price: string }} agent
 * @param {AssetAmount|number|string} budget
 * @param {AssetAmount|number|string} totalSpent
 * @returns {{ type: 'budget_limit', agent: string, cost: string, remaining: string }}
 */
export function buildBudgetLimitEvent(agent, budget, totalSpent) {
  return {
    type: 'budget_limit',
    agent: agent.name,
    cost: agent.price,
    remaining: formatAmount(remainingBudget(budget, totalSpent)),
  }
}

/**
 * Classify a single step's payment outcome into an accounting bucket.
 * Anything that is not a confirmed x402 or direct-XLM payment counts as unpaid.
 * @param {string|undefined|null} paidVia
 * @returns {'x402' | 'stellar-xlm' | 'unpaid'}
 */
export function paymentBucket(paidVia) {
  if (paidVia === 'x402') return 'x402'
  if (paidVia === 'stellar-xlm-direct') return 'stellar-xlm'
  return 'unpaid'
}

/**
 * Tally a list of `paidVia` values into the three counters the orchestrator
 * reports. Empty input yields all zeros.
 * @param {Array<string|undefined|null>} paidViaList
 * @returns {{ x402PaymentCount: number, xlmFallbackCount: number, unpaidCount: number }}
 */
export function tallyPaymentOutcomes(paidViaList) {
  const counts = { x402PaymentCount: 0, xlmFallbackCount: 0, unpaidCount: 0 }
  for (const paidVia of paidViaList || []) {
    const bucket = paymentBucket(paidVia)
    if (bucket === 'x402') counts.x402PaymentCount += 1
    else if (bucket === 'stellar-xlm') counts.xlmFallbackCount += 1
    else counts.unpaidCount += 1
  }
  return counts
}

/**
 * Summarize the dominant payment protocol used across a run.
 * @param {number} x402Count
 * @param {number} xlmFallbackCount
 * @returns {'x402' | 'stellar-xlm' | 'mixed' | 'none'}
 */
export function paymentProtocolSummary(x402Count, xlmFallbackCount) {
  if (x402Count > 0 && xlmFallbackCount === 0) return 'x402'
  if (x402Count === 0 && xlmFallbackCount > 0) return 'stellar-xlm'
  if (x402Count > 0 && xlmFallbackCount > 0) return 'mixed'
  return 'none'
}

/**
 * Whether the budget has been fully consumed (used for the final summary).
 * Uses exact integer base units for comparison.
 * @param {AssetAmount|number|string} totalSpent
 * @param {AssetAmount|number|string} budget
 * @returns {boolean}
 */
export function isBudgetExhausted(totalSpent, budget) {
  if (
    (typeof budget === 'number' && Number.isNaN(budget)) ||
    (typeof totalSpent === 'number' && Number.isNaN(totalSpent)) ||
    budget === undefined ||
    budget === null ||
    totalSpent === undefined ||
    totalSpent === null
  ) {
    return false
  }
  try {
    const spentAmount = AssetAmount.from(totalSpent)
    const budgetAmount = AssetAmount.from(budget)
    return spentAmount.isGreaterThanOrEqualTo(budgetAmount)
  } catch {
    return false
  }
}

/**
 * Count steps that actually ran (everything not explicitly skipped).
 * NOTE: this intentionally counts "agent not found" error entries as used,
 * preserving the orchestrator's existing behavior — see the test that pins it.
 * @param {Array<{ skipped?: boolean }>} results
 * @returns {number}
 */
export function countUsed(results) {
  return results.filter((r) => !r.skipped).length
}

/**
 * Count steps skipped by the budget guardrail.
 * @param {Array<{ skipped?: boolean }>} results
 * @returns {number}
 */
export function countSkipped(results) {
  return results.filter((r) => r.skipped).length
}

export const STEP_EXECUTION_STATUSES = ['succeeded', 'failed', 'skipped']
export const STEP_PAYMENT_STATUSES = ['settled', 'unpaid', 'pending_reconciliation', 'failed']
export const RUN_OUTCOMES = ['completed', 'partial', 'failed']

/**
 * Determine whether a raw output string or step record represents a failed execution.
 * @param {{ skipped?: boolean, executionStatus?: string, error?: any, executionError?: any, output?: any, result?: any }} step
 * @returns {{ executionStatus: 'succeeded' | 'failed' | 'skipped', executionError: string | null }}
 */
export function classifyStepExecution(step = {}) {
  if (step.skipped || step.executionStatus === 'skipped') {
    return { executionStatus: 'skipped', executionError: null }
  }

  const explicitErr = step.executionError ?? step.error
  if (explicitErr) {
    const msg =
      typeof explicitErr === 'string'
        ? explicitErr
        : explicitErr?.message || 'Step execution failed'
    return { executionStatus: 'failed', executionError: msg }
  }

  const candidateText = step.output !== undefined ? step.output : step.result
  if (typeof candidateText === 'string' && /^Error:/i.test(candidateText.trim())) {
    const msg = candidateText.trim().replace(/^Error:\s*/i, '') || 'Step execution failed'
    return { executionStatus: 'failed', executionError: msg }
  }

  if (
    candidateText &&
    typeof candidateText === 'object' &&
    !Array.isArray(candidateText) &&
    typeof candidateText.error === 'string' &&
    candidateText.error.trim().length > 0
  ) {
    return { executionStatus: 'failed', executionError: candidateText.error.trim() }
  }

  if (step.executionStatus === 'failed') {
    return { executionStatus: 'failed', executionError: 'Step execution failed' }
  }

  return { executionStatus: 'succeeded', executionError: null }
}

/**
 * Classify a step's payment status independently of its execution status (Issue #134).
 * A step whose payment already settled before/during an execution failure still
 * reports `paymentStatus: 'settled'`.
 *
 * @param {Object} step
 * @returns {'settled' | 'unpaid' | 'pending_reconciliation' | 'failed'}
 */
export function classifyStepPayment(step = {}) {
  if (step.paymentStatus && STEP_PAYMENT_STATUSES.includes(step.paymentStatus)) {
    return step.paymentStatus
  }
  if (step.skipped || step.executionStatus === 'skipped') {
    return 'unpaid'
  }
  if (
    step.paymentSuccess ||
    step.settlement?.success ||
    step.paymentAttempt?.outcome === 'confirmed'
  ) {
    return 'settled'
  }
  if (step.paymentReconciliationRequired || step.paymentAttempt?.outcome === 'unknown') {
    return 'pending_reconciliation'
  }
  if (step.paymentAttempt?.outcome === 'failed') {
    return 'failed'
  }
  return 'unpaid'
}

/**
 * Derive a structured run outcome ('completed' | 'partial' | 'failed') and step
 * status counts from the step results array (Issue #134).
 *
 * @param {Array<Object>} [results=[]]
 * @returns {{
 *   outcome: 'completed' | 'partial' | 'failed',
 *   succeededCount: number,
 *   failedCount: number,
 *   skippedCount: number,
 *   totalSteps: number
 * }}
 */
export function summarizeRunOutcomes(results = []) {
  const list = Array.isArray(results) ? results : []
  let succeededCount = 0
  let failedCount = 0
  let skippedCount = 0

  for (const step of list) {
    const { executionStatus } = classifyStepExecution(step)
    if (executionStatus === 'succeeded') succeededCount += 1
    else if (executionStatus === 'skipped') skippedCount += 1
    else failedCount += 1
  }

  let outcome
  if (list.length === 0 || succeededCount === 0) {
    outcome = 'failed'
  } else if (failedCount === 0 && skippedCount === 0) {
    outcome = 'completed'
  } else {
    outcome = 'partial'
  }

  return {
    outcome,
    succeededCount,
    failedCount,
    skippedCount,
    totalSteps: list.length,
  }
}
