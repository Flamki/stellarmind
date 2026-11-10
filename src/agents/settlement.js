/**
 * Settlement reporting for orchestrator payments (issue #130).
 *
 * The orchestrator quotes every agent in the registry's USDC price, but it can
 * settle that call in two different assets: the x402 path charges USDC, while
 * the direct-transfer fallback sends native XLM. Reporting the quote as if it
 * were the settlement makes the two incomparable, so this module keeps them
 * apart:
 *
 *  - a *quote* is the marketplace price the run reserved for a step
 *    (`agent.price` in `agent.currency`, USDC today);
 *  - a *settlement* is the asset that was actually transferred, with its
 *    issuer and network.
 *
 * Totals are only ever summed per asset. There is no XLM/USDC conversion in
 * this repository, so mixed runs report separate USDC and XLM totals and
 * `SETTLEMENT_CONVERSION_POLICY` states explicitly that no conversion was
 * applied. That is what keeps an XLM amount out of a USDC settled total.
 *
 * The module is dependency-free apart from the exact `AssetAmount` helper, so
 * the accounting can be unit-tested deterministically without network or SDK
 * access.
 */

import { AssetAmount } from './amount.js'

/** Native XLM has no issuer. */
export const XLM_ASSET = 'XLM'

/**
 * Stellar network fee constants & policy (issue #161).
 *
 * Units:
 *  - Base unit: `stroops` (integer, 1 XLM = 10,000,000 stroops).
 *  - Display/accounting asset: native `XLM` (7 decimal places).
 *
 * Defaults & bounds for direct testnet transfers:
 *  - Protocol minimum base fee: 100 stroops (0.00001 XLM) per operation.
 *  - Default base fee: 100 stroops (0.00001 XLM).
 *  - Default maximum fee cap: 10,000 stroops (0.001 XLM).
 *  - Hard upper ceiling: 1,000,000 stroops (0.1 XLM) to guard against misconfiguration.
 */
export const STELLAR_STROOPS_PER_XLM = 10_000_000n
export const MIN_BASE_FEE_STROOPS = 100
export const DEFAULT_BASE_FEE_STROOPS = 100
export const DEFAULT_MAX_FEE_STROOPS = 10_000
export const HARD_MAX_FEE_STROOPS = 1_000_000

export const NETWORK_FEE_STATUSES = Object.freeze([
  'confirmed',
  'pending',
  'unknown',
  'not_applicable',
])

/**
 * Convert an integer stroop count to an exact XLM decimal string without
 * rounding small values to zero (e.g. `100` -> `'0.00001'`, `1` -> `'0.0000001'`).
 */
export function stroopsToXlmString(stroops) {
  if (stroops === null || stroops === undefined || stroops === '') {
    throw new TypeError('stroops value is required')
  }
  const s = String(stroops).trim()
  if (!/^\d+$/.test(s)) {
    throw new RangeError(`stroops must be a non-negative integer, got '${stroops}'`)
  }
  return AssetAmount.fromBaseUnits(BigInt(s), XLM_ASSET).toExactString()
}

/**
 * Convert an XLM decimal string or number to its integer stroop string.
 */
export function xlmToStroopsString(xlmAmount) {
  const amt = AssetAmount.from(xlmAmount, XLM_ASSET)
  if (amt.isNegative()) {
    throw new RangeError(`XLM fee amount cannot be negative, got '${xlmAmount}'`)
  }
  return amt.baseUnits.toString()
}

function parseFeeStroopsOption(value, fallback, fieldName) {
  if (value === undefined || value === null || value === '') return fallback
  const str = String(value).trim()
  if (!/^-?\d+$/.test(str)) {
    const err = new RangeError(`${fieldName} must be an integer in stroops, got '${value}'`)
    err.code = 'INVALID_FEE_POLICY'
    throw err
  }
  const parsed = Number.parseInt(str, 10)
  if (!Number.isSafeInteger(parsed)) {
    const err = new RangeError(`${fieldName} must be a safe integer in stroops, got '${value}'`)
    err.code = 'INVALID_FEE_POLICY'
    throw err
  }
  return parsed
}

/**
 * Validate and resolve the bounded fee policy for direct Stellar transfers.
 *
 * @param {{ baseFeeStroops?: number|string, maxFeeStroops?: number|string }} [raw]
 */
export function resolveStellarFeePolicy(raw = {}) {
  const baseFeeStroops = parseFeeStroopsOption(
    raw.baseFeeStroops,
    DEFAULT_BASE_FEE_STROOPS,
    'baseFeeStroops'
  )
  const maxFeeStroops = parseFeeStroopsOption(
    raw.maxFeeStroops,
    DEFAULT_MAX_FEE_STROOPS,
    'maxFeeStroops'
  )

  if (baseFeeStroops < MIN_BASE_FEE_STROOPS) {
    const err = new RangeError(
      `baseFeeStroops (${baseFeeStroops}) cannot be less than Stellar minimum (${MIN_BASE_FEE_STROOPS} stroops / ${stroopsToXlmString(MIN_BASE_FEE_STROOPS)} XLM)`
    )
    err.code = 'INVALID_FEE_POLICY'
    throw err
  }

  if (maxFeeStroops < MIN_BASE_FEE_STROOPS) {
    const err = new RangeError(
      `maxFeeStroops (${maxFeeStroops}) cannot be less than Stellar minimum (${MIN_BASE_FEE_STROOPS} stroops)`
    )
    err.code = 'INVALID_FEE_POLICY'
    throw err
  }

  if (maxFeeStroops > HARD_MAX_FEE_STROOPS) {
    const err = new RangeError(
      `maxFeeStroops (${maxFeeStroops}) exceeds hard safety ceiling (${HARD_MAX_FEE_STROOPS} stroops / ${stroopsToXlmString(HARD_MAX_FEE_STROOPS)} XLM)`
    )
    err.code = 'INVALID_FEE_POLICY'
    throw err
  }

  if (baseFeeStroops > maxFeeStroops) {
    const err = new RangeError(
      `baseFeeStroops (${baseFeeStroops}) cannot exceed maxFeeStroops (${maxFeeStroops})`
    )
    err.code = 'INVALID_FEE_POLICY'
    throw err
  }

  return Object.freeze({
    id: 'stellar-bounded-fee-v1',
    unit: 'stroops',
    asset: XLM_ASSET,
    stroopsPerXlm: Number(STELLAR_STROOPS_PER_XLM),
    minBaseFeeStroops: MIN_BASE_FEE_STROOPS,
    minBaseFeeXlm: stroopsToXlmString(MIN_BASE_FEE_STROOPS),
    defaultBaseFeeStroops: DEFAULT_BASE_FEE_STROOPS,
    defaultBaseFeeXlm: stroopsToXlmString(DEFAULT_BASE_FEE_STROOPS),
    defaultMaxFeeStroops: DEFAULT_MAX_FEE_STROOPS,
    defaultMaxFeeXlm: stroopsToXlmString(DEFAULT_MAX_FEE_STROOPS),
    hardMaxFeeStroops: HARD_MAX_FEE_STROOPS,
    hardMaxFeeXlm: stroopsToXlmString(HARD_MAX_FEE_STROOPS),
    baseFeeStroops,
    baseFeeXlm: stroopsToXlmString(baseFeeStroops),
    maxFeeStroops,
    maxFeeXlm: stroopsToXlmString(maxFeeStroops),
  })
}

export const DEFAULT_STELLAR_FEE_POLICY = resolveStellarFeePolicy()

/**
 * Evaluate a requested per-operation / transaction fee against the bounded
 * fee policy before submitting a direct Stellar transfer.
 *
 * When `clampFee === true`, a fee above `policy.maxFeeStroops` is clamped to
 * `policy.maxFeeStroops` and `clamped: true` is reported. Otherwise, exceeding
 * `policy.maxFeeStroops` throws a `RangeError` with `code: 'FEE_EXCEEDS_MAXIMUM'`.
 */
export function resolveDirectPaymentFee(options = {}, feePolicy = DEFAULT_STELLAR_FEE_POLICY) {
  const policy =
    feePolicy && typeof feePolicy.maxFeeStroops === 'number'
      ? feePolicy
      : resolveStellarFeePolicy(feePolicy || {})
  const operationCount = Math.max(1, Number.parseInt(options.operationCount ?? 1, 10) || 1)
  const requestedPerOpStroops = parseFeeStroopsOption(
    options.feeStroops ?? options.baseFeeStroops,
    policy.baseFeeStroops,
    'feeStroops'
  )

  if (requestedPerOpStroops < policy.minBaseFeeStroops) {
    const err = new RangeError(
      `Requested fee (${requestedPerOpStroops} stroops) is below minimum base fee (${policy.minBaseFeeStroops} stroops)`
    )
    err.code = 'FEE_BELOW_MINIMUM'
    throw err
  }

  const requestedTotalStroops = requestedPerOpStroops * operationCount
  const maxAllowedStroops = policy.maxFeeStroops

  if (requestedTotalStroops > maxAllowedStroops) {
    if (options.clampFee === true) {
      return {
        feeStroops: String(maxAllowedStroops),
        feeXlm: stroopsToXlmString(maxAllowedStroops),
        requestedFeeStroops: String(requestedTotalStroops),
        maxFeeStroops: String(maxAllowedStroops),
        maxFeeXlm: policy.maxFeeXlm,
        operationCount,
        clamped: true,
        policy,
      }
    }
    const err = new RangeError(
      `Requested transaction fee (${requestedTotalStroops} stroops / ${stroopsToXlmString(requestedTotalStroops)} XLM) exceeds configured maximum fee (${maxAllowedStroops} stroops / ${policy.maxFeeXlm} XLM)`
    )
    err.code = 'FEE_EXCEEDS_MAXIMUM'
    err.details = {
      requestedFeeStroops: String(requestedTotalStroops),
      maxFeeStroops: String(maxAllowedStroops),
      maxFeeXlm: policy.maxFeeXlm,
      operationCount,
    }
    throw err
  }

  return {
    feeStroops: String(requestedTotalStroops),
    feeXlm: stroopsToXlmString(requestedTotalStroops),
    requestedFeeStroops: String(requestedTotalStroops),
    maxFeeStroops: String(maxAllowedStroops),
    maxFeeXlm: policy.maxFeeXlm,
    operationCount,
    clamped: false,
    policy,
  }
}

/**
 * Normalize a Stellar network fee from a Horizon ledger response, transaction
 * record, settlement header, or fee descriptor (issue #161).
 *
 * Network fees are always denominated in native XLM (`stroops` on ledger) and
 * are never folded into quoted service charges or settled agent payouts.
 * Unknown or pending fees are marked explicitly rather than fabricated as `0`.
 */
export function normalizeNetworkFee(raw = null, options = {}) {
  const defaultSource = options.source || null

  if (raw && typeof raw === 'object' && raw.networkFee && typeof raw.networkFee === 'object') {
    return normalizeNetworkFee(raw.networkFee, {
      ...options,
      maxFeeStroops:
        options.maxFeeStroops ?? raw.max_fee ?? raw.maxFee ?? raw.maxFeeStroops ?? null,
    })
  }

  const maxFeeCandidate =
    options.maxFeeStroops ??
    raw?.max_fee ??
    raw?.maxFee ??
    raw?.maxFeeStroops ??
    options.feePolicy?.maxFeeStroops ??
    null
  const normalizedMaxStroops =
    maxFeeCandidate !== null &&
    maxFeeCandidate !== undefined &&
    /^\d+$/.test(String(maxFeeCandidate).trim())
      ? String(maxFeeCandidate).trim()
      : null
  const normalizedMaxXlm = normalizedMaxStroops ? stroopsToXlmString(normalizedMaxStroops) : null

  const explicitStatus = options.status || raw?.feeStatus || raw?.status || null

  if (explicitStatus === 'not_applicable') {
    return {
      status: 'not_applicable',
      amount: null,
      amountExact: null,
      stroops: null,
      asset: XLM_ASSET,
      unit: 'stroops',
      maxFeeStroops: null,
      maxFeeXlm: null,
      source: defaultSource || raw?.source || 'none',
      reason: options.reason || raw?.reason || 'No on-chain transaction submitted',
    }
  }

  if (
    explicitStatus === 'pending' ||
    raw?.pending === true ||
    raw?.status === 'PENDING' ||
    raw?.outcome === 'pending'
  ) {
    return {
      status: 'pending',
      amount: null,
      amountExact: null,
      stroops: null,
      asset: XLM_ASSET,
      unit: 'stroops',
      maxFeeStroops: normalizedMaxStroops,
      maxFeeXlm: normalizedMaxXlm,
      source: defaultSource || raw?.source || 'payment-pending',
      reason:
        options.reason ||
        raw?.reason ||
        'Transaction is pending ledger confirmation; fee_charged is not yet final',
    }
  }

  const stroopsCandidate =
    raw?.fee_charged ??
    raw?.feeCharged ??
    raw?.feeChargedStroops ??
    raw?.feeStroops ??
    raw?.networkFeeStroops ??
    raw?.stroops ??
    options.feeStroops ??
    null

  if (
    stroopsCandidate !== null &&
    stroopsCandidate !== undefined &&
    String(stroopsCandidate).trim() !== ''
  ) {
    const stroopsStr = String(stroopsCandidate).trim()
    if (/^\d+$/.test(stroopsStr)) {
      const exact = AssetAmount.fromBaseUnits(BigInt(stroopsStr), XLM_ASSET)
      return {
        status: 'confirmed',
        amount: exact.toExactString(),
        amountExact: exact.toJSON(),
        stroops: stroopsStr,
        asset: XLM_ASSET,
        unit: 'stroops',
        maxFeeStroops: normalizedMaxStroops,
        maxFeeXlm: normalizedMaxXlm,
        source: defaultSource || raw?.source || 'horizon-ledger',
        reason: null,
      }
    }
  }

  const xlmCandidate =
    raw?.feeChargedXlm ??
    raw?.feeXlm ??
    raw?.networkFeeXlm ??
    (raw?.asset === XLM_ASSET && raw?.amount !== undefined ? raw.amount : null) ??
    options.feeXlm ??
    null

  if (xlmCandidate !== null && xlmCandidate !== undefined && String(xlmCandidate).trim() !== '') {
    try {
      const exact = AssetAmount.from(String(xlmCandidate).trim(), XLM_ASSET)
      if (!exact.isNegative()) {
        return {
          status: 'confirmed',
          amount: exact.toExactString(),
          amountExact: exact.toJSON(),
          stroops: exact.baseUnits.toString(),
          asset: XLM_ASSET,
          unit: 'stroops',
          maxFeeStroops: normalizedMaxStroops,
          maxFeeXlm: normalizedMaxXlm,
          source: defaultSource || raw?.source || 'horizon-ledger',
          reason: null,
        }
      }
    } catch {
      // Fall through to unknown if malformed
    }
  }

  return {
    status: 'unknown',
    amount: null,
    amountExact: null,
    stroops: null,
    asset: XLM_ASSET,
    unit: 'stroops',
    maxFeeStroops: normalizedMaxStroops,
    maxFeeXlm: normalizedMaxXlm,
    source: defaultSource || raw?.source || 'unreported',
    reason:
      options.reason ||
      raw?.reason ||
      'Ledger fee_charged was not reported in the settlement response',
  }
}

/**
 * Explicit demo fallback policy (issue #130).
 *
 * The direct-transfer fallback sends the *numeric value* of the USDC quote as
 * native XLM: a 0.01 USDC quote settles 0.01 XLM. This is a demo policy, not an
 * exchange rate, so the settled XLM amount is never converted into, or added
 * to, a USDC total.
 */
export const XLM_FALLBACK_POLICY = Object.freeze({
  id: 'demo-numeric-xlm',
  asset: XLM_ASSET,
  issuer: null,
  description:
    'Demo fallback: the numeric quoted price is transferred as native XLM. No USDC/XLM conversion rate is applied.',
})

/** Stated explicitly wherever settled totals are reported. */
export const SETTLEMENT_CONVERSION_POLICY = Object.freeze({
  applied: false,
  reason:
    'No USDC/XLM conversion rate is configured. Settled amounts are reported per asset and are never added across assets.',
})

/** Resolve the issuer for an asset code from a validated network profile. */
export function assetIssuer(asset, networkProfile = null) {
  if (!networkProfile) return null
  const code = (asset || '').toUpperCase()
  if (code === 'USDC') return networkProfile.usdc?.issuer || null
  return null
}

/**
 * Build the quote record for one agent call.
 *
 * `amountExact` is the lossless AssetAmount JSON form so consumers that need
 * integer base units never have to re-parse a display string.
 *
 * @param {{ price: string, currency?: string }} agent
 * @param {object|null} [networkProfile] - validated Stellar network profile
 * @returns {{ amount: string, amountExact: object, asset: string, issuer: string|null, network: string|null }}
 */
export function buildQuote(agent, networkProfile = null) {
  const asset = (agent?.currency || 'USDC').toUpperCase()
  const amount = String(agent?.price)
  return {
    amount,
    amountExact: AssetAmount.from(amount, asset).toJSON(),
    asset,
    issuer: assetIssuer(asset, networkProfile),
    network: networkProfile?.network || null,
  }
}

/**
 * Build a confirmed settlement record for a quote.
 *
 * The amount defaults to the quote's numeric amount. For the XLM demo fallback
 * that is the documented policy; for x402 the facilitator charges the quoted
 * USDC price. Callers may pass an explicit amount when the settlement is known
 * to differ from the quote (for example, a reconciled on-chain amount).
 *
 * @param {object} quote - from buildQuote
 * @param {object} options
 * @param {string} options.method - 'x402' or 'stellar-xlm-direct'
 * @param {string} [options.asset] - settled asset code (defaults to quote asset)
 * @param {string|null} [options.issuer] - settled asset issuer (null for XLM)
 * @param {string|null} [options.network] - network the settlement happened on
 * @param {string} [options.amount] - settled amount (exact decimal string)
 * @param {string|null} [options.txHash]
 * @param {string|null} [options.explorerUrl]
 * @param {string|null} [options.policy] - id of an explicit settlement policy
 * @returns {object} settlement record
 */
export function buildSettlement(quote, options = {}) {
  const asset = (options.asset || quote.asset).toUpperCase()
  const amount = String(options.amount !== undefined ? options.amount : quote.amount)
  const method = options.method || 'x402'
  const networkFee = normalizeNetworkFee(options.networkFee ?? options, {
    status: options.networkFeeStatus,
    source: method === 'x402' ? 'x402-facilitator' : 'horizon-ledger',
    reason:
      method === 'x402'
        ? 'x402 facilitator did not report Stellar ledger fee_charged'
        : 'Ledger fee_charged was not reported in the settlement response',
  })
  return {
    success: true,
    method,
    amount,
    amountExact: AssetAmount.from(amount, asset).toJSON(),
    asset,
    issuer: options.issuer !== undefined ? options.issuer : assetIssuer(asset),
    network: options.network !== undefined ? options.network : (quote.network ?? null),
    txHash: options.txHash || null,
    explorerUrl: options.explorerUrl || null,
    policy: options.policy || null,
    quotedAmount: quote.amount,
    quotedAsset: quote.asset,
    networkFee,
  }
}

/** An unpaid step has no settled asset or amount at all. */
export function noSettlement(reason = 'unpaid') {
  return {
    success: false,
    method: 'none',
    amount: null,
    amountExact: null,
    asset: null,
    issuer: null,
    network: null,
    txHash: null,
    explorerUrl: null,
    policy: null,
    reason,
    networkFee: normalizeNetworkFee(null, {
      status: 'not_applicable',
      source: 'none',
      reason: 'No on-chain transaction submitted',
    }),
  }
}

/**
 * Build a structured payment receipt that explicitly separates:
 *  1. `quotedServiceCharge` (the marketplace price quoted for the agent call)
 *  2. `settledTransfer` (the actual asset and amount transferred to the agent)
 *  3. `networkFee` (the Stellar network fee in native XLM / stroops)
 */
export function buildPaymentReceipt({
  quote,
  settlement = null,
  networkFee = null,
  paymentAttempt = null,
  stepId = null,
  agentId = null,
  agentName = null,
} = {}) {
  const settled = Boolean(settlement && settlement.success === true)
  const resolvedFee = networkFee
    ? normalizeNetworkFee(networkFee)
    : settled && settlement.networkFee
      ? normalizeNetworkFee(settlement.networkFee)
      : paymentAttempt &&
          (paymentAttempt.outcome === 'unknown' || paymentAttempt.outcome === 'pending')
        ? normalizeNetworkFee(null, {
            status: 'pending',
            source: 'payment-pending',
            reason: 'Payment attempt outcome is unresolved; network fee is pending reconciliation',
          })
        : normalizeNetworkFee(null, {
            status: 'not_applicable',
            source: 'none',
            reason: 'No on-chain transaction submitted',
          })

  return {
    stepId: stepId || paymentAttempt?.stepId || null,
    agentId: agentId || paymentAttempt?.agentId || null,
    agentName: agentName || null,
    quotedServiceCharge: quote
      ? {
          amount: quote.amount,
          amountExact: quote.amountExact || null,
          asset: quote.asset,
          issuer: quote.issuer ?? null,
          network: quote.network ?? null,
        }
      : null,
    settledTransfer: {
      settled,
      method: settled ? settlement.method : 'none',
      amount: settled ? settlement.amount : null,
      amountExact: settled ? settlement.amountExact || null : null,
      asset: settled ? settlement.asset : null,
      issuer: settled ? (settlement.issuer ?? null) : null,
      network: settled ? (settlement.network ?? null) : null,
      txHash: settled ? settlement.txHash || null : null,
      explorerUrl: settled ? settlement.explorerUrl || null : null,
      policy: settled ? settlement.policy || null : null,
    },
    networkFee: resolvedFee,
  }
}

function groupKey(settlement) {
  return `${settlement.asset}|${settlement.issuer || ''}|${settlement.network || ''}`
}

/**
 * Sum confirmed settlements per (asset, issuer, network).
 *
 * Amounts of different assets are never added together, and Stellar network
 * fees are never added into settled service totals. Unpaid/pending steps
 * carry no settlement and therefore contribute nothing to any total.
 *
 * @param {Array<object|null|undefined>} settlements
 * @returns {Array<{ asset: string, issuer: string|null, network: string|null, amount: string, amountExact: object, count: number, txCount: number }>}
 */
export function summarizeSettledTotals(settlements = []) {
  const groups = new Map()

  for (const settlement of settlements || []) {
    if (!settlement || settlement.success !== true || !settlement.asset) continue
    if (settlement.amount === null || settlement.amount === undefined) continue

    const key = groupKey(settlement)
    let group = groups.get(key)
    if (!group) {
      group = {
        asset: settlement.asset,
        issuer: settlement.issuer || null,
        network: settlement.network || null,
        total: AssetAmount.zero(settlement.asset),
        count: 0,
        txCount: 0,
      }
      groups.set(key, group)
    }

    group.total = group.total.plus(AssetAmount.from(settlement.amount, settlement.asset))
    group.count += 1
    if (settlement.txHash) group.txCount += 1
  }

  return Array.from(groups.values()).map((group) => ({
    asset: group.asset,
    issuer: group.issuer,
    network: group.network,
    amount: group.total.toExactString(),
    amountExact: group.total.toJSON(),
    count: group.count,
    txCount: group.txCount,
  }))
}

/**
 * Format a single normalized network fee for human-readable display while
 * preserving small XLM fee values (such as 0.00001 XLM / 100 stroops).
 */
export function formatNetworkFee(fee) {
  if (!fee || typeof fee !== 'object') return 'unknown'
  const normalized = fee.status && fee.asset === XLM_ASSET ? fee : normalizeNetworkFee(fee)
  if (normalized.status === 'not_applicable') return 'none'
  if (normalized.status === 'pending') return 'pending'
  if (normalized.status === 'unknown') return 'unknown'
  if (normalized.amount !== null && normalized.stroops !== null) {
    return `${normalized.amount} ${XLM_ASSET} (${normalized.stroops} stroops)`
  }
  if (normalized.amount !== null) {
    return `${normalized.amount} ${XLM_ASSET}`
  }
  return 'unknown'
}

/**
 * Aggregate Stellar network fees across a run's steps/payments separately from
 * quoted service charges and settled agent transfers (#161).
 */
export function summarizeNetworkFees(items = []) {
  let total = AssetAmount.zero(XLM_ASSET)
  let confirmedCount = 0
  let pendingCount = 0
  let unknownCount = 0
  let notApplicableCount = 0

  for (const item of items || []) {
    if (!item) continue
    const candidate = item.networkFee || item.settlement?.networkFee || item
    const fee =
      candidate && candidate.status && candidate.asset === XLM_ASSET
        ? candidate
        : normalizeNetworkFee(candidate)

    if (fee.status === 'confirmed' && fee.stroops !== null) {
      total = total.plus(AssetAmount.fromBaseUnits(BigInt(fee.stroops), XLM_ASSET))
      confirmedCount += 1
    } else if (fee.status === 'pending') {
      pendingCount += 1
    } else if (fee.status === 'unknown') {
      unknownCount += 1
    } else {
      notApplicableCount += 1
    }
  }

  let status = 'none'
  if (confirmedCount > 0 && pendingCount === 0 && unknownCount === 0) {
    status = 'confirmed'
  } else if (confirmedCount > 0 && (pendingCount > 0 || unknownCount > 0)) {
    status = 'partial'
  } else if (pendingCount > 0) {
    status = 'pending'
  } else if (unknownCount > 0) {
    status = 'unknown'
  }

  const parts = []
  if (confirmedCount > 0) {
    parts.push(`${total.toExactString()} ${XLM_ASSET} (${total.baseUnits.toString()} stroops)`)
  }
  if (pendingCount > 0) {
    parts.push(`${pendingCount} pending`)
  }
  if (unknownCount > 0) {
    parts.push(`${unknownCount} unknown`)
  }
  const summary = parts.length > 0 ? parts.join(' + ') : 'none'

  return {
    status,
    asset: XLM_ASSET,
    unit: 'stroops',
    amount: confirmedCount > 0 ? total.toExactString() : null,
    amountExact: confirmedCount > 0 ? total.toJSON() : null,
    stroops: confirmedCount > 0 ? total.baseUnits.toString() : null,
    confirmedCount,
    pendingCount,
    unknownCount,
    notApplicableCount,
    summary,
  }
}

export function formatNetworkFeeSummary(summaryOrItems) {
  if (!summaryOrItems) return 'none'
  if (Array.isArray(summaryOrItems)) {
    return summarizeNetworkFees(summaryOrItems).summary
  }
  if (typeof summaryOrItems === 'string') return summaryOrItems
  if (typeof summaryOrItems.summary === 'string') return summaryOrItems.summary
  return summarizeNetworkFees([summaryOrItems]).summary
}

/** Amount settled in one asset, as an exact decimal string, or null when none. */
export function settledAmountForAsset(settledTotals, asset) {
  const entry = (settledTotals || []).find((total) => total.asset === (asset || '').toUpperCase())
  return entry ? entry.amount : null
}

/** True when a run settled more than one asset and therefore has no single total. */
export function hasMixedSettledAssets(settledTotals) {
  return (settledTotals || []).length > 1
}

/**
 * Human-readable per-asset total, e.g. `0.04 USDC + 0.01 XLM`.
 * Returns `none` when nothing settled.
 */
export function formatSettledTotals(settledTotals) {
  if (!Array.isArray(settledTotals) || settledTotals.length === 0) return 'none'
  return settledTotals.map((total) => `${total.amount} ${total.asset}`).join(' + ')
}
