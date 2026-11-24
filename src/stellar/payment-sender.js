/**
 * Direct XLM payment from a configured payer, coordinated per account.
 *
 * Each call runs inside the submission coordinator, so for one payer account
 * only one transaction is being built and submitted at a time and every one
 * loads a FRESH sequence number. Calls for other accounts are independent.
 *
 * Outcomes are structured, not just thrown strings:
 *   confirmed  the ledger applied it (`success: true`)
 *   rejected   Horizon refused it with result codes; nothing was applied
 *   unknown    the submission may or may not have been applied (timeout, 5xx,
 *              lost response); `txHash` identifies it for later reconciliation
 *   failed     could not be attempted (account load failed, queue full, ...)
 *
 * An `unknown` submission is resolved by looking its hash up before anything
 * else is submitted for that account, and a retry only happens once the prior
 * attempt is known not to have been applied. Retries are bounded by
 * `maxAttempts`.
 *
 * Single-process boundary: see submission-coordinator.js.
 */

import { Asset, Keypair, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { SubmissionQueueError } from './submission-coordinator.js'

const TX_TIMEOUT_SECONDS = 30
// A transaction past its max time can never be applied; wait this long past it
// (ledger close jitter) before treating "not found" as "not applied".
const EXPIRY_GRACE_MS = 5000

function resultCodesOf(err) {
  return err?.response?.data?.extras?.result_codes || null
}

/** True when Horizon answered with a definitive rejection (it carries result codes). */
function isDefinitiveRejection(err) {
  const status = err?.response?.status
  return Boolean(resultCodesOf(err)) && status >= 400 && status < 500
}

function isBadSequence(err) {
  return resultCodesOf(err)?.transaction === 'tx_bad_seq'
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} deps
 * @param {(publicKey: string) => Promise<import('@stellar/stellar-sdk').Account>} deps.loadAccount
 * @param {(tx: object) => Promise<{hash: string, ledger?: number}>} deps.submitTransaction
 * @param {(hash: string) => Promise<{found: boolean, ledger?: number}>} deps.lookupTransaction
 *        resolves `{found:false}` for a hash the network has not seen; throws if it cannot tell
 * @param {{run: Function}} deps.coordinator
 * @param {string} deps.passphrase
 * @param {(hash: string) => string} [deps.explorerUrl]
 * @param {number} [deps.maxAttempts] total submissions per call, including the first
 * @param {number} [deps.resolveChecks] lookups spent resolving one uncertain submission
 * @param {number} [deps.resolveDelayMs]
 */
export function createPaymentSender({
  loadAccount,
  submitTransaction,
  lookupTransaction,
  coordinator,
  passphrase,
  explorerUrl = () => undefined,
  maxAttempts = 2,
  resolveChecks = 3,
  resolveDelayMs = 2000,
  now = Date.now,
  sleep = defaultSleep,
  logger = console,
}) {
  /** account -> { hash, expiresAt } of a submission whose outcome is not known yet. */
  const uncertain = new Map()

  /**
   * Decide what happened to a prior uncertain submission.
   * Returns 'confirmed' (with ledger), 'not_applied', or 'unresolved'.
   */
  async function resolve(record) {
    for (let check = 0; check < resolveChecks; check += 1) {
      try {
        const found = await lookupTransaction(record.hash)
        if (found?.found) return { state: 'confirmed', ledger: found.ledger }
        if (now() >= record.expiresAt + EXPIRY_GRACE_MS) return { state: 'not_applied' }
      } catch (err) {
        logger.warn?.(`Could not look up transaction ${record.hash}: ${err.message}`)
      }
      if (check < resolveChecks - 1) await sleep(resolveDelayMs)
    }
    return { state: 'unresolved' }
  }

  function outcomeOf(base, extra) {
    return { ...base, ...extra }
  }

  async function attemptPayments(senderKeypair, recipient, amount, memo, queueWaitMs) {
    const account = senderKeypair.publicKey()
    const base = { queueWaitMs, attempts: 0 }

    // 1. Settle any earlier uncertain submission before building a new one.
    const prior = uncertain.get(account)
    if (prior) {
      const resolved = await resolve(prior)
      if (resolved.state === 'unresolved') {
        return outcomeOf(base, {
          success: false,
          outcome: 'unknown',
          errorType: 'PRIOR_SUBMISSION_UNRESOLVED',
          error: `Earlier submission ${prior.hash} for this account is still unresolved; not submitting another`,
          txHash: prior.hash,
        })
      }
      uncertain.delete(account)
      // 'confirmed' or 'not_applied' both free the account; the fresh sequence
      // loaded below reflects whichever it was.
    }

    let lastFailure = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      base.attempts = attempt

      let tx
      try {
        const loaded = await loadAccount(account)
        const builder = new TransactionBuilder(loaded, {
          fee: '100',
          networkPassphrase: passphrase,
        })
        builder.addOperation(
          Operation.payment({
            destination: recipient,
            asset: Asset.native(),
            amount: String(amount),
          })
        )
        if (memo) builder.addMemo(new Memo('text', memo.slice(0, 28)))
        builder.setTimeout(TX_TIMEOUT_SECONDS)
        tx = builder.build()
        tx.sign(senderKeypair)
      } catch (err) {
        // Nothing was submitted, so nothing can be uncertain.
        return outcomeOf(base, {
          success: false,
          outcome: 'failed',
          errorType: 'ACCOUNT_LOAD_FAILED',
          error: err.message,
        })
      }

      const txHash = tx.hash().toString('hex')
      const expiresAt = now() + TX_TIMEOUT_SECONDS * 1000

      try {
        const result = await submitTransaction(tx)
        return outcomeOf(base, {
          success: true,
          outcome: 'confirmed',
          txHash: result.hash || txHash,
          ledger: result.ledger,
          explorerUrl: explorerUrl(result.hash || txHash),
        })
      } catch (err) {
        if (isDefinitiveRejection(err)) {
          lastFailure = outcomeOf(base, {
            success: false,
            outcome: 'rejected',
            errorType: isBadSequence(err) ? 'BAD_SEQUENCE' : 'REJECTED',
            error: err.message,
            resultCodes: resultCodesOf(err),
            txHash,
          })
          // A stale sequence is the one rejection a fresh load can fix.
          if (isBadSequence(err) && attempt < maxAttempts) continue
          return lastFailure
        }

        // No definitive answer: it may have been applied.
        const record = { hash: txHash, expiresAt }
        const resolved = await resolve(record)
        if (resolved.state === 'confirmed') {
          return outcomeOf(base, {
            success: true,
            outcome: 'confirmed',
            reconciled: true,
            txHash,
            ledger: resolved.ledger,
            explorerUrl: explorerUrl(txHash),
          })
        }
        if (resolved.state === 'unresolved') {
          uncertain.set(account, record)
          return outcomeOf(base, {
            success: false,
            outcome: 'unknown',
            errorType: 'SUBMISSION_UNCERTAIN',
            error: err.message,
            txHash,
          })
        }
        // Known not to have been applied: a retry cannot double-pay.
        lastFailure = outcomeOf(base, {
          success: false,
          outcome: 'failed',
          errorType: 'SUBMISSION_FAILED',
          error: err.message,
          txHash,
        })
      }
    }
    return lastFailure
  }

  /** Same signature and `{success, txHash, ...}` shape as the old `sendPayment`. */
  async function sendPayment(senderSecret, recipientPublic, amount, memo = '') {
    let senderKeypair
    try {
      senderKeypair = Keypair.fromSecret(senderSecret)
    } catch (err) {
      return { success: false, outcome: 'failed', errorType: 'INVALID_SECRET', error: err.message }
    }
    try {
      return await coordinator.run(senderKeypair.publicKey(), ({ waitedMs }) =>
        attemptPayments(senderKeypair, recipientPublic, amount, memo, waitedMs)
      )
    } catch (err) {
      if (err instanceof SubmissionQueueError) {
        return {
          success: false,
          outcome: 'failed',
          errorType: err.code === 'queue_full' ? 'QUEUE_FULL' : 'QUEUE_WAIT_TIMEOUT',
          error: err.message,
        }
      }
      return { success: false, outcome: 'failed', errorType: 'UNEXPECTED', error: err.message }
    }
  }

  return { sendPayment }
}
