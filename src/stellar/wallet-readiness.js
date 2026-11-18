/**
 * Wallet readiness for x402 settlement (#157).
 *
 * Answers one question: can this wallet pay in the configured settlement asset
 * right now? The answer is cached for a bounded time, can be refreshed on
 * demand, and is only ever satisfied by the exact configured asset (code AND
 * issuer from the network profile), so a same-code balance from another issuer
 * never counts.
 *
 * Outcomes are explicit:
 *   ready            funded trustline for the configured asset
 *   unfunded         trustline exists, balance is zero
 *   no_trustline     account exists, no trustline for the configured asset
 *   wrong_issuer     account holds the same asset code from a different issuer only
 *   account_not_found  account does not exist on this network
 *   not_configured   no wallet address configured
 *   unavailable      the upstream lookup failed; readiness is UNKNOWN, never false
 *
 * `ready` is `true`, `false`, or `null`. `null` means "could not be determined":
 * an upstream failure must not be reported as a confirmed empty wallet.
 */

export const READINESS_STATES = Object.freeze({
  READY: 'ready',
  UNFUNDED: 'unfunded',
  NO_TRUSTLINE: 'no_trustline',
  WRONG_ISSUER: 'wrong_issuer',
  ACCOUNT_NOT_FOUND: 'account_not_found',
  NOT_CONFIGURED: 'not_configured',
  UNAVAILABLE: 'unavailable',
})

const DEFAULTS = Object.freeze({
  // How long a confirmed answer is considered fresh.
  ttlMs: 30_000,
  // A failed lookup is retried sooner than a confirmed answer, but not instantly.
  failureTtlMs: 5_000,
  // Upper bound on one upstream lookup.
  requestTimeoutMs: 5_000,
  // An explicit refresh cannot hit the upstream more often than this.
  minRefreshIntervalMs: 2_000,
})

/** True for a decimal string with at least one non-zero digit, e.g. "0.0000001". */
function isPositiveAmount(value) {
  const text = String(value ?? '')
  return /^\d+(\.\d+)?$/.test(text) && /[1-9]/.test(text)
}

function withTimeout(promise, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`balance lookup timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const summarize = (err) => String(err?.message || err || 'unknown error').slice(0, 180)

/**
 * @param {object} options
 * @param {(address: string) => Promise<object>} options.getBalance wallet balance lookup;
 *   resolves `{ success, balances, error, errorType }` and may also reject
 * @param {string} options.address wallet to check (may be empty: reported as not configured)
 * @param {{code: string, issuer: string}} options.asset the configured settlement asset
 * @param {string} [options.network] network identifier, echoed in responses
 * @param {string} [options.faucetUrl] where to fund the asset, used in the failure reason
 * @param {number} [options.ttlMs]
 * @param {number} [options.failureTtlMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.minRefreshIntervalMs]
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {{info: Function, warn: Function}} [options.logger]
 */
export function createWalletReadiness({
  getBalance,
  address,
  asset,
  network = null,
  faucetUrl = null,
  ttlMs = DEFAULTS.ttlMs,
  failureTtlMs = DEFAULTS.failureTtlMs,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
  minRefreshIntervalMs = DEFAULTS.minRefreshIntervalMs,
  now = Date.now,
  logger = null,
}) {
  if (typeof getBalance !== 'function') throw new TypeError('getBalance must be a function')
  if (!asset?.code || !asset?.issuer) {
    throw new TypeError('asset must define both code and issuer')
  }

  const assetLabel = `${asset.code}:${asset.issuer}`

  // The cache holds exactly one entry (one wallet, one asset), so it is bounded
  // by construction. `inflight` lets concurrent callers share one lookup.
  let entry = null
  let inflight = null

  function describe(code) {
    switch (code) {
      case READINESS_STATES.NOT_CONFIGURED:
        return 'ORCHESTRATOR_STELLAR_ADDRESS is not configured'
      case READINESS_STATES.ACCOUNT_NOT_FOUND:
        return 'Orchestrator account does not exist on this network. Fund it first: npm run setup'
      case READINESS_STATES.NO_TRUSTLINE:
        return `No ${assetLabel} trustline on the orchestrator wallet. Run: npm run setup:usdc`
      case READINESS_STATES.WRONG_ISSUER:
        return (
          `The wallet holds ${asset.code} from a different issuer. Only ${assetLabel} ` +
          'satisfies readiness. Add a trustline to the configured issuer: npm run setup:usdc'
        )
      case READINESS_STATES.UNFUNDED:
        return faucetUrl
          ? `${asset.code} balance is 0. Fund the wallet with ${assetLabel} via ${faucetUrl}`
          : `${asset.code} balance is 0. Fund the wallet with ${assetLabel}`
      default:
        return null
    }
  }

  function evaluate(result) {
    if (!result || result.success !== true || !Array.isArray(result.balances)) {
      if (result?.errorType === 'ACCOUNT_NOT_FOUND') {
        return { state: READINESS_STATES.ACCOUNT_NOT_FOUND, balance: null }
      }
      return {
        state: READINESS_STATES.UNAVAILABLE,
        balance: null,
        failure: result?.error || 'balance lookup failed',
      }
    }

    const match = result.balances.find(
      (balance) => balance.asset === asset.code && balance.issuer === asset.issuer
    )
    if (!match) {
      const sameCode = result.balances.some((balance) => balance.asset === asset.code)
      return {
        state: sameCode ? READINESS_STATES.WRONG_ISSUER : READINESS_STATES.NO_TRUSTLINE,
        balance: null,
      }
    }
    return {
      state: isPositiveAmount(match.balance) ? READINESS_STATES.READY : READINESS_STATES.UNFUNDED,
      balance: match.balance,
    }
  }

  function present(stored) {
    if (!stored) {
      return {
        ready: null,
        state: 'unchecked',
        reason: 'Wallet readiness has not been checked yet',
        asset: { ...asset },
        network,
        checkedAt: null,
        expiresAt: null,
        fresh: false,
        ageMs: null,
        balance: null,
      }
    }
    const current = now()
    return {
      ready: stored.ready,
      state: stored.state,
      reason: stored.reason,
      asset: { ...asset },
      network,
      checkedAt: new Date(stored.checkedAtMs).toISOString(),
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
      fresh: current < stored.expiresAtMs,
      ageMs: Math.max(0, current - stored.checkedAtMs),
      balance: stored.balance,
    }
  }

  async function lookup() {
    if (!address) return { state: READINESS_STATES.NOT_CONFIGURED, balance: null }
    try {
      return evaluate(await withTimeout(Promise.resolve(getBalance(address)), requestTimeoutMs))
    } catch (err) {
      return { state: READINESS_STATES.UNAVAILABLE, balance: null, failure: summarize(err) }
    }
  }

  async function refreshNow() {
    const outcome = await lookup()
    const checkedAtMs = now()
    const unavailable = outcome.state === READINESS_STATES.UNAVAILABLE
    const previousState = entry?.state

    entry = {
      state: outcome.state,
      // Unknown, not false: an upstream failure is not a confirmed empty wallet.
      ready: unavailable ? null : outcome.state === READINESS_STATES.READY,
      reason: unavailable
        ? `Unable to verify wallet readiness (${outcome.failure}). Retrying shortly; this is not a confirmed empty balance.`
        : outcome.state === READINESS_STATES.READY
          ? null
          : describe(outcome.state),
      balance: outcome.balance,
      checkedAtMs,
      expiresAtMs: checkedAtMs + (unavailable ? Math.min(failureTtlMs, ttlMs) : ttlMs),
    }

    // Log transitions only, so a steady state does not repeat every refresh.
    if (entry.state !== previousState) {
      const log = entry.ready === true ? logger?.info : logger?.warn
      log?.call(logger, 'x402_wallet_readiness_changed', {
        state: entry.state,
        ready: entry.ready,
        reason: entry.reason,
      })
    }
    return present(entry)
  }

  /**
   * The current readiness, refreshing it when it has expired or `refresh` is set.
   * Never rejects. Concurrent callers share one lookup, and an explicit refresh
   * is throttled so it cannot be used to hammer the upstream.
   */
  function check({ refresh = false } = {}) {
    if (inflight) return inflight

    if (entry) {
      const isFresh = now() < entry.expiresAtMs
      const throttled = now() - entry.checkedAtMs < minRefreshIntervalMs
      if (refresh ? throttled : isFresh) return Promise.resolve(present(entry))
    }

    inflight = refreshNow().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    check,
    /** Cached readiness without any network call; `fresh` says whether it is still current. */
    peek: () => present(entry),
  }
}
