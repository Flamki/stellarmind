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
  return {
    success: true,
    method: options.method || 'x402',
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
  }
}

function groupKey(settlement) {
  return `${settlement.asset}|${settlement.issuer || ''}|${settlement.network || ''}`
}

/**
 * Sum confirmed settlements per (asset, issuer, network).
 *
 * Amounts of different assets are never added together. Unpaid/pending steps
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
