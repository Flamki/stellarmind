import { Keypair, Horizon, TransactionBuilder, Operation, Asset, Memo } from '@stellar/stellar-sdk'
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
 * Classify a Horizon / network submission error into a structured outcome:
 *  - 'rejected': known terminal failure (e.g. tx_bad_seq, tx_insufficient_balance, HTTP 400)
 *  - 'uncertain': timeout or transport drop where the transaction may or may not have landed
 */
export function classifySubmissionError(err) {
  const status = err?.response?.status ?? err?.status ?? null
  const resultCodes = err?.response?.data?.extras?.result_codes || err?.extras?.result_codes || null
  const txCode = resultCodes?.transaction || null
  const msg = String(err?.message || 'Submission failed')

  if (
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE' ||
    status === 504 ||
    status === 502 ||
    status === 503 ||
    /timeout|timed out|socket hang up|network/i.test(msg)
  ) {
    return {
      outcome: 'uncertain',
      code: 'SUBMISSION_UNCERTAIN',
      txCode,
      retryableAfterReconcile: true,
      error: msg,
    }
  }

  if (txCode === 'tx_bad_seq' || /tx_bad_seq|bad_seq/i.test(msg)) {
    return {
      outcome: 'rejected',
      code: 'TX_BAD_SEQ',
      txCode: 'tx_bad_seq',
      retryableWithFreshSequence: true,
      error: msg,
    }
  }

  return {
    outcome: 'rejected',
    code: txCode ? txCode.toUpperCase() : status === 400 ? 'TX_REJECTED' : 'SUBMISSION_FAILED',
    txCode,
    retryableWithFreshSequence: false,
    error: msg,
  }
}

/**
 * Per-account Stellar transaction submission coordinator (Issue #133).
 *
 * Serializes `loadAccount` + transaction build + `submitTransaction` per payer
 * public key so concurrent orchestrations sharing the payer wallet acquire
 * strictly increasing sequence numbers without colliding, while allowing
 * distinct payer accounts to progress in parallel.
 *
 * Explicit deployment boundary: coordinates submissions within a single Node.js
 * process (`deploymentBoundary: 'single-process'`).
 */
export class PayerSubmissionCoordinator {
  constructor(options = {}) {
    this.waitTimeoutMs = Math.max(50, Number(options.waitTimeoutMs ?? 15000))
    this.maxQueuePerAccount = Math.max(1, Number(options.maxQueuePerAccount ?? 50))
    this.maxRetries = Math.max(0, Number(options.maxRetries ?? 1))
    this._queues = new Map() // payerPublicKey -> { active: boolean, waiters: Array }
  }

  getState() {
    const accounts = {}
    for (const [account, state] of this._queues.entries()) {
      accounts[account] = {
        active: state.active,
        queued: state.waiters.length,
      }
    }
    return {
      deploymentBoundary: 'single-process',
      singleProcessOnly: true,
      waitTimeoutMs: this.waitTimeoutMs,
      maxQueuePerAccount: this.maxQueuePerAccount,
      maxRetries: this.maxRetries,
      accounts,
    }
  }

  /**
   * Acquire exclusive submission turn for `payerPublicKey` with bounded wait timeout,
   * execute `taskFn`, and always release the queue slot in `finally`.
   */
  async runExclusive(payerPublicKey, taskFn, options = {}) {
    const key = String(payerPublicKey || 'default')
    const waitTimeoutMs = Math.max(10, Number(options.waitTimeoutMs ?? this.waitTimeoutMs))

    let state = this._queues.get(key)
    if (!state) {
      state = { active: false, waiters: [] }
      this._queues.set(key, state)
    }

    if (state.active) {
      if (state.waiters.length >= this.maxQueuePerAccount) {
        const err = new Error(
          `Payer submission queue full for ${key} (${state.waiters.length} waiting)`
        )
        err.code = 'PAYER_QUEUE_FULL'
        err.outcome = 'rejected'
        throw err
      }

      await new Promise((resolve, reject) => {
        const waiter = {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          },
        }
        const timer = setTimeout(() => {
          const idx = state.waiters.indexOf(waiter)
          if (idx !== -1) state.waiters.splice(idx, 1)
          const err = new Error(
            `Timed out after ${waitTimeoutMs}ms waiting for payer submission queue (${key})`
          )
          err.code = 'PAYER_QUEUE_TIMEOUT'
          err.outcome = 'rejected'
          reject(err)
        }, waitTimeoutMs)

        state.waiters.push(waiter)
      })
    } else {
      state.active = true
    }

    try {
      return await taskFn()
    } finally {
      if (state.waiters.length > 0) {
        const nextWaiter = state.waiters.shift()
        nextWaiter.resolve()
      } else {
        state.active = false
        this._queues.delete(key)
      }
    }
  }
}

export const defaultSubmissionCoordinator = new PayerSubmissionCoordinator()

/**
 * Send XLM payment between two wallets with per-payer sequence coordination,
 * structured failure outcomes, and reconciliation-before-retry (Issue #133).
 */
export async function sendPayment(senderSecret, recipientPublic, amount, memo = '', options = {}) {
  const coordinator = options.coordinator || defaultSubmissionCoordinator
  const horizonServer = options.horizonServer || server
  const networkPassphrase = options.networkPassphrase || profile.passphrase
  const maxRetries =
    options.maxRetries !== undefined
      ? Math.max(0, Number(options.maxRetries))
      : coordinator.maxRetries
  const reconcileTx = options.reconcileTx

  let senderKeypair
  try {
    senderKeypair = options.senderKeypair || Keypair.fromSecret(senderSecret)
  } catch (err) {
    return {
      success: false,
      outcome: 'rejected',
      code: 'INVALID_SENDER_SECRET',
      error: err.message,
      attempts: 0,
    }
  }

  const payerPublicKey = senderKeypair.publicKey()

  try {
    return await coordinator.runExclusive(
      payerPublicKey,
      async () => {
        let attempts = 0
        const maxAttempts = 1 + maxRetries

        while (attempts < maxAttempts) {
          attempts += 1
          let senderAccount
          try {
            senderAccount = await horizonServer.loadAccount(payerPublicKey)
          } catch (loadErr) {
            return {
              success: false,
              outcome: 'rejected',
              code: 'ACCOUNT_LOAD_FAILED',
              error: loadErr.message,
              payerPublicKey,
              attempts,
            }
          }

          let tx
          let candidateTxHash = null
          let sequenceUsed = null
          try {
            if (typeof options.buildTransaction === 'function') {
              const built = await options.buildTransaction({
                senderAccount,
                senderKeypair,
                recipientPublic,
                amount: String(amount),
                memo,
                networkPassphrase,
              })
              tx = built.tx || built
              candidateTxHash =
                built.txHash || (typeof tx.hash === 'function' ? tx.hash().toString('hex') : null)
              sequenceUsed =
                built.sequence || senderAccount.sequenceNumber?.() || senderAccount.sequence || null
            } else {
              const txBuilder = new TransactionBuilder(senderAccount, {
                fee: '100',
                networkPassphrase,
              })

              txBuilder.addOperation(
                Operation.payment({
                  destination: recipientPublic,
                  asset: Asset.native(),
                  amount: String(amount),
                })
              )

              if (memo) {
                txBuilder.addMemo(new Memo('text', memo.slice(0, 28)))
              }

              txBuilder.setTimeout(30)
              tx = txBuilder.build()
              tx.sign(senderKeypair)
              candidateTxHash = tx.hash().toString('hex')
              sequenceUsed = tx.sequence || senderAccount.sequenceNumber?.() || null
            }
          } catch (buildErr) {
            return {
              success: false,
              outcome: 'rejected',
              code: 'TX_BUILD_FAILED',
              error: buildErr.message,
              payerPublicKey,
              attempts,
            }
          }

          try {
            const result = await horizonServer.submitTransaction(tx)
            const resolvedHash = result.hash || candidateTxHash
            return {
              success: true,
              outcome: 'confirmed',
              code: 'SUBMITTED',
              txHash: resolvedHash,
              ledger: result.ledger,
              sequence: sequenceUsed,
              payerPublicKey,
              attempts,
              explorerUrl: explorerTxUrl(profile, resolvedHash),
            }
          } catch (submitErr) {
            const classified = classifySubmissionError(submitErr)

            // If outcome is uncertain, we MUST reconcile the prior submission before
            // deciding whether a retry is safe.
            if (classified.outcome === 'uncertain') {
              let reconciliation = null
              if (typeof reconcileTx === 'function') {
                try {
                  reconciliation = await reconcileTx({
                    txHash: candidateTxHash,
                    payerPublicKey,
                    sequence: sequenceUsed,
                    attempt: attempts,
                  })
                } catch {
                  reconciliation = { settled: 'unknown' }
                }
              } else if (candidateTxHash && typeof horizonServer.transactions === 'function') {
                try {
                  const txRecord = await horizonServer
                    .transactions()
                    .transaction(candidateTxHash)
                    .call()
                  if (txRecord && txRecord.successful !== false) {
                    reconciliation = {
                      settled: true,
                      txHash: txRecord.hash || candidateTxHash,
                      ledger: txRecord.ledger,
                    }
                  }
                } catch (lookupErr) {
                  if (lookupErr?.response?.status === 404 || lookupErr?.status === 404) {
                    reconciliation = { settled: false }
                  } else {
                    reconciliation = { settled: 'unknown' }
                  }
                }
              }

              if (reconciliation?.settled === true) {
                const confirmedHash = reconciliation.txHash || candidateTxHash
                return {
                  success: true,
                  outcome: 'confirmed',
                  code: 'RECONCILED_AFTER_UNCERTAIN_SUBMIT',
                  reconciled: true,
                  txHash: confirmedHash,
                  ledger: reconciliation.ledger ?? null,
                  sequence: sequenceUsed,
                  payerPublicKey,
                  attempts,
                  explorerUrl: explorerTxUrl(profile, confirmedHash),
                }
              }

              if (reconciliation?.settled === false && attempts < maxAttempts) {
                // Prior attempt is confirmed NOT to have settled; safe to retry with a fresh sequence
                continue
              }

              // Outcome remains uncertain (or retry budget exhausted): do NOT retry
              return {
                success: false,
                outcome: 'uncertain',
                code: classified.code,
                reconciliationRequired: true,
                txHash: candidateTxHash,
                sequence: sequenceUsed,
                payerPublicKey,
                attempts,
                error: classified.error,
              }
            }

            // Known terminal rejection: retry only if retryableWithFreshSequence (e.g. tx_bad_seq) and within retry budget
            if (classified.retryableWithFreshSequence && attempts < maxAttempts) {
              continue
            }

            return {
              success: false,
              outcome: 'rejected',
              code: classified.code,
              txCode: classified.txCode,
              txHash: candidateTxHash,
              sequence: sequenceUsed,
              payerPublicKey,
              attempts,
              error: classified.error,
            }
          }
        }
      },
      { waitTimeoutMs: options.waitTimeoutMs }
    )
  } catch (queueErr) {
    return {
      success: false,
      outcome: queueErr.outcome || 'rejected',
      code: queueErr.code || 'PAYER_QUEUE_ERROR',
      payerPublicKey,
      attempts: 0,
      error: queueErr.message,
    }
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
