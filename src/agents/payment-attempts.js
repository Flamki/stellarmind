/**
 * Payment-attempt state machine (#131).
 *
 * The paid-call path used to treat *any* HTTP error or transport exception as
 * a reason to enter the direct-payment fallback. A missing response does not
 * establish whether an earlier settlement completed, so that policy can pay
 * twice for one logical charge: once on the x402 path that actually settled
 * and once on the fallback that assumed it had not.
 *
 * This module makes the outcome of every attempt explicit and persisted:
 *
 *   pending -> unknown -> (confirmed | failed)
 *   pending -> confirmed | failed
 *
 * The only state that permits a new settlement is a *terminal* failure, from
 * the small documented policy in `TERMINAL_FAILURE_REASONS`. `unknown` is a
 * first-class state that stays visibly pending until reconciliation resolves
 * it, and a recovered settlement updates the original attempt (and its proof)
 * instead of creating a second logical charge.
 */

/** Every attempt is in exactly one of these states. */
export const ATTEMPT_OUTCOMES = ['pending', 'confirmed', 'failed', 'unknown']

/**
 * Documented terminal-failure policy — the only reasons that permit a new
 * settlement attempt (see `canAttemptFallback`).
 *
 * Each reason is definitive evidence that the original attempt did *not*
 * settle:
 *
 * - `http_4xx_rejected` — the destination answered with a 4xx, i.e. it
 *   rejected the request before settling anything.
 * - `x402_settlement_reported_failure` — a 2xx response whose settlement
 *   header reports the settlement itself failed.
 * - `reconciled_not_settled` — a reconciliation probe positively established
 *   that no settlement happened.
 *
 * Deliberately absent: `transport_error` and `http_5xx`. The request may well
 * have been settled before the response was lost, so those stay `unknown`.
 */
export const TERMINAL_FAILURE_REASONS = [
  'http_4xx_rejected',
  'x402_settlement_reported_failure',
  'reconciled_not_settled',
]

/** Reasons that leave an attempt `unknown` until reconciliation resolves it. */
export const UNKNOWN_REASONS = ['transport_error', 'http_5xx', 'reconciliation_inconclusive']

export function isTerminalFailure(reason) {
  return TERMINAL_FAILURE_REASONS.includes(reason)
}

/**
 * Builds the stable identity for a (run, step) pair.
 *
 * Deriving the id rather than generating one is what makes reconciliation
 * after a restart work: the same run and step always address the same logical
 * charge, so a recovered settlement is recognised as *that* attempt instead of
 * being recorded as a new one.
 */
export function paymentAttemptId(runId, stepId) {
  if (!runId) throw new TypeError('runId is required to identify a payment attempt')
  if (!stepId) throw new TypeError('stepId is required to identify a payment attempt')
  return `pay:${runId}:${stepId}`
}

/**
 * Creates a payment attempt in the `pending` state.
 *
 * `runId`/`stepId` are required: an attempt that cannot be linked to the run
 * and step it belongs to cannot be reconciled after a restart.
 */
export function createPaymentAttempt({
  runId,
  stepId,
  agentId = null,
  amount = null,
  currency = null,
  method = 'x402',
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    id: paymentAttemptId(runId, stepId),
    runId,
    stepId,
    agentId,
    amount,
    currency,
    method,
    outcome: 'pending',
    /** Why the attempt is not confirmed. Null while pending/confirmed. */
    failureReason: null,
    /** True only for documented terminal failures. */
    terminal: false,
    txHash: null,
    explorerUrl: null,
    proof: null,
    createdAt,
    updatedAt: createdAt,
    /** Reconciliation bookkeeping so repeated probes are visible. */
    reconciliations: 0,
  }
}

function withOutcome(attempt, outcome, patch = {}) {
  return {
    ...attempt,
    ...patch,
    outcome,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  }
}

/** Records a definitive settlement, attaching its proof. */
export function confirmPaymentAttempt(
  attempt,
  { txHash = null, explorerUrl = null, proof = null } = {}
) {
  return withOutcome(attempt, 'confirmed', {
    failureReason: null,
    terminal: false,
    txHash: txHash || attempt.txHash || null,
    explorerUrl: explorerUrl || attempt.explorerUrl || null,
    proof: proof || attempt.proof || null,
  })
}

/**
 * Records a failure. `reason` decides whether the attempt is a terminal
 * failure (fallback permitted) or a definitive-yet-non-terminal one.
 */
export function failPaymentAttempt(attempt, reason) {
  if (!reason) throw new TypeError('a failure reason is required')
  const terminal = isTerminalFailure(reason)
  return withOutcome(attempt, 'failed', { failureReason: reason, terminal })
}

/**
 * Marks an attempt uncertain: the request left this process, but no response
 * established its outcome. This is the state that must never trigger a new
 * settlement on its own.
 */
export function markPaymentAttemptUnknown(attempt, reason = 'transport_error') {
  return withOutcome(attempt, 'unknown', { failureReason: reason, terminal: false })
}

/**
 * Whether a new settlement attempt may be started for this attempt.
 *
 * Only a terminal failure permits it — never `pending`, never `unknown`, and
 * never a non-terminal failure. Callers that skip this check are the bug this
 * module exists to prevent.
 */
export function canAttemptFallback(attempt) {
  return (
    attempt?.outcome === 'failed' &&
    attempt.terminal === true &&
    isTerminalFailure(attempt.failureReason)
  )
}

/** Pending and unknown both stay visible: neither is a settled outcome. */
export function isVisiblyPending(attempt) {
  return attempt?.outcome === 'pending' || attempt?.outcome === 'unknown'
}

/**
 * Resolves an `unknown` attempt by asking whether the earlier settlement
 * actually completed.
 *
 * `probe` receives the attempt and returns:
 *   - `{ settled: true, txHash?, explorerUrl?, proof? }` -> confirmed
 *   - `{ settled: false }` -> failed with `reconciled_not_settled` (terminal,
 *     because reconciliation positively established nothing was charged)
 *   - anything else, a throw, or no probe -> stays `unknown`
 *
 * Never throws and never starts a settlement: reconciliation is read-only.
 */
export async function reconcilePaymentAttempt(attempt, { probe } = {}) {
  if (!attempt || attempt.outcome !== 'unknown') return attempt

  const attempted = { ...attempt, reconciliations: (attempt.reconciliations || 0) + 1 }

  if (typeof probe !== 'function') {
    return { ...attempted, failureReason: 'reconciliation_inconclusive' }
  }

  let result
  try {
    result = await probe(attempt)
  } catch {
    result = null
  }

  if (result && result.settled === true) {
    return confirmPaymentAttempt(attempted, result)
  }
  if (result && result.settled === false) {
    return failPaymentAttempt(attempted, 'reconciled_not_settled')
  }
  return { ...attempted, failureReason: 'reconciliation_inconclusive' }
}

/**
 * Applies a recovered settlement to the *original* attempt.
 *
 * Returns the same attempt id, so the caller can persist it in place rather
 * than appending a second attempt for the same logical charge:
 * `createdSecondCharge` is false by construction.
 */
export function recordRecoveredSettlement(
  attempt,
  { txHash = null, explorerUrl = null, proof = null } = {}
) {
  if (!attempt) throw new TypeError('an attempt is required')
  return {
    attempt: confirmPaymentAttempt(
      { ...attempt, reconciliations: attempt.reconciliations || 0 },
      { txHash, explorerUrl, proof: proof || { recovered: true } }
    ),
    createdSecondCharge: false,
  }
}

/**
 * Inserts or replaces an attempt by id. Persisting through this function is
 * what keeps "one logical charge, one record" true across retries, recovery,
 * and restarts.
 */
export function upsertPaymentAttempt(attempts, attempt) {
  const list = Array.isArray(attempts) ? attempts : []
  const index = list.findIndex((entry) => entry.id === attempt.id)
  if (index === -1) return [...list, attempt]
  const next = list.slice()
  next[index] = attempt
  return next
}

/** The subset of attempts a UI should show as still in flight. */
export function selectPendingAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : []).filter(isVisiblyPending)
}

/** Compact counts for run summaries and health signals. */
export function summarizePaymentAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : []
  return list.reduce(
    (acc, attempt) => {
      acc.total += 1
      if (attempt.outcome in acc) acc[attempt.outcome] += 1
      return acc
    },
    { total: 0, pending: 0, confirmed: 0, failed: 0, unknown: 0 }
  )
}
