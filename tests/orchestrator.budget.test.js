/**
 * Focused unit tests for orchestrator budget guardrails.
 *
 * Covers (per acceptance criteria):
 *  - `totalSpent + cost > budget` skip behavior (incl. the strict-inequality boundary)
 *  - mixed payment outcomes and fallback modes
 *  - final summary totals and skipped-step reporting
 *  - edge cases: tiny budgets, zero budget, parse failures (NaN)
 *
 * These import the SAME functions `orchestrator.js` uses, so a regression in the
 * real guardrail fails this suite. Dependency-free → deterministic and fast.
 *
 * Run: node tests/orchestrator.budget.test.js
 */

import assert from 'node:assert'
import {
  agentCost,
  remainingBudget,
  formatAmount,
  exceedsBudget,
  buildSkipResult,
  buildBudgetLimitEvent,
  paymentBucket,
  tallyPaymentOutcomes,
  paymentProtocolSummary,
  isBudgetExhausted,
  countUsed,
  countSkipped,
} from '../src/agents/budget.js'

// ─── Tiny test harness (collect-all, fail-fast exit) ─────────────
const failures = []
let passed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

// Registry-accurate fixtures (prices mirror src/agents/registry.js)
const research = { id: 'research-bot', name: '🔬 Research Agent', price: '0.01' }
const summary = { id: 'summary-bot', name: '📝 Summary Agent', price: '0.01' }
const analyst = { id: 'analyst-bot', name: '📊 Analysis Agent', price: '0.05' }
const code = { id: 'code-bot', name: '💻 Code Agent', price: '0.03' }

// ─── agentCost / parse failures ──────────────────────────────────
console.log('agentCost')
test('parses a well-formed price string', () => {
  assert.strictEqual(agentCost(analyst), 0.05)
  assert.strictEqual(agentCost(code), 0.03)
})
test('returns NaN for a malformed price (parse failure)', () => {
  assert.ok(Number.isNaN(agentCost({ price: 'abc' })))
  assert.ok(Number.isNaN(agentCost({ price: undefined })))
  assert.ok(Number.isNaN(agentCost({})))
})

// ─── exceedsBudget: core skip behavior ───────────────────────────
console.log('exceedsBudget (totalSpent + cost > budget)')
test('allows a step that fits under budget', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0.1), false)
})
test('allows a step whose cost exactly consumes remaining budget (strict >)', () => {
  // 0 + 0.05 > 0.05  →  false  → must NOT skip. Guards against `>` becoming `>=`.
  assert.strictEqual(exceedsBudget(0, 0.05, 0.05), false)
  assert.strictEqual(exceedsBudget(0.04, 0.01, 0.05), false)
})
test('skips a step that would overshoot by any amount', () => {
  assert.strictEqual(exceedsBudget(0, 0.05, 0.04), true)
  assert.strictEqual(exceedsBudget(0.05, 0.01, 0.05), true)
})
test('skips on accumulated spend even when each step is individually cheap', () => {
  // research(0.01)+summary(0.01)=0.02 spent; analyst(0.05) would hit 0.07 > 0.06
  assert.strictEqual(exceedsBudget(0.02, 0.05, 0.06), true)
})

// ─── Edge cases: zero & tiny budgets ─────────────────────────────
console.log('exceedsBudget edge cases (zero / tiny budgets)')
test('zero budget skips any non-zero-cost step', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0), true)
})
test('zero budget allows a zero-cost step', () => {
  assert.strictEqual(exceedsBudget(0, 0, 0), false)
})
test('tiny budget below the cheapest agent skips it', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0.005), true)
})
test('tiny budget exactly equal to cost allows the step', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0.01), false)
})
test('NaN cost (parse failure) does not skip — comparison is false', () => {
  // NaN > budget is always false, so a malformed price falls through the guard.
  // Pinned so this real behavior changes deliberately, not by accident.
  assert.strictEqual(exceedsBudget(0, NaN, 0.05), false)
})
test('NaN budget does not skip — comparison is false', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, NaN), false)
})
test('documents floating-point behavior at the 0.1 boundary', () => {
  // 0.07 + 0.03 === 0.09999999999999999 in IEEE-754, which is NOT > 0.1.
  assert.strictEqual(0.07 + 0.03 > 0.1, false)
  assert.strictEqual(exceedsBudget(0.07, 0.03, 0.1), false)
  // ...but it IS > 0.09, so a 0.09 budget correctly skips the step.
  assert.strictEqual(exceedsBudget(0.07, 0.03, 0.09), true)
})

// ─── remainingBudget / formatAmount ──────────────────────────────
console.log('remainingBudget / formatAmount')
test('remainingBudget can go negative when overspent', () => {
  // Raw subtraction carries IEEE-754 noise (0.05 - 0.03 = 0.0200000000…4),
  // which is exactly why production only ever surfaces it via formatAmount.
  assert.strictEqual(formatAmount(remainingBudget(0.05, 0.03)), '0.0200')
  assert.strictEqual(formatAmount(remainingBudget(0.05, 0.06)), '-0.0100')
  assert.strictEqual(remainingBudget(0.05, 0.06) < 0, true)
})
test('formatAmount always renders 4 decimal places', () => {
  assert.strictEqual(formatAmount(0.01), '0.0100')
  assert.strictEqual(formatAmount(0), '0.0000')
  assert.strictEqual(formatAmount(-0.01), '-0.0100')
})

// ─── buildSkipResult: skipped-step reporting ─────────────────────
console.log('buildSkipResult (skipped-step record)')
test('produces a skipped record with agentId and reason', () => {
  const r = buildSkipResult(analyst, 0.04, 0.0)
  assert.deepStrictEqual(r, {
    agentId: 'analyst-bot',
    skipped: true,
    reason: 'Budget limit (0.0400 USDC remaining, need 0.05)',
  })
})
test('reason reflects remaining headroom after prior spend', () => {
  const r = buildSkipResult(analyst, 0.06, 0.04)
  assert.strictEqual(r.reason, 'Budget limit (0.0200 USDC remaining, need 0.05)')
})

// ─── buildBudgetLimitEvent: broadcast payload ────────────────────
console.log('buildBudgetLimitEvent (broadcast payload, no timestamp)')
test('builds a budget_limit event without a timestamp', () => {
  const ev = buildBudgetLimitEvent(analyst, 0.04, 0.0)
  assert.deepStrictEqual(ev, {
    type: 'budget_limit',
    agent: '📊 Analysis Agent',
    cost: '0.05',
    remaining: '0.0400',
  })
  // Timestamp is added by the orchestrator so the pure payload stays deterministic.
  assert.strictEqual('timestamp' in ev, false)
})

// ─── paymentBucket: payment outcomes & fallback modes ────────────
console.log('paymentBucket (payment outcomes / fallback modes)')
test('classifies a confirmed x402 payment', () => {
  assert.strictEqual(paymentBucket('x402'), 'x402')
})
test('classifies the direct-XLM fallback', () => {
  assert.strictEqual(paymentBucket('stellar-xlm-direct'), 'stellar-xlm')
})
test('classifies unpaid / unknown / missing outcomes as unpaid', () => {
  assert.strictEqual(paymentBucket('none'), 'unpaid')
  assert.strictEqual(paymentBucket(undefined), 'unpaid')
  assert.strictEqual(paymentBucket(null), 'unpaid')
  assert.strictEqual(paymentBucket(''), 'unpaid')
  assert.strictEqual(paymentBucket('something-else'), 'unpaid')
})

// ─── tallyPaymentOutcomes ────────────────────────────────────────
console.log('tallyPaymentOutcomes')
test('tallies a mixed run correctly', () => {
  const counts = tallyPaymentOutcomes(['x402', 'stellar-xlm-direct', 'none', 'x402', undefined])
  assert.deepStrictEqual(counts, { x402PaymentCount: 2, xlmFallbackCount: 1, unpaidCount: 2 })
})
test('empty / missing input yields all zeros', () => {
  assert.deepStrictEqual(tallyPaymentOutcomes([]), {
    x402PaymentCount: 0,
    xlmFallbackCount: 0,
    unpaidCount: 0,
  })
  assert.deepStrictEqual(tallyPaymentOutcomes(undefined), {
    x402PaymentCount: 0,
    xlmFallbackCount: 0,
    unpaidCount: 0,
  })
})

// ─── paymentProtocolSummary ──────────────────────────────────────
console.log('paymentProtocolSummary')
test('reports x402-only, xlm-only, mixed, and none', () => {
  assert.strictEqual(paymentProtocolSummary(2, 0), 'x402')
  assert.strictEqual(paymentProtocolSummary(0, 3), 'stellar-xlm')
  assert.strictEqual(paymentProtocolSummary(1, 1), 'mixed')
  assert.strictEqual(paymentProtocolSummary(0, 0), 'none')
})

// ─── isBudgetExhausted: summary flag ─────────────────────────────
console.log('isBudgetExhausted')
test('true only when spend meets or exceeds budget', () => {
  assert.strictEqual(isBudgetExhausted(0.04, 0.05), false)
  assert.strictEqual(isBudgetExhausted(0.05, 0.05), true)
  assert.strictEqual(isBudgetExhausted(0.06, 0.05), true)
})
test('zero budget is considered exhausted from the start', () => {
  assert.strictEqual(isBudgetExhausted(0, 0), true)
})

// ─── countUsed / countSkipped: summary totals ────────────────────
console.log('countUsed / countSkipped (summary totals)')
test('counts used vs skipped across a mixed results array', () => {
  const results = [
    { agentId: 'research-bot', skipped: undefined }, // ran
    { agentId: 'analyst-bot', skipped: true }, // skipped
    { agentId: 'code-bot' }, // ran
  ]
  assert.strictEqual(countUsed(results), 2)
  assert.strictEqual(countSkipped(results), 1)
})
test('an "agent not found" error entry counts as used (pins current behavior)', () => {
  // orchestrator pushes { agentId, error } with no `skipped` flag; today that
  // entry is counted among agentsUsed. Documented here so a fix is intentional.
  const results = [{ agentId: 'ghost-bot', error: 'Agent not found' }]
  assert.strictEqual(countUsed(results), 1)
  assert.strictEqual(countSkipped(results), 0)
})
test('empty results yield zero used and zero skipped', () => {
  assert.strictEqual(countUsed([]), 0)
  assert.strictEqual(countSkipped([]), 0)
})

// ─── Integration: deterministic end-to-end budget run ────────────
// Mirrors orchestrate()'s loop using the exported helpers to prove the pieces
// compose into correct overrun prevention + summary, without any SDK/network.
console.log('integration: simulated budget run')
function simulateRun(agents, budget, paidViaFor = () => 'x402') {
  const results = []
  let totalSpent = 0
  const paidViaList = []
  for (const agent of agents) {
    const cost = agentCost(agent)
    if (exceedsBudget(totalSpent, cost, budget)) {
      results.push(buildSkipResult(agent, budget, totalSpent))
      continue
    }
    totalSpent += cost
    const paidVia = paidViaFor(agent)
    paidViaList.push(paidVia)
    results.push({ agentId: agent.id, skipped: false, paidVia })
  }
  const { x402PaymentCount, xlmFallbackCount, unpaidCount } = tallyPaymentOutcomes(paidViaList)
  return {
    totalSpent: formatAmount(totalSpent),
    budgetExhausted: isBudgetExhausted(totalSpent, budget),
    agentsUsed: countUsed(results),
    agentsSkipped: countSkipped(results),
    paymentProtocol: paymentProtocolSummary(x402PaymentCount, xlmFallbackCount),
    x402PaymentCount,
    xlmFallbackCount,
    unpaidCount,
    results,
  }
}

test('a generous budget runs every step and never overspends', () => {
  const out = simulateRun([research, summary, analyst, code], 1.0)
  assert.strictEqual(out.agentsUsed, 4)
  assert.strictEqual(out.agentsSkipped, 0)
  assert.strictEqual(out.totalSpent, '0.1000')
  assert.strictEqual(out.budgetExhausted, false)
})

test('a low budget runs the affordable steps and skips the rest (overrun prevention)', () => {
  // budget 0.02: research(0.01) ✓, summary(0.01) ✓ → 0.02 spent;
  // analyst(0.05) skip, code(0.03) skip. totalSpent never exceeds budget.
  const out = simulateRun([research, summary, analyst, code], 0.02)
  assert.strictEqual(out.agentsUsed, 2)
  assert.strictEqual(out.agentsSkipped, 2)
  assert.strictEqual(out.totalSpent, '0.0200')
  assert.strictEqual(out.budgetExhausted, true)
  assert.strictEqual(parseFloat(out.totalSpent) <= 0.02, true)
  const skipped = out.results.filter((r) => r.skipped).map((r) => r.agentId)
  assert.deepStrictEqual(skipped, ['analyst-bot', 'code-bot'])
})

test('zero budget skips everything and spends nothing', () => {
  const out = simulateRun([research, summary, analyst, code], 0)
  assert.strictEqual(out.agentsUsed, 0)
  assert.strictEqual(out.agentsSkipped, 4)
  assert.strictEqual(out.totalSpent, '0.0000')
  assert.strictEqual(out.paymentProtocol, 'none')
})

test('mixed payment outcomes produce a mixed protocol summary', () => {
  const paidViaFor = (a) => (a.id === 'analyst-bot' ? 'stellar-xlm-direct' : 'x402')
  const out = simulateRun([research, summary, analyst, code], 1.0, paidViaFor)
  assert.strictEqual(out.x402PaymentCount, 3)
  assert.strictEqual(out.xlmFallbackCount, 1)
  assert.strictEqual(out.unpaidCount, 0)
  assert.strictEqual(out.paymentProtocol, 'mixed')
})

// ─── Report ──────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
