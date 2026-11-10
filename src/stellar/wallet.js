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

export const DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT = 10
export const MAX_TX_OPERATIONS_PAGE_LIMIT = 200

/**
 * Determine the direction of an operation relative to an optional wallet address (#159).
 */
export function resolveOperationDirection(op, accountAddress = null) {
  if (!op || typeof op !== 'object') return 'non_transfer'
  const from = op.from || op.funder || null
  const to = op.to || op.account || op.destination || op.into || null

  if (!from || !to) return 'non_transfer'
  if (from === to) return 'self'

  if (accountAddress) {
    if (to === accountAddress && from !== accountAddress) return 'incoming'
    if (from === accountAddress && to !== accountAddress) return 'outgoing'
    if (from === accountAddress && to === accountAddress) return 'self'
    return 'external'
  }

  return 'transfer'
}

/**
 * Normalize a Horizon operation record with asset, issuer, paging_token, and direction (#159).
 */
export function normalizeOperationRecord(op, accountAddress = null) {
  const assetCode =
    op.asset_type === 'native'
      ? 'XLM'
      : op.asset_code || op.selling_asset_code || op.buying_asset_code || null
  const assetIssuer =
    op.asset_type === 'native'
      ? null
      : op.asset_issuer || op.selling_asset_issuer || op.buying_asset_issuer || null

  const amount =
    op.amount ||
    op.starting_balance ||
    op.send_amount ||
    op.dest_amount ||
    op.buy_amount ||
    op.source_amount ||
    null

  const from = op.from || op.source_account || op.funder || null
  const to = op.to || op.account || op.destination || op.into || null
  const direction = resolveOperationDirection({ ...op, from, to }, accountAddress)

  return {
    id: op.id ? String(op.id) : null,
    paging_token: op.paging_token ? String(op.paging_token) : op.id ? String(op.id) : null,
    type: op.type || 'unknown',
    amount: amount !== null && amount !== undefined ? String(amount) : null,
    asset_code: assetCode,
    asset_issuer: assetIssuer,
    asset_type:
      op.asset_type || (assetCode === 'XLM' ? 'native' : assetCode ? 'credit_alphanum4' : null),
    asset: assetCode ? (assetIssuer ? `${assetCode}:${assetIssuer}` : assetCode) : null,
    from,
    to,
    direction,
    transaction_successful:
      op.transaction_successful !== undefined ? Boolean(op.transaction_successful) : null,
  }
}

/**
 * Deduplicate operation records by stable `id` or `paging_token` while preserving order (#159).
 */
export function deduplicateOperations(operations = []) {
  const seen = new Set()
  const unique = []
  let duplicateCount = 0

  for (const op of operations || []) {
    if (!op || typeof op !== 'object') continue
    const key = op.id || op.paging_token || null
    if (key) {
      if (seen.has(key)) {
        duplicateCount += 1
        continue
      }
      seen.add(key)
    }
    unique.push(op)
  }

  return { operations: unique, duplicateCount }
}

/**
 * Summarize a transaction's operations without implying the first operation's
 * amount is the transaction total when multiple operations exist (#159).
 */
export function summarizeTransactionOperations(operations = [], options = {}) {
  const loadedCount = Array.isArray(operations) ? operations.length : 0
  const rawExpected =
    options.totalOperationCount !== undefined ? options.totalOperationCount : options.expectedCount
  const totalCount = Number.isInteger(rawExpected) && rawExpected >= 0 ? rawExpected : loadedCount
  const hasError = Boolean(options.error)
  const complete = !hasError && loadedCount >= totalCount
  const truncated = !hasError && loadedCount < totalCount
  const successful = options.successful !== undefined ? Boolean(options.successful) : true

  if (hasError) {
    return {
      operationCount: totalCount,
      totalOperationCount: totalCount,
      loadedOperationCount: loadedCount,
      complete: false,
      truncated: false,
      isMultiOperation: totalCount > 1,
      successful,
      typeLabel: 'operations unavailable',
      amountLabel: 'unavailable',
      direction: 'unknown',
      assets: [],
      types: [],
    }
  }

  if (totalCount === 0 || (loadedCount === 0 && totalCount === 0)) {
    return {
      operationCount: 0,
      totalOperationCount: 0,
      loadedOperationCount: 0,
      complete: true,
      truncated: false,
      isMultiOperation: false,
      successful,
      typeLabel: 'no operations (0 ops)',
      amountLabel: 'No operations (0 ops)',
      direction: 'none',
      assets: [],
      types: [],
    }
  }

  const normalizedOps = (operations || []).map((op) =>
    op.direction ? op : normalizeOperationRecord(op, options.accountAddress || null)
  )
  const types = Array.from(new Set(normalizedOps.map((op) => op.type).filter(Boolean)))
  const assets = Array.from(new Set(normalizedOps.map((op) => op.asset_code).filter(Boolean)))
  const directions = Array.from(
    new Set(normalizedOps.map((op) => op.direction).filter((d) => d && d !== 'non_transfer'))
  )
  const overallDirection =
    directions.length === 0 ? 'non_transfer' : directions.length === 1 ? directions[0] : 'mixed'

  if (totalCount === 1 && loadedCount === 1) {
    const op = normalizedOps[0]
    const typeLabel = (op.type || 'operation').replaceAll('_', ' ')
    let amountLabel = '—'
    if (op.amount) {
      const num = Number.parseFloat(op.amount)
      const formatted = Number.isFinite(num) ? num.toFixed(2) : op.amount
      amountLabel = `${formatted} ${op.asset_code || 'XLM'}`
    } else if (op.type === 'invoke_host_function') {
      amountLabel = 'contract call'
    }
    return {
      operationCount: 1,
      totalOperationCount: 1,
      loadedOperationCount: 1,
      complete: true,
      truncated: false,
      isMultiOperation: false,
      successful,
      typeLabel,
      amountLabel,
      direction: op.direction || 'transfer',
      asset: op.asset_code || null,
      assets,
      types,
    }
  }

  const typeSummary =
    types.length === 1 ? types[0].replaceAll('_', ' ') : `${types.length || 'multiple'} types`
  const assetSummary = assets.length > 0 ? assets.join(', ') : 'non-asset'

  const typeLabel = truncated
    ? `${typeSummary} (${loadedCount}/${totalCount} ops loaded)`
    : `${typeSummary} (${totalCount} ops)`

  const amountLabel = truncated
    ? `Multi-op (${loadedCount} of ${totalCount} ops loaded · ${assetSummary})`
    : `Multi-op (${totalCount} ops · ${assetSummary})`

  return {
    operationCount: totalCount,
    totalOperationCount: totalCount,
    loadedOperationCount: loadedCount,
    complete,
    truncated,
    isMultiOperation: true,
    successful,
    typeLabel,
    amountLabel,
    direction: overallDirection,
    asset: assets.length === 1 ? assets[0] : null,
    assets,
    types,
  }
}

/**
 * Operations for a single transaction, cached after the first successful lookup
 * when called with default first-page parameters.
 *
 * The cache is keyed by the network profile and the transaction hash (see
 * `operationsCacheKey`), so a lookup against another Horizon endpoint or
 * network cannot be answered from this profile's cache.
 *
 * Returns `{ operations, error, complete, truncated, hasMore, nextCursor, loadedCount, totalCount }`.
 */
export async function fetchTransactionOperations(hash, horizonServer = server, options = {}) {
  const limit = Math.max(
    1,
    Math.min(
      MAX_TX_OPERATIONS_PAGE_LIMIT,
      Number.parseInt(options.limit ?? DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT, 10) ||
        DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT
    )
  )
  const order = options.order === 'desc' ? 'desc' : 'asc'
  const cursor = options.cursor || null
  const accountAddress = options.accountAddress || null
  const expectedCount =
    Number.isInteger(options.expectedCount) && options.expectedCount >= 0
      ? options.expectedCount
      : null

  const isDefaultPage = !cursor && limit === DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT && order === 'asc'
  const key = operationsCacheKey(hash, horizonServer)

  if (isDefaultPage) {
    const cached = cacheLookup(key)
    if (cached) {
      const decoratedCached = accountAddress
        ? cached.map((op) => ({
            ...op,
            direction: resolveOperationDirection(op, accountAddress),
          }))
        : cached
      const totalCount = expectedCount !== null ? expectedCount : decoratedCached.length
      const hasMore =
        expectedCount !== null
          ? decoratedCached.length < expectedCount
          : decoratedCached.length >= limit
      const nextCursor =
        hasMore && decoratedCached.length > 0
          ? decoratedCached[decoratedCached.length - 1].paging_token ||
            decoratedCached[decoratedCached.length - 1].id ||
            null
          : null
      return {
        operations: decoratedCached,
        error: null,
        complete: !hasMore,
        truncated: hasMore,
        hasMore,
        loadedCount: decoratedCached.length,
        totalCount,
        nextCursor,
        continuationUrl: hasMore
          ? `/api/wallet/transactions/${hash}/operations${nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}&limit=${limit}` : `?limit=${limit}`}`
          : null,
      }
    }
  }

  try {
    let builder = horizonServer.operations().forTransaction(hash).order(order).limit(limit)
    if (cursor && typeof builder.cursor === 'function') {
      builder = builder.cursor(cursor)
    }

    const opsResp = await builder.call()
    const rawRecords = Array.isArray(opsResp?.records) ? opsResp.records : []
    const normalized = rawRecords.map((op) => normalizeOperationRecord(op, accountAddress))
    const { operations } = deduplicateOperations(normalized)

    if (isDefaultPage) {
      cacheStore(key, operations)
    }

    const totalCount = expectedCount !== null ? expectedCount : operations.length
    const hasMore = cursor
      ? rawRecords.length >= limit
      : expectedCount !== null
        ? operations.length < expectedCount
        : rawRecords.length >= limit
    const nextCursor =
      hasMore && operations.length > 0
        ? operations[operations.length - 1].paging_token ||
          operations[operations.length - 1].id ||
          null
        : null

    return {
      operations,
      error: null,
      complete: !hasMore,
      truncated: hasMore,
      hasMore,
      loadedCount: operations.length,
      totalCount,
      nextCursor,
      continuationUrl: hasMore
        ? `/api/wallet/transactions/${hash}/operations${nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}&limit=${limit}` : `?limit=${limit}`}`
        : null,
    }
  } catch (err) {
    return {
      operations: [],
      error: err.message,
      complete: false,
      truncated: false,
      hasMore: false,
      loadedCount: 0,
      totalCount: expectedCount ?? 0,
      nextCursor: null,
      continuationUrl: null,
    }
  }
}

/**
 * Retrieve all operations for a transaction across pages without duplicating
 * records (#159).
 */
export async function fetchAllTransactionOperations(hash, options = {}) {
  const horizonServer = options.horizonServer || server
  const pageSize = Math.max(
    1,
    Math.min(
      MAX_TX_OPERATIONS_PAGE_LIMIT,
      Number.parseInt(options.pageSize ?? DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT, 10) ||
        DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT
    )
  )
  const maxPages = Math.max(1, Number.parseInt(options.maxPages ?? 50, 10) || 50)
  const order = options.order === 'desc' ? 'desc' : 'asc'
  const accountAddress = options.accountAddress || null
  const expectedCount =
    Number.isInteger(options.expectedCount) && options.expectedCount >= 0
      ? options.expectedCount
      : null

  const collected = []
  const seenKeys = new Set()
  let duplicateCount = 0

  const addRecords = (records) => {
    let added = 0
    for (const rawOp of records || []) {
      const op = normalizeOperationRecord(rawOp, accountAddress)
      const dedupKey = op.id || op.paging_token || null
      if (dedupKey) {
        if (seenKeys.has(dedupKey)) {
          duplicateCount += 1
          continue
        }
        seenKeys.add(dedupKey)
      }
      collected.push(op)
      added += 1
    }
    return added
  }

  if (Array.isArray(options.initialOperations) && options.initialOperations.length > 0) {
    addRecords(options.initialOperations)
  }

  let cursor =
    options.cursor ||
    (collected.length > 0
      ? collected[collected.length - 1].paging_token || collected[collected.length - 1].id || null
      : null)
  let pagesFetched = 0

  try {
    while (pagesFetched < maxPages) {
      if (expectedCount !== null && collected.length >= expectedCount && pagesFetched > 0) {
        break
      }

      let builder = horizonServer.operations().forTransaction(hash).order(order).limit(pageSize)
      if (cursor && typeof builder.cursor === 'function') {
        builder = builder.cursor(cursor)
      }

      const resp = await builder.call()
      pagesFetched += 1
      const records = Array.isArray(resp?.records) ? resp.records : []
      if (records.length === 0) break

      const added = addRecords(records)
      const lastRecord = records[records.length - 1]
      const nextCursor =
        (lastRecord?.paging_token ? String(lastRecord.paging_token) : null) ||
        (lastRecord?.id ? String(lastRecord.id) : null)

      if (records.length < pageSize) break
      if (!nextCursor || nextCursor === cursor || added === 0) break
      cursor = nextCursor
    }

    const totalCount =
      expectedCount !== null ? Math.max(expectedCount, collected.length) : collected.length
    const complete = expectedCount !== null ? collected.length >= expectedCount : true
    const hasMore = !complete
    const nextCursor =
      hasMore && collected.length > 0
        ? collected[collected.length - 1].paging_token || collected[collected.length - 1].id || null
        : null

    return {
      success: true,
      hash,
      operations: collected,
      loadedCount: collected.length,
      totalCount,
      complete,
      truncated: !complete,
      hasMore,
      nextCursor,
      pagesFetched,
      duplicateCount,
      error: null,
    }
  } catch (err) {
    return {
      success: false,
      hash,
      operations: collected,
      loadedCount: collected.length,
      totalCount: expectedCount ?? collected.length,
      complete: false,
      truncated: collected.length > 0,
      hasMore: false,
      nextCursor: cursor,
      pagesFetched,
      duplicateCount,
      error: err.message,
    }
  }
}

/**
 * Retrieve complete transaction details and operations (paginated or full) (#159).
 */
export async function getTransactionDetail(hash, options = {}) {
  const horizonServer = options.horizonServer || server
  const accountAddress = options.accountAddress || null
  const fetchAll = options.fetchAll !== false && !options.cursor

  let txRecord = options.txRecord || null
  if (!txRecord && typeof horizonServer.transactions === 'function') {
    try {
      const txBuilder = horizonServer.transactions()
      if (typeof txBuilder.transaction === 'function') {
        txRecord = await txBuilder.transaction(hash).call()
      }
    } catch {
      txRecord = null
    }
  }

  const expectedCount =
    Number.isInteger(txRecord?.operation_count) && txRecord.operation_count >= 0
      ? txRecord.operation_count
      : Number.isInteger(options.expectedCount)
        ? options.expectedCount
        : null

  let opsResult
  if (fetchAll) {
    opsResult = await fetchAllTransactionOperations(hash, {
      horizonServer,
      pageSize: options.limit || DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT,
      order: options.order || 'asc',
      accountAddress,
      expectedCount,
    })
  } else {
    const page = await fetchTransactionOperations(hash, horizonServer, {
      limit: options.limit || DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT,
      cursor: options.cursor || null,
      order: options.order || 'asc',
      accountAddress,
      expectedCount,
    })
    opsResult = {
      success: !page.error,
      hash,
      operations: page.operations,
      loadedCount: page.loadedCount,
      totalCount: page.totalCount,
      complete: page.complete,
      truncated: page.truncated,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      duplicateCount: 0,
      error: page.error,
    }
  }

  if (opsResult.error) {
    return {
      success: false,
      hash,
      error: opsResult.error,
    }
  }

  const totalOperationCount =
    expectedCount !== null ? expectedCount : (opsResult.totalCount ?? opsResult.operations.length)
  const successful =
    txRecord?.successful !== undefined
      ? Boolean(txRecord.successful)
      : opsResult.operations[0]?.transaction_successful !== null &&
          opsResult.operations[0]?.transaction_successful !== undefined
        ? Boolean(opsResult.operations[0].transaction_successful)
        : true

  const operationSummary = summarizeTransactionOperations(opsResult.operations, {
    totalOperationCount,
    accountAddress,
    successful,
  })

  return {
    success: true,
    hash,
    ledger: txRecord?.ledger ?? null,
    createdAt: txRecord?.created_at ?? txRecord?.createdAt ?? null,
    created_at: txRecord?.created_at ?? txRecord?.createdAt ?? null,
    memo: txRecord?.memo ?? null,
    memo_type: txRecord?.memo_type ?? null,
    feeCharged: txRecord?.fee_charged ?? null,
    successful,
    operationCount: totalOperationCount,
    operation_count: totalOperationCount,
    loadedOperationCount: opsResult.operations.length,
    operationsComplete: opsResult.complete,
    operationsTruncated: opsResult.truncated,
    hasMoreOperations: opsResult.hasMore,
    nextOperationsCursor: opsResult.nextCursor,
    operationsContinuationUrl: opsResult.hasMore
      ? `/api/wallet/transactions/${hash}/operations${opsResult.nextCursor ? `?cursor=${encodeURIComponent(opsResult.nextCursor)}` : ''}`
      : null,
    operationsPagination: {
      complete: opsResult.complete,
      truncated: opsResult.truncated,
      hasMore: opsResult.hasMore,
      loadedCount: opsResult.operations.length,
      totalCount: totalOperationCount,
      nextCursor: opsResult.nextCursor,
      duplicateCount: opsResult.duplicateCount || 0,
    },
    operationSummary,
    operations: opsResult.operations,
    explorerUrl: explorerTxUrl(profile, hash),
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
export async function getTransactions(
  publicKey,
  limit = 10,
  cursor = null,
  order = 'desc',
  options = {}
) {
  try {
    const horizonServer = options.horizonServer || server
    let query = horizonServer.transactions().forAccount(publicKey).order(order).limit(limit)

    if (cursor) {
      query = query.cursor(cursor)
    }

    const txs = await query.call()

    const decorated = await mapWithConcurrency(
      txs.records,
      config.horizonOpsMaxConcurrency,
      async (tx) => {
        const expectedCount =
          Number.isInteger(tx.operation_count) && tx.operation_count >= 0
            ? tx.operation_count
            : null
        const opPage = await fetchTransactionOperations(tx.hash, horizonServer, {
          accountAddress: publicKey,
          expectedCount,
        })
        const { operations, error } = opPage

        if (error) {
          console.warn(`Failed to fetch operations for tx ${tx.hash}:`, error)
        }

        const totalOperationCount = expectedCount !== null ? expectedCount : operations.length
        const loadedOperationCount = operations.length
        const operationsComplete = !error && loadedOperationCount >= totalOperationCount
        const operationsTruncated = !error && loadedOperationCount < totalOperationCount
        const nextOperationsCursor =
          operationsTruncated && loadedOperationCount > 0
            ? operations[loadedOperationCount - 1].paging_token ||
              operations[loadedOperationCount - 1].id ||
              null
            : null
        const operationsContinuationUrl = operationsTruncated
          ? `/api/wallet/transactions/${tx.hash}/operations${nextOperationsCursor ? `?cursor=${encodeURIComponent(nextOperationsCursor)}&limit=${DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT}` : `?limit=${DEFAULT_TX_OPERATIONS_PREVIEW_LIMIT}`}`
          : null
        const successful = tx.successful !== undefined ? Boolean(tx.successful) : true
        const operationSummary = summarizeTransactionOperations(operations, {
          totalOperationCount,
          accountAddress: publicKey,
          successful,
          error,
        })

        return {
          hash: tx.hash,
          paging_token: tx.paging_token,
          ledger: tx.ledger,
          createdAt: tx.created_at,
          created_at: tx.created_at,
          memo: tx.memo || null,
          memo_type: tx.memo_type || null,
          feeCharged: tx.fee_charged,
          operationCount: totalOperationCount,
          operation_count: totalOperationCount,
          loadedOperationCount,
          operationsComplete,
          operationsTruncated,
          hasMoreOperations: operationsTruncated,
          nextOperationsCursor,
          operationsContinuationUrl,
          operationsPagination: {
            complete: operationsComplete,
            truncated: operationsTruncated,
            hasMore: operationsTruncated,
            loadedCount: loadedOperationCount,
            totalCount: totalOperationCount,
            nextCursor: nextOperationsCursor,
            continuationUrl: operationsContinuationUrl,
          },
          operationSummary,
          successful,
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
