import { Keypair, Horizon, TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk'
import { config } from '../config.js'
import { explorerTxUrl, getFriendbotUrl } from './network.js'

// One validated profile drives every network fact in this module: Horizon
// origin, transaction passphrase, explorer links, and the friend-only funding
// helper. Nothing here hard-codes testnet any more.
const profile = config.networkProfile
const HORIZON_URL = profile.horizonUrl
const server = new Horizon.Server(HORIZON_URL)

// ── Bounded concurrency and caching for per-transaction operation lookups ─────
//
// Decorating a page of transactions with their operations used to mean one
// Horizon request per transaction, all launched at once by `Promise.all`: a page
// of 100 transactions fired 100 concurrent requests, and a refresh re-fetched
// operations that cannot change for a transaction already in a closed ledger.

/**
 * Run `mapper` over `items` with at most `limit` promises in flight.
 * Results keep the order of `items`.
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  const width = Math.max(1, Math.min(limit, items.length))

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

/** Successful lookups only: a failed fetch must not be cached as "no operations". */
const operationsCache = new Map()

export function clearOperationsCache() {
  operationsCache.clear()
}

export function operationsCacheEntryCount() {
  return operationsCache.size
}

/**
 * Cache key for one lookup: the network profile and the transaction hash.
 *
 * A transaction hash identifies a transaction only within one network, and the
 * app can be pointed at another Horizon endpoint or network profile
 * (`NETWORK`), so a result fetched on one profile must never answer a lookup on
 * another. The endpoint is part of the key for the same reason.
 */
export function operationsCacheKey(hash, horizonServer = server, profileId = config.network) {
  const endpoint =
    horizonServer?.serverURL || horizonServer?.serverUrl || horizonServer?.url || HORIZON_URL
  return `${profileId}|${endpoint}|${hash}`
}

function cacheLookup(key) {
  if (!operationsCache.has(key)) return undefined
  const value = operationsCache.get(key)
  // Re-insert so the least recently used entry is the one evicted below.
  operationsCache.delete(key)
  operationsCache.set(key, value)
  return value
}

function cacheStore(key, operations) {
  if (config.horizonOpsCacheSize <= 0) return
  operationsCache.set(key, operations)
  while (operationsCache.size > config.horizonOpsCacheSize) {
    operationsCache.delete(operationsCache.keys().next().value)
  }
}

/**
 * Operations for a single transaction, cached after the first successful lookup.
 *
 * The cache is keyed by the network profile and the transaction hash (see
 * `operationsCacheKey`), so a lookup against another Horizon endpoint or
 * network cannot be answered from this profile's cache.
 *
 * Returns `{ operations, error }`: an empty list because the transaction has no
 * operations is a different outcome from a lookup that failed, and the caller
 * has to be able to show that difference.
 */
export async function fetchTransactionOperations(hash, horizonServer = server) {
  const key = operationsCacheKey(hash, horizonServer)
  const cached = cacheLookup(key)
  if (cached) return { operations: cached, error: null }

  try {
    const opsResp = await horizonServer
      .operations()
      .forTransaction(hash)
      .order('asc')
      .limit(10)
      .call()

    const operations = opsResp.records.map((op) => {
      const assetCode =
        op.asset_type === 'native'
          ? 'XLM'
          : op.asset_code || op.selling_asset_code || op.buying_asset_code || null

      const amount =
        op.amount ||
        op.starting_balance ||
        op.send_amount ||
        op.dest_amount ||
        op.buy_amount ||
        op.source_amount ||
        null

      return {
        id: op.id,
        type: op.type,
        amount,
        asset_code: assetCode,
        from: op.from || op.source_account || null,
        to: op.to || op.account || op.destination || null,
      }
    })

    cacheStore(key, operations)
    return { operations, error: null }
  } catch (err) {
    return { operations: [], error: err.message }
  }
}

/**
 * Get balance for a Stellar public key
 *
 * Returns an object with:
 * - success: boolean indicating if the operation succeeded
 * - balances: array of balance objects (only present when success is true)
 * - error: error details (only present when success is false)
 * - errorType: categorized error type for client handling
 */
export async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey)
    const balances = account.balances.map((b) => ({
      asset: b.asset_type === 'native' ? 'XLM' : `${b.asset_code}`,
      balance: b.balance,
      issuer: b.asset_issuer || null,
      ...(b.contract_id || b.contractId ? { contractId: b.contract_id || b.contractId } : {}),
    }))

    return {
      success: true,
      balances,
    }
  } catch (err) {
    console.error(`Failed to load balance for ${publicKey}:`, err.message)

    // Categorize the error type
    let errorType = 'UPSTREAM_ERROR'
    if (err.response?.status === 404) {
      errorType = 'ACCOUNT_NOT_FOUND'
    } else if (err.message?.includes('timeout') || err.code === 'ETIMEDOUT') {
      errorType = 'TIMEOUT'
    } else if (err.message?.includes('ENOTFOUND') || err.message?.includes('ECONNREFUSED')) {
      errorType = 'NETWORK_ERROR'
    }

    return {
      success: false,
      error: err.message,
      errorType,
      timestamp: new Date().toISOString(),
    }
  }
}

// ── Settlement asset identity matching & bounded wallet readiness (#157) ─────
//
// Readiness previously ran once at module load and matched `balance.asset === 'USDC'`
// by code alone. That meant:
//   1. funding a testnet wallet or adding a trustline after startup never
//      updated the cached readiness hint without a process restart;
//   2. any arbitrary `USDC` balance from a different issuer satisfied the check;
//   3. upstream Horizon failures collapsed into the same `x402WalletReady = false`
//      state without distinguishing an unverified upstream failure from a
//      confirmed zero balance.

/**
 * Resolve the configured settlement asset identity for a network profile.
 */
export function resolveSettlementAssetIdentity(networkProfile = profile, assetOverride = null) {
  const raw = assetOverride ||
    networkProfile?.settlementAsset ||
    networkProfile?.usdc ||
    profile?.usdc || {
      code: 'USDC',
      issuer: null,
    }

  const code = String(raw.code || raw.asset || 'USDC')
    .trim()
    .toUpperCase()
  const issuer = raw.issuer ? String(raw.issuer).trim() : null
  const contractId =
    raw.contractId || raw.contract ? String(raw.contractId || raw.contract).trim() : null

  return Object.freeze({
    code,
    issuer,
    contractId,
  })
}

/**
 * Check whether a single Horizon/RPC balance entry matches the configured
 * settlement asset identity (asset code + issuer, or contract identity).
 *
 * A balance with the same code (`USDC`) from another issuer or contract never
 * satisfies this check.
 */
export function matchesSettlementAsset(balanceEntry, assetIdentity = profile.usdc) {
  if (!balanceEntry || typeof balanceEntry !== 'object') return false

  const expected = resolveSettlementAssetIdentity(profile, assetIdentity)
  const entryCode =
    balanceEntry.asset_type === 'native'
      ? 'XLM'
      : String(balanceEntry.asset || balanceEntry.asset_code || '')
          .trim()
          .toUpperCase()
  const entryIssuer = balanceEntry.issuer ?? balanceEntry.asset_issuer ?? null
  const entryContract =
    balanceEntry.contractId ?? balanceEntry.contract ?? balanceEntry.asset_contract_id ?? null

  if (expected.contractId) {
    if (entryContract) {
      if (entryContract !== expected.contractId) return false
      if (expected.code && entryCode && entryCode !== expected.code) return false
      if (expected.issuer && entryIssuer && entryIssuer !== expected.issuer) return false
      return true
    }
    if (expected.issuer) {
      return entryCode === expected.code && entryIssuer === expected.issuer
    }
    return false
  }

  if (expected.issuer) {
    return entryCode === expected.code && entryIssuer === expected.issuer
  }

  return entryCode === expected.code && !entryIssuer && !entryContract
}

/**
 * Locate the configured settlement asset balance among an account's balances,
 * separating it from any same-code balances issued by untrusted issuers or
 * contracts.
 */
export function findSettlementBalance(balances = [], assetIdentity = profile.usdc) {
  const expected = resolveSettlementAssetIdentity(profile, assetIdentity)
  const list = Array.isArray(balances) ? balances : []

  const match = list.find((entry) => matchesSettlementAsset(entry, expected)) || null
  const mismatched = list.filter((entry) => {
    const entryCode =
      entry?.asset_type === 'native'
        ? 'XLM'
        : String(entry?.asset || entry?.asset_code || '')
            .trim()
            .toUpperCase()
    return entryCode === expected.code && !matchesSettlementAsset(entry, expected)
  })
  const mismatchedIssuers = mismatched.map(
    (entry) =>
      entry?.issuer ?? entry?.asset_issuer ?? entry?.contractId ?? entry?.contract ?? 'unknown'
  )

  return {
    match,
    balanceEntry: match,
    mismatched,
    mismatchedIssuers,
    asset: expected,
  }
}

const readinessCache = new Map()
const inFlightReadiness = new Map()

export function clearWalletReadinessCache() {
  readinessCache.clear()
  inFlightReadiness.clear()
}

export function walletReadinessCacheEntryCount() {
  return readinessCache.size
}

/**
 * Cache key for one wallet readiness lookup, scoped by network profile,
 * Horizon endpoint, wallet address, and configured settlement asset identity.
 */
export function walletReadinessCacheKey(options = {}) {
  const netProfile = options.networkProfile || config.networkProfile || profile
  const address = String(
    (options.address !== undefined ? options.address : config.orchestratorAddress) || ''
  ).trim()
  const asset = resolveSettlementAssetIdentity(netProfile, options.asset || options.settlementAsset)
  const horizonOrigin = netProfile?.horizonUrl || HORIZON_URL
  const netId = netProfile?.network || config.network
  return `${netId}|${horizonOrigin}|${address || 'unconfigured'}|${asset.code}:${asset.issuer || ''}:${asset.contractId || ''}`
}

function resolveNowMs(nowOption) {
  if (typeof nowOption === 'function') {
    const val = Number(nowOption())
    if (Number.isFinite(val)) return val
  } else if (typeof nowOption === 'number' && Number.isFinite(nowOption)) {
    return nowOption
  } else if (nowOption instanceof Date) {
    return nowOption.getTime()
  }
  return Date.now()
}

function lookupReadinessCache(key, nowMs) {
  if (!readinessCache.has(key)) return undefined
  const entry = readinessCache.get(key)
  if (entry.ttlMs <= 0 || nowMs - entry.checkedAtMs >= entry.ttlMs) {
    readinessCache.delete(key)
    return undefined
  }
  readinessCache.delete(key)
  readinessCache.set(key, entry)
  return entry
}

function storeReadinessCache(key, entry, maxEntries) {
  const limit = Math.max(
    0,
    Number.isFinite(maxEntries) ? maxEntries : config.walletReadinessCacheSize
  )
  if (limit <= 0 || entry.ttlMs <= 0 || entry.upstreamError) return
  readinessCache.delete(key)
  readinessCache.set(key, entry)
  while (readinessCache.size > limit) {
    readinessCache.delete(readinessCache.keys().next().value)
  }
}

function formatReadinessResponse(entry, { nowMs, cached = false, sharedInFlight = false } = {}) {
  const ageMs = Math.max(0, nowMs - entry.checkedAtMs)
  const fresh = !entry.upstreamError && (entry.ttlMs > 0 ? ageMs < entry.ttlMs : !cached)
  const stale = !fresh
  const freshnessState = entry.upstreamError
    ? 'error'
    : cached
      ? fresh
        ? 'cached'
        : 'stale'
      : 'fresh'

  return {
    ready: entry.ready,
    status: entry.status,
    address: entry.address,
    network: entry.network,
    asset: { ...entry.asset },
    balance: entry.balance,
    balanceConfirmed: entry.balanceConfirmed,
    hasTrustline: entry.hasTrustline,
    mismatchedIssuers: [...entry.mismatchedIssuers],
    reasonCode: entry.reasonCode,
    reason: entry.reason,
    hint: entry.reason,
    action: entry.action,
    checkedAt: entry.checkedAt,
    timestamp: entry.checkedAt,
    expiresAt: entry.expiresAt,
    ttlMs: entry.ttlMs,
    ageMs,
    fresh,
    stale,
    cached: Boolean(cached),
    fromCache: Boolean(cached),
    sharedInFlight: Boolean(sharedInFlight),
    freshness: {
      state: freshnessState,
      fresh,
      stale,
      cached: Boolean(cached),
      sharedInFlight: Boolean(sharedInFlight),
      checkedAt: entry.checkedAt,
      expiresAt: entry.expiresAt,
      ageMs,
      ttlMs: entry.ttlMs,
    },
    upstreamError: entry.upstreamError,
    error: entry.error,
    errorType: entry.errorType,
  }
}

function categorizeBalanceError(err) {
  if (err?.errorType) return err.errorType
  if (err?.response?.status === 404 || /not[_\s-]?found|404/i.test(err?.message || '')) {
    return 'ACCOUNT_NOT_FOUND'
  }
  if (/timeout|etimedout/i.test(err?.message || '') || err?.code === 'ETIMEDOUT') {
    return 'TIMEOUT'
  }
  if (/enotfound|econnrefused|network/i.test(err?.message || '')) {
    return 'NETWORK_ERROR'
  }
  return 'UPSTREAM_ERROR'
}

async function normalizeBalanceLookup(balanceLoader, address) {
  try {
    const raw = await balanceLoader(address)
    if (Array.isArray(raw)) {
      return { success: true, balances: raw }
    }
    if (raw && typeof raw === 'object') {
      if (raw.success === false) {
        return {
          success: false,
          error: raw.error || 'Upstream balance lookup failed',
          errorType: raw.errorType || categorizeBalanceError(raw),
        }
      }
      if (Array.isArray(raw.balances)) {
        return { success: true, balances: raw.balances }
      }
    }
    return {
      success: false,
      error: 'Invalid balance lookup response',
      errorType: 'UPSTREAM_ERROR',
    }
  } catch (err) {
    return {
      success: false,
      error: err?.message || 'Upstream balance lookup failed',
      errorType: categorizeBalanceError(err),
    }
  }
}

/**
 * Inspect the currently cached readiness entry without making an upstream call.
 * Returns null if no non-expired entry is present in the cache.
 */
export function getWalletReadinessSnapshot(options = {}) {
  const nowMs = resolveNowMs(options.now)
  const key = walletReadinessCacheKey(options)
  const entry = readinessCache.get(key)
  if (!entry) return null
  return formatReadinessResponse(entry, { nowMs, cached: true, sharedInFlight: false })
}

/**
 * Evaluate wallet readiness for the configured settlement asset with bounded
 * caching, concurrent request sharing, and explicit upstream-error separation.
 */
export async function checkWalletReadiness(options = {}) {
  const netProfile = options.networkProfile || config.networkProfile || profile
  const address = String(
    (options.address !== undefined ? options.address : config.orchestratorAddress) || ''
  ).trim()
  const asset = resolveSettlementAssetIdentity(netProfile, options.asset || options.settlementAsset)
  const ttlMs = Math.max(
    0,
    options.ttlMs !== undefined && Number.isFinite(Number(options.ttlMs))
      ? Number(options.ttlMs)
      : config.walletReadinessTtlMs
  )
  const maxEntries =
    options.cacheSize !== undefined && Number.isFinite(Number(options.cacheSize))
      ? Number(options.cacheSize)
      : config.walletReadinessCacheSize
  const forceRefresh = Boolean(options.refresh || options.forceRefresh)
  const balanceLoader = typeof options.getBalance === 'function' ? options.getBalance : getBalance
  const key = walletReadinessCacheKey({
    address,
    networkProfile: netProfile,
    asset,
  })

  const initialNowMs = resolveNowMs(options.now)

  if (!forceRefresh) {
    const cachedEntry = lookupReadinessCache(key, initialNowMs)
    if (cachedEntry) {
      return formatReadinessResponse(cachedEntry, {
        nowMs: initialNowMs,
        cached: true,
        sharedInFlight: false,
      })
    }
  }

  if (inFlightReadiness.has(key)) {
    const sharedEntry = await inFlightReadiness.get(key)
    const resolvedNowMs = resolveNowMs(options.now)
    return formatReadinessResponse(sharedEntry, {
      nowMs: resolvedNowMs,
      cached: false,
      sharedInFlight: true,
    })
  }

  const evaluationPromise = (async () => {
    const checkedAtMs = resolveNowMs(options.now)
    const checkedAt = new Date(checkedAtMs).toISOString()
    const expiresAt = new Date(checkedAtMs + ttlMs).toISOString()

    if (!address) {
      const action = 'Set ORCHESTRATOR_STELLAR_ADDRESS in .env or run: npm run setup'
      const entry = {
        ready: false,
        status: 'not_ready',
        address: null,
        network: netProfile.network,
        asset,
        balance: null,
        balanceConfirmed: false,
        hasTrustline: null,
        mismatchedIssuers: [],
        reasonCode: 'ADDRESS_NOT_CONFIGURED',
        reason: `ORCHESTRATOR_STELLAR_ADDRESS is not configured. ${action}`,
        action,
        checkedAtMs,
        checkedAt,
        expiresAt,
        ttlMs,
        upstreamError: false,
        error: null,
        errorType: null,
      }
      storeReadinessCache(key, entry, maxEntries)
      return entry
    }

    const lookup = await normalizeBalanceLookup(balanceLoader, address)
    const finishMs = resolveNowMs(options.now)
    const finishIso = new Date(finishMs).toISOString()
    const finishExpiresIso = new Date(finishMs + ttlMs).toISOString()

    if (!lookup.success) {
      if (lookup.errorType === 'ACCOUNT_NOT_FOUND') {
        const action = netProfile?.funding?.friendbotUrl
          ? 'Run: npm run setup (or fund the account via Friendbot)'
          : `Fund orchestrator wallet ${address} on ${netProfile.network}`
        const entry = {
          ready: false,
          status: 'not_ready',
          address,
          network: netProfile.network,
          asset,
          balance: null,
          balanceConfirmed: true,
          hasTrustline: false,
          mismatchedIssuers: [],
          reasonCode: 'ACCOUNT_UNFUNDED',
          reason: `Orchestrator wallet is not funded on ${netProfile.network} (account not found). ${action}`,
          action,
          checkedAtMs: finishMs,
          checkedAt: finishIso,
          expiresAt: finishExpiresIso,
          ttlMs,
          upstreamError: false,
          error: lookup.error,
          errorType: 'ACCOUNT_NOT_FOUND',
        }
        storeReadinessCache(key, entry, maxEntries)
        return entry
      }

      // Upstream error (timeout, network error, 5xx): never masquerade as a
      // confirmed zero balance or missing trustline, and do not cache.
      const action = 'Verify Horizon connectivity and retry wallet readiness check'
      return {
        ready: false,
        status: 'unknown',
        address,
        network: netProfile.network,
        asset,
        balance: null,
        balanceConfirmed: false,
        hasTrustline: null,
        mismatchedIssuers: [],
        reasonCode: 'UPSTREAM_ERROR',
        reason: `Unable to verify x402 wallet readiness (${lookup.errorType}): ${lookup.error}. ${action}`,
        action,
        checkedAtMs: finishMs,
        checkedAt: finishIso,
        expiresAt: finishIso,
        ttlMs,
        upstreamError: true,
        error: lookup.error,
        errorType: lookup.errorType,
      }
    }

    const { match, mismatchedIssuers } = findSettlementBalance(lookup.balances, asset)
    const identityLabel = asset.contractId
      ? `contract ${asset.contractId}`
      : asset.issuer
        ? `issuer ${asset.issuer}`
        : netProfile.network

    if (!match) {
      const hasWrongIssuer = mismatchedIssuers.length > 0
      const action = 'Run: npm run setup:usdc'
      const reasonCode = hasWrongIssuer ? 'WRONG_ASSET_ISSUER' : 'MISSING_TRUSTLINE'
      const reason = hasWrongIssuer
        ? `No ${asset.code} trustline for configured ${netProfile.network} ${identityLabel} (found ${asset.code} from ${mismatchedIssuers.join(', ')}). ${action}`
        : `No ${asset.code} trustline on orchestrator wallet for ${identityLabel}. ${action}`

      const entry = {
        ready: false,
        status: 'not_ready',
        address,
        network: netProfile.network,
        asset,
        balance: null,
        balanceConfirmed: true,
        hasTrustline: false,
        mismatchedIssuers,
        reasonCode,
        reason,
        action,
        checkedAtMs: finishMs,
        checkedAt: finishIso,
        expiresAt: finishExpiresIso,
        ttlMs,
        upstreamError: false,
        error: null,
        errorType: null,
      }
      storeReadinessCache(key, entry, maxEntries)
      return entry
    }

    const numericBalance = Number.parseFloat(match.balance || '0')
    if (!Number.isFinite(numericBalance) || numericBalance <= 0) {
      const faucet = netProfile?.funding?.faucetUrl
      const action = faucet
        ? `Fund ${netProfile.label} ${asset.code} via ${faucet}`
        : `Fund the orchestrator wallet with ${asset.code} (${identityLabel}) to enable x402 payments`
      const entry = {
        ready: false,
        status: 'not_ready',
        address,
        network: netProfile.network,
        asset,
        balance: String(match.balance ?? '0.0000000'),
        balanceConfirmed: true,
        hasTrustline: true,
        mismatchedIssuers,
        reasonCode: 'ZERO_BALANCE',
        reason: `${asset.code} balance is 0 for ${identityLabel}. ${action}`,
        action,
        checkedAtMs: finishMs,
        checkedAt: finishIso,
        expiresAt: finishExpiresIso,
        ttlMs,
        upstreamError: false,
        error: null,
        errorType: null,
      }
      storeReadinessCache(key, entry, maxEntries)
      return entry
    }

    const entry = {
      ready: true,
      status: 'ready',
      address,
      network: netProfile.network,
      asset,
      balance: String(match.balance),
      balanceConfirmed: true,
      hasTrustline: true,
      mismatchedIssuers,
      reasonCode: null,
      reason: null,
      action: null,
      checkedAtMs: finishMs,
      checkedAt: finishIso,
      expiresAt: finishExpiresIso,
      ttlMs,
      upstreamError: false,
      error: null,
      errorType: null,
    }
    storeReadinessCache(key, entry, maxEntries)
    return entry
  })()

  inFlightReadiness.set(key, evaluationPromise)
  try {
    const entry = await evaluationPromise
    const resolvedNowMs = resolveNowMs(options.now)
    return formatReadinessResponse(entry, {
      nowMs: resolvedNowMs,
      cached: false,
      sharedInFlight: false,
    })
  } finally {
    inFlightReadiness.delete(key)
  }
}

/**
 * Force an immediate readiness refresh bypassing the TTL cache.
 */
export async function refreshWalletReadiness(options = {}) {
  return checkWalletReadiness({ ...options, refresh: true })
}

/**
 * Get keypair from a secret key string
 */
export function getKeypair(secretKey) {
  return Keypair.fromSecret(secretKey)
}

/**
 * Send XLM payment between two wallets (for demo agent-to-agent payments)
 */
export async function sendPayment(senderSecret, recipientPublic, amount, memo = '') {
  try {
    const senderKeypair = Keypair.fromSecret(senderSecret)
    const senderAccount = await server.loadAccount(senderKeypair.publicKey())

    const txBuilder = new TransactionBuilder(senderAccount, {
      fee: '100',
      networkPassphrase: profile.passphrase,
    })

    txBuilder.addOperation(
      Operation.payment({
        destination: recipientPublic,
        asset: Asset.native(),
        amount: String(amount),
      })
    )

    if (memo) {
      txBuilder.addMemo(new (await import('@stellar/stellar-sdk')).Memo('text', memo.slice(0, 28)))
    }

    txBuilder.setTimeout(30)
    const tx = txBuilder.build()
    tx.sign(senderKeypair)

    const result = await server.submitTransaction(tx)
    return {
      success: true,
      txHash: result.hash,
      ledger: result.ledger,
      explorerUrl: explorerTxUrl(profile, result.hash),
    }
  } catch (err) {
    console.error('Payment failed:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Fund a wallet via Friendbot. Testnet only: `getFriendbotUrl` refuses to
 * return a helper for any profile that does not define one.
 */
export async function fundWithFriendbot(publicKey) {
  try {
    const response = await fetch(`${getFriendbotUrl(profile)}?addr=${publicKey}`)
    const data = await response.json()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Get recent transactions for a wallet
 *
 * Returns an object with:
 * - success: boolean indicating if the operation succeeded
 * - transactions: array of transaction objects (only present when success is true)
 * - error: error details (only present when success is false)
 * - errorType: categorized error type for client handling
 */
export async function getTransactions(publicKey, limit = 10, cursor = null, order = 'desc') {
  try {
    let query = server.transactions().forAccount(publicKey).order(order).limit(limit)

    if (cursor) {
      query = query.cursor(cursor)
    }

    const txs = await query.call()

    const decorated = await mapWithConcurrency(
      txs.records,
      config.horizonOpsMaxConcurrency,
      async (tx) => {
        const { operations, error } = await fetchTransactionOperations(tx.hash)

        if (error) {
          console.warn(`Failed to fetch operations for tx ${tx.hash}:`, error)
        }

        return {
          hash: tx.hash,
          paging_token: tx.paging_token,
          ledger: tx.ledger,
          createdAt: tx.created_at,
          created_at: tx.created_at,
          memo: tx.memo || null,
          memo_type: tx.memo_type || null,
          feeCharged: tx.fee_charged,
          operationCount: tx.operation_count,
          operation_count: tx.operation_count,
          successful: tx.successful,
          operations,
          // Distinguishes "this transaction has no operations" from "the lookup
          // failed" — both used to arrive as an empty array.
          ...(error ? { operationsError: error } : {}),
          explorerUrl: explorerTxUrl(profile, tx.hash),
        }
      }
    )

    return {
      success: true,
      transactions: decorated,
    }
  } catch (err) {
    console.error('Failed to fetch transactions:', err.message)

    // Categorize the error type
    let errorType = 'UPSTREAM_ERROR'
    if (err.response?.status === 404) {
      errorType = 'ACCOUNT_NOT_FOUND'
    } else if (err.message?.includes('timeout') || err.code === 'ETIMEDOUT') {
      errorType = 'TIMEOUT'
    } else if (err.message?.includes('ENOTFOUND') || err.message?.includes('ECONNREFUSED')) {
      errorType = 'NETWORK_ERROR'
    }

    return {
      success: false,
      error: err.message,
      errorType,
      timestamp: new Date().toISOString(),
    }
  }
}
