/**
 * Budget guardrails & payment-outcome accounting for the orchestrator.
 *
 * This module is intentionally dependency-free (no SDK, network, or config
 * imports) so the guardrail logic can be unit-tested deterministically in
 * isolation — mirroring the `settlement-header.js` pattern. `orchestrator.js`
 * imports these helpers so the tests guard the *real* code path rather than a
 * re-implementation.
 *
 * All monetary values are USDC. Costs are derived from `agent.price` (a string
 * in the registry), matching the orchestrator's historical behavior.
 */

/**
 * Resolve an agent's per-call cost as a number.
 * Returns NaN for malformed prices (preserving `parseFloat` semantics).
 * @param {{ price?: string }} agent
 * @returns {number}
 */
export function agentCost(agent) {
  return parseFloat(agent?.price)
}

/**
 * Remaining budget headroom (may be negative if already overspent).
 * @param {number} budget
 * @param {number} totalSpent
 * @returns {number}
 */
export function remainingBudget(budget, totalSpent) {
  return budget - totalSpent
}

/**
 * Format a USDC amount for display/reporting (4 decimal places).
 * @param {number} value
 * @returns {string}
 */
export function formatAmount(value) {
  return Number(value).toFixed(4)
}

/**
 * Core guardrail predicate: would running this step push spend over budget?
 * Strict greater-than means a step whose cost exactly consumes the remaining
 * budget is still allowed to run.
 * @param {number} totalSpent
 * @param {number} cost
 * @param {number} budget
 * @returns {boolean}
 */
export function exceedsBudget(totalSpent, cost, budget) {
  return totalSpent + cost > budget
}

/**
 * Build the skipped-step record pushed onto `results` when a step is denied
 * by the budget guardrail.
 * @param {{ id: string, price: string }} agent
 * @param {number} budget
 * @param {number} totalSpent
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
 * @param {number} budget
 * @param {number} totalSpent
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
 * @param {number} totalSpent
 * @param {number} budget
 * @returns {boolean}
 */
export function isBudgetExhausted(totalSpent, budget) {
  return totalSpent >= budget
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
