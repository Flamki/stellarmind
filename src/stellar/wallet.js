import {
  Keypair,
  Horizon,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
} from '@stellar/stellar-sdk'
import { config } from '../config.js'

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
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
export function operationsCacheKey(hash, horizonServer = server, profile = config.network) {
  const endpoint =
    horizonServer?.serverURL || horizonServer?.serverUrl || horizonServer?.url || HORIZON_URL
  return `${profile}|${endpoint}|${hash}`
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
 */
export async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey)
    return account.balances.map((b) => ({
      asset: b.asset_type === 'native' ? 'XLM' : `${b.asset_code}`,
      balance: b.balance,
      issuer: b.asset_issuer || null,
    }))
  } catch (err) {
    console.error(`Failed to load balance for ${publicKey}:`, err.message)
    return []
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
      networkPassphrase: Networks.TESTNET,
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
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
    }
  } catch (err) {
    console.error('Payment failed:', err.message)
    return { success: false, error: err.message }
  }
}

/**
 * Fund a wallet via Friendbot (testnet only)
 */
export async function fundWithFriendbot(publicKey) {
  try {
    const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`)
    const data = await response.json()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Get recent transactions for a wallet
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
          explorerUrl: `https://stellar.expert/explorer/testnet/tx/${tx.hash}`,
        }
      }
    )

    return decorated
  } catch (err) {
    console.error('Failed to fetch transactions:', err.message)
    return []
  }
}
