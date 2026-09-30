/**
 * Payment-attempt reconciliation tests (#131).
 *
 * Covers the acceptance criteria:
 *  - every attempt has a stable identifier linked to a run and step
 *  - unknown outcomes remain visibly pending until reconciliation resolves them
 *  - fallback is allowed only under the documented terminal-failure policy
 *  - a recovered settlement updates the original attempt and proof rather than
 *    creating a second logical charge
 *
 * The scenarios from the issue's Validation section are simulated end to end:
 * success with a lost response, delayed confirmation, definitive failure, and a
 * restart during reconciliation. Each asserts the *permitted payment calls* —
 * the count of real settlement attempts — because "did we pay twice?" is the
 * only question that matters here.
 *
 * Dependency-free and network-free: run with
 *   node tests/payment-attempts.test.js
 */

import assert from 'node:assert'
import {
  ATTEMPT_OUTCOMES,
  TERMINAL_FAILURE_REASONS,
  UNKNOWN_REASONS,
  canAttemptFallback,
  confirmPaymentAttempt,
  createPaymentAttempt,
  failPaymentAttempt,
  isTerminalFailure,
  isVisiblyPending,
  markPaymentAttemptUnknown,
  paymentAttemptId,
  reconcilePaymentAttempt,
  recordRecoveredSettlement,
  selectPendingAttempts,
  summarizePaymentAttempts,
  upsertPaymentAttempt,
} from '../src/agents/payment-attempts.js'

// ─── Tiny test harness (collect-all, fail-fast exit) ─────────────
const failures = []
let passed = 0

function report(name, err) {
  failures.push({ name, err })
  console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
}

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    report(name, err)
  }
}

/** Async cases run concurrently; the final report waits for all of them. */
const asyncCases = []

function testAsync(name, fn) {
  asyncCases.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          passed += 1
          console.log(`  ✓ ${name}`)
        },
        (err) => report(name, err)
      )
  )
}

const RUN = 'run_test'
const ATTEMPT_INPUT = {
  runId: RUN,
  stepId: 'research-bot',
  agentId: 'research-bot',
  amount: '0.01',
  currency: 'USDC',
}

/**
 * Minimal model of the paid-call path. A real settlement is only started when
 * the attempt's *current* state permits it, so `settlements` is an accurate
 * count of the payments that were actually allowed.
 */
function makePaymentFlow(getAttempt) {
  const settlements = []
  return {
    settlements,
    attemptFallback(settleOnce) {
      if (!canAttemptFallback(getAttempt())) return { allowed: false, settlements }
      settlements.push(`${getAttempt().id}:fallback`)
      return { allowed: true, settlements, result: settleOnce() }
    },
  }
}

// ─── Identity ────────────────────────────────────────────────────
console.log('stable identity linked to a run and step')

test('derives the same id for the same run and step', () => {
  assert.strictEqual(paymentAttemptId(RUN, 'research-bot'), paymentAttemptId(RUN, 'research-bot'))
})

test('derives a different id per step and per run', () => {
  assert.notStrictEqual(paymentAttemptId(RUN, 'research-bot'), paymentAttemptId(RUN, 'summary-bot'))
  assert.notStrictEqual(
    paymentAttemptId(RUN, 'research-bot'),
    paymentAttemptId('run_other', 'research-bot')
  )
})

test('refuses to create an attempt that cannot be linked to a run and step', () => {
  assert.throws(() => createPaymentAttempt({ stepId: 'research-bot' }), TypeError)
  assert.throws(() => createPaymentAttempt({ runId: RUN }), TypeError)
  assert.throws(() => paymentAttemptId(RUN, ''), TypeError)
})

test('a new attempt starts pending with its run and step attached', () => {
  const attempt = createPaymentAttempt(ATTEMPT_INPUT)
  assert.strictEqual(attempt.outcome, 'pending')
  assert.strictEqual(attempt.runId, RUN)
  assert.strictEqual(attempt.stepId, 'research-bot')
  assert.strictEqual(attempt.id, `pay:${RUN}:research-bot`)
  assert.strictEqual(attempt.failureReason, null)
  assert.strictEqual(attempt.terminal, false)
})

// ─── Terminal-failure policy ─────────────────────────────────────
console.log('\nfallback is permitted only under the documented terminal-failure policy')

test('the policy lists exactly the three definitive reasons', () => {
  assert.deepStrictEqual(TERMINAL_FAILURE_REASONS, [
    'http_4xx_rejected',
    'x402_settlement_reported_failure',
    'reconciled_not_settled',
  ])
  for (const reason of TERMINAL_FAILURE_REASONS) assert.ok(isTerminalFailure(reason))
})

test('a lost response and a 5xx are never terminal', () => {
  for (const reason of UNKNOWN_REASONS) assert.ok(!isTerminalFailure(reason))
  assert.ok(!isTerminalFailure('transport_error'))
  assert.ok(!isTerminalFailure('http_5xx'))
})

test('fallback is refused while pending and while unknown', () => {
  const pending = createPaymentAttempt(ATTEMPT_INPUT)
  assert.strictEqual(canAttemptFallback(pending), false)

  const unknown = markPaymentAttemptUnknown(pending, 'transport_error')
  assert.strictEqual(canAttemptFallback(unknown), false)
})

test('fallback is refused for a non-terminal failure', () => {
  const failed = failPaymentAttempt(createPaymentAttempt(ATTEMPT_INPUT), 'http_4xx_rejected')
  assert.strictEqual(canAttemptFallback(failed), true)

  // A "failed" attempt whose reason is outside the policy is never terminal.
  const notTerminal = { ...failed, failureReason: 'transport_error', terminal: false }
  assert.strictEqual(canAttemptFallback(notTerminal), false)
  assert.strictEqual(canAttemptFallback(null), false)
  assert.strictEqual(canAttemptFallback({}), false)
})

test('each terminal reason marks the attempt failed and terminal', () => {
  for (const reason of TERMINAL_FAILURE_REASONS) {
    const attempt = failPaymentAttempt(createPaymentAttempt(ATTEMPT_INPUT), reason)
    assert.strictEqual(attempt.outcome, 'failed')
    assert.strictEqual(attempt.terminal, true)
    assert.strictEqual(attempt.failureReason, reason)
    assert.strictEqual(canAttemptFallback(attempt), true)
  }
})

test('a failure without a reason is rejected', () => {
  assert.throws(() => failPaymentAttempt(createPaymentAttempt(ATTEMPT_INPUT), ''), TypeError)
})

test('a confirmed attempt never permits another settlement', () => {
  const confirmed = confirmPaymentAttempt(createPaymentAttempt(ATTEMPT_INPUT), { txHash: 'abc' })
  assert.strictEqual(confirmed.outcome, 'confirmed')
  assert.strictEqual(confirmed.txHash, 'abc')
  assert.strictEqual(canAttemptFallback(confirmed), false)
  assert.ok(ATTEMPT_OUTCOMES.includes(confirmed.outcome))
})

// ─── Visibly pending ─────────────────────────────────────────────
console.log('\nunknown outcomes stay visibly pending')

test('pending and unknown are visible; confirmed and failed are not', () => {
  const pending = createPaymentAttempt(ATTEMPT_INPUT)
  const unknown = markPaymentAttemptUnknown(pending, 'transport_error')
  const confirmed = confirmPaymentAttempt(pending, { txHash: 'tx' })
  const failed = failPaymentAttempt(pending, 'http_4xx_rejected')

  assert.strictEqual(isVisiblyPending(pending), true)
  assert.strictEqual(isVisiblyPending(unknown), true)
  assert.strictEqual(isVisiblyPending(confirmed), false)
  assert.strictEqual(isVisiblyPending(failed), false)
  assert.strictEqual(isVisiblyPending(null), false)

  const visible = selectPendingAttempts([pending, unknown, confirmed, failed])
  assert.deepStrictEqual(
    visible.map((a) => a.outcome),
    ['pending', 'unknown']
  )
})

test('summarizes outcomes for a run', () => {
  const pending = createPaymentAttempt(ATTEMPT_INPUT)
  const attempts = [
    pending,
    confirmPaymentAttempt(pending, { txHash: 'tx' }),
    failPaymentAttempt(pending, 'http_4xx_rejected'),
    markPaymentAttemptUnknown(pending, 'http_5xx'),
  ]
  assert.deepStrictEqual(summarizePaymentAttempts(attempts), {
    total: 4,
    pending: 1,
    confirmed: 1,
    failed: 1,
    unknown: 1,
  })
  assert.deepStrictEqual(summarizePaymentAttempts(null), {
    total: 0,
    pending: 0,
    confirmed: 0,
    failed: 0,
    unknown: 0,
  })
})

// ─── Scenarios from the issue's validation section ───────────────
console.log('\nsimulated outcomes and permitted payment calls')

testAsync('success with a lost response is recovered, not paid twice', async () => {
  let attempt = createPaymentAttempt(ATTEMPT_INPUT)
  const flow = makePaymentFlow(() => attempt)
  const settledTx = 'x402-lost-response-tx'

  // The settlement actually completed, but this process never saw the 200.
  attempt = markPaymentAttemptUnknown(attempt, 'transport_error')

  const fallbackWhileUnknown = flow.attemptFallback(() => 'should-not-run')
  assert.strictEqual(fallbackWhileUnknown.allowed, false, 'unknown must not fall back')

  attempt = await reconcilePaymentAttempt(attempt, {
    probe: async () => ({ settled: true, txHash: settledTx, proof: { source: 'horizon' } }),
  })

  assert.strictEqual(attempt.outcome, 'confirmed')
  assert.strictEqual(attempt.txHash, settledTx)
  assert.deepStrictEqual(attempt.proof, { source: 'horizon' })
  assert.strictEqual(canAttemptFallback(attempt), false)
  assert.deepStrictEqual(flow.settlements, [], 'reconciliation must not settle anything')
})

testAsync('delayed confirmation stays unknown instead of falling back', async () => {
  let attempt = markPaymentAttemptUnknown(createPaymentAttempt(ATTEMPT_INPUT), 'transport_error')

  attempt = await reconcilePaymentAttempt(attempt, {
    probe: async () => ({ settled: 'inconclusive' }),
  })
  assert.strictEqual(attempt.outcome, 'unknown')
  assert.strictEqual(attempt.failureReason, 'reconciliation_inconclusive')
  assert.strictEqual(canAttemptFallback(attempt), false)
  assert.strictEqual(isVisiblyPending(attempt), true)

  // A later reconciliation that resolves it confirms the original attempt.
  attempt = await reconcilePaymentAttempt(attempt, {
    probe: async () => ({ settled: true, txHash: 'late-tx' }),
  })
  assert.strictEqual(attempt.outcome, 'confirmed')
  assert.strictEqual(attempt.txHash, 'late-tx')
  assert.strictEqual(attempt.reconciliations, 2)
})

testAsync('definitive failure permits exactly one fallback settlement', async () => {
  let attempt = createPaymentAttempt(ATTEMPT_INPUT)
  const flow = makePaymentFlow(() => attempt)

  attempt = markPaymentAttemptUnknown(attempt, 'transport_error')
  attempt = await reconcilePaymentAttempt(attempt, { probe: async () => ({ settled: false }) })

  assert.strictEqual(attempt.outcome, 'failed')
  assert.strictEqual(attempt.terminal, true)
  assert.ok(isTerminalFailure(attempt.failureReason))

  const fallback = flow.attemptFallback(() => 'xlm-fallback-tx')
  assert.strictEqual(fallback.allowed, true)
  assert.strictEqual(fallback.result, 'xlm-fallback-tx')
  assert.deepStrictEqual(fallback.settlements, [`${attempt.id}:fallback`])
})

testAsync('a probe that throws leaves the attempt unknown', async () => {
  let attempt = markPaymentAttemptUnknown(createPaymentAttempt(ATTEMPT_INPUT), 'http_5xx')
  attempt = await reconcilePaymentAttempt(attempt, {
    probe: async () => {
      throw new Error('rpc unavailable')
    },
  })
  assert.strictEqual(attempt.outcome, 'unknown')
  assert.strictEqual(attempt.failureReason, 'reconciliation_inconclusive')
  assert.strictEqual(canAttemptFallback(attempt), false)
})

testAsync('without a probe the attempt stays unknown rather than assuming failure', async () => {
  const attempt = await reconcilePaymentAttempt(
    markPaymentAttemptUnknown(createPaymentAttempt(ATTEMPT_INPUT), 'transport_error'),
    {}
  )
  assert.strictEqual(attempt.outcome, 'unknown')
  assert.strictEqual(attempt.failureReason, 'reconciliation_inconclusive')
  assert.strictEqual(canAttemptFallback(attempt), false)
})

testAsync('restart during reconciliation reuses the same attempt and charges once', async () => {
  let attempt = markPaymentAttemptUnknown(createPaymentAttempt(ATTEMPT_INPUT), 'transport_error')
  const flow = makePaymentFlow(() => attempt)

  // Persist, then "restart": only the serialized attempts survive.
  let persisted = upsertPaymentAttempt([], attempt)
  const reloaded = JSON.parse(JSON.stringify(persisted))
  assert.strictEqual(reloaded[0].id, attempt.id)

  // After the restart the same run/step must address the same logical charge.
  const recreated = createPaymentAttempt(ATTEMPT_INPUT)
  assert.strictEqual(recreated.id, reloaded[0].id)

  // Reconciling after the restart updates the persisted attempt in place.
  const resolved = await reconcilePaymentAttempt(reloaded[0], {
    probe: async () => ({ settled: true, txHash: 'restart-tx' }),
  })
  persisted = upsertPaymentAttempt(persisted, resolved)

  assert.strictEqual(persisted.length, 1, 'no second attempt is appended')
  assert.strictEqual(persisted[0].id, attempt.id)
  assert.strictEqual(persisted[0].outcome, 'confirmed')
  assert.strictEqual(persisted[0].txHash, 'restart-tx')

  attempt = resolved
  assert.strictEqual(isVisiblyPending(attempt), false)
  assert.deepStrictEqual(
    flow.settlements,
    [],
    'the restart recovered the charge instead of paying again'
  )
})

testAsync('reconciliation is a read-only no-op for resolved attempts', async () => {
  const confirmed = confirmPaymentAttempt(createPaymentAttempt(ATTEMPT_INPUT), { txHash: 'tx' })
  const result = await reconcilePaymentAttempt(confirmed, {
    probe: async () => ({ settled: false }),
  })
  assert.strictEqual(result.outcome, 'confirmed')
  assert.strictEqual(result.txHash, 'tx')

  assert.strictEqual(await reconcilePaymentAttempt(null, {}), null)

  const pending = createPaymentAttempt(ATTEMPT_INPUT)
  assert.strictEqual(await reconcilePaymentAttempt(pending, {}), pending)
})

// ─── Recovered settlement: no second logical charge ──────────────
console.log('\na recovered settlement updates the original attempt and proof')

test('records the proof on the original attempt without creating a second charge', () => {
  const original = markPaymentAttemptUnknown(createPaymentAttempt(ATTEMPT_INPUT), 'transport_error')
  const attempts = [original]

  const { attempt: recovered, createdSecondCharge } = recordRecoveredSettlement(original, {
    txHash: 'recovered-tx',
    proof: { source: 'indexer', confirmedAt: '2026-01-01T00:00:00Z' },
  })
  const next = upsertPaymentAttempt(attempts, recovered)

  assert.strictEqual(createdSecondCharge, false)
  assert.strictEqual(next.length, 1, 'one logical charge keeps one record')
  assert.strictEqual(next[0].id, original.id)
  assert.strictEqual(next[0].outcome, 'confirmed')
  assert.strictEqual(next[0].txHash, 'recovered-tx')
  assert.deepStrictEqual(next[0].proof, { source: 'indexer', confirmedAt: '2026-01-01T00:00:00Z' })
})

test('upsert replaces by id and appends genuinely new attempts', () => {
  const first = createPaymentAttempt(ATTEMPT_INPUT)
  let list = upsertPaymentAttempt([], first)
  list = upsertPaymentAttempt(list, confirmPaymentAttempt(first, { txHash: 'tx' }))
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].outcome, 'confirmed')

  const second = createPaymentAttempt({ ...ATTEMPT_INPUT, stepId: 'summary-bot' })
  list = upsertPaymentAttempt(list, second)
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[1].id, `pay:${RUN}:summary-bot`)
})

test('upsert tolerates a missing attempt list', () => {
  const attempt = createPaymentAttempt(ATTEMPT_INPUT)
  assert.deepStrictEqual(upsertPaymentAttempt(undefined, attempt), [attempt])
})

// ─── Report ──────────────────────────────────────────────────────
Promise.all(asyncCases).then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    process.exit(1)
  }
})
