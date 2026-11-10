/**
 * Unit tests for per-payer concurrent Stellar submission coordination (Issue #133).
 *
 * Covers:
 *  - Concurrent calls for one payer are coordinated sequentially without sequence collisions.
 *  - Different payer accounts progress independently in parallel.
 *  - Failed submissions release the queue and retain a structured outcome.
 *  - Any retry first resolves an uncertain prior submission and uses a bounded policy.
 */

import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { PayerSubmissionCoordinator, sendPayment } from '../src/stellar/wallet.js'

console.log('=== Issue #133: Concurrent Stellar Payer Submission Coordinator Tests ===')

const payerA = Keypair.random()
const payerB = Keypair.random()
const recipient = Keypair.random().publicKey()

function createStubHorizon({ initialSeqA = 100n, initialSeqB = 500n, submitHandler }) {
  const ledgerSeq = new Map([
    [payerA.publicKey(), initialSeqA],
    [payerB.publicKey(), initialSeqB],
  ])

  let inFlightCount = 0
  let maxConcurrentInFlight = 0
  const inFlightByPayer = new Map()
  const maxConcurrentByPayer = new Map()

  return {
    ledgerSeq,
    getStats() {
      return {
        maxConcurrentInFlight,
        maxConcurrentPayerA: maxConcurrentByPayer.get(payerA.publicKey()) || 0,
        maxConcurrentPayerB: maxConcurrentByPayer.get(payerB.publicKey()) || 0,
      }
    },
    async loadAccount(publicKey) {
      const current = ledgerSeq.get(publicKey) ?? 1n
      return {
        accountId: () => publicKey,
        sequenceNumber: () => String(current),
        incrementSequenceNumber: () => {
          ledgerSeq.set(publicKey, current + 1n)
        },
      }
    },
    async submitTransaction(tx) {
      const payerKey = tx.payerPublicKey
      inFlightCount += 1
      maxConcurrentInFlight = Math.max(maxConcurrentInFlight, inFlightCount)
      const payerActive = (inFlightByPayer.get(payerKey) || 0) + 1
      inFlightByPayer.set(payerKey, payerActive)
      maxConcurrentByPayer.set(
        payerKey,
        Math.max(maxConcurrentByPayer.get(payerKey) || 0, payerActive)
      )

      try {
        return await submitHandler(tx, ledgerSeq)
      } finally {
        inFlightCount -= 1
        inFlightByPayer.set(payerKey, (inFlightByPayer.get(payerKey) || 1) - 1)
      }
    },
  }
}

function stubBuildTransaction({ senderAccount, senderKeypair, amount, memo }) {
  const prevSeq = BigInt(senderAccount.sequenceNumber())
  const nextSeq = prevSeq + 1n
  const payerPublicKey = senderKeypair.publicKey()
  const txHash = `hash_${payerPublicKey.slice(0, 6)}_${nextSeq}_${memo || amount}`
  return {
    tx: {
      payerPublicKey,
      sequence: String(nextSeq),
      amount,
      memo,
      hash: () => Buffer.from(txHash, 'utf8'),
    },
    txHash,
    sequence: String(nextSeq),
  }
}

// 1. Concurrent calls for one payer are serialized with strictly increasing sequences, while different payers run in parallel
{
  const coordinator = new PayerSubmissionCoordinator({ waitTimeoutMs: 5000, maxRetries: 1 })
  assert.equal(coordinator.getState().deploymentBoundary, 'single-process')

  const submittedOrder = []
  const stubHorizon = createStubHorizon({
    submitHandler: async (tx, ledgerSeq) => {
      await new Promise((r) => setTimeout(r, 25))
      const expectedSeq = (ledgerSeq.get(tx.payerPublicKey) ?? 0n) + 1n
      const actualSeq = BigInt(tx.sequence)
      if (actualSeq !== expectedSeq) {
        const err = new Error(`tx_bad_seq: expected ${expectedSeq}, got ${actualSeq}`)
        err.extras = { result_codes: { transaction: 'tx_bad_seq' } }
        throw err
      }
      ledgerSeq.set(tx.payerPublicKey, actualSeq)
      submittedOrder.push({ payer: tx.payerPublicKey, seq: tx.sequence, memo: tx.memo })
      return { hash: `confirmed_${tx.sequence}`, ledger: 12345 }
    },
  })

  // Launch 3 concurrent payments from payerA and 2 concurrent payments from payerB
  const results = await Promise.all([
    sendPayment(payerA.secret(), recipient, '0.01', 'A-1', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
    sendPayment(payerA.secret(), recipient, '0.02', 'A-2', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
    sendPayment(payerB.secret(), recipient, '0.05', 'B-1', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
    sendPayment(payerA.secret(), recipient, '0.03', 'A-3', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
    sendPayment(payerB.secret(), recipient, '0.04', 'B-2', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
  ])

  for (const res of results) {
    assert.equal(res.success, true)
    assert.equal(res.outcome, 'confirmed')
  }

  // Payer A sequences must be strictly 101, 102, 103
  assert.deepEqual(
    [results[0].sequence, results[1].sequence, results[3].sequence],
    ['101', '102', '103']
  )
  // Payer B sequences must be strictly 501, 502
  assert.deepEqual([results[2].sequence, results[4].sequence], ['501', '502'])

  const stats = stubHorizon.getStats()
  assert.equal(stats.maxConcurrentPayerA, 1, 'Same payer must never have >1 submission in flight')
  assert.equal(stats.maxConcurrentPayerB, 1, 'Same payer must never have >1 submission in flight')
  assert.equal(
    stats.maxConcurrentInFlight,
    2,
    'Different payer accounts must progress concurrently in parallel'
  )
  console.log(
    '✓ Concurrent calls for one payer serialized without sequence collisions; distinct payers ran in parallel'
  )
}

// 2. Rejected transaction releases queue for subsequent callers and retains structured outcome
{
  const coordinator = new PayerSubmissionCoordinator({ waitTimeoutMs: 5000, maxRetries: 0 })
  let callIndex = 0
  const stubHorizon = createStubHorizon({
    submitHandler: async (tx, ledgerSeq) => {
      callIndex += 1
      if (callIndex === 1) {
        const err = new Error('Transaction rejected: tx_insufficient_balance')
        err.response = {
          status: 400,
          data: { extras: { result_codes: { transaction: 'tx_insufficient_balance' } } },
        }
        throw err
      }
      const nextSeq = (ledgerSeq.get(tx.payerPublicKey) ?? 0n) + 1n
      ledgerSeq.set(tx.payerPublicKey, nextSeq)
      return { hash: `ok_${nextSeq}`, ledger: 200 }
    },
  })

  const [first, second] = await Promise.all([
    sendPayment(payerA.secret(), recipient, '9999.00', 'reject-me', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
    sendPayment(payerA.secret(), recipient, '0.01', 'succeed-after-reject', {
      coordinator,
      horizonServer: stubHorizon,
      buildTransaction: stubBuildTransaction,
    }),
  ])

  assert.equal(first.success, false)
  assert.equal(first.outcome, 'rejected')
  assert.equal(first.code, 'TX_INSUFFICIENT_BALANCE')

  assert.equal(second.success, true)
  assert.equal(second.outcome, 'confirmed')
  assert.equal(second.sequence, '101')
  console.log('✓ Rejected submission released the payer queue and returned structured outcome')
}

// 3. Uncertain prior submission is reconciled before retry (settled vs not-settled vs unresolved)
{
  const coordinator = new PayerSubmissionCoordinator({ waitTimeoutMs: 5000, maxRetries: 1 })

  // Case 3A: Timeout on submit, reconciliation confirms the tx DID land on ledger -> no duplicate submit!
  let submitCallsA = 0
  const horizon3A = createStubHorizon({
    submitHandler: async () => {
      submitCallsA += 1
      const err = new Error('Horizon request timed out')
      err.code = 'ETIMEDOUT'
      throw err
    },
  })

  const reconciledRes = await sendPayment(payerA.secret(), recipient, '0.01', 'uncertain-settled', {
    coordinator,
    horizonServer: horizon3A,
    buildTransaction: stubBuildTransaction,
    reconcileTx: async ({ txHash }) => ({
      settled: true,
      txHash,
      ledger: 999,
    }),
  })
  assert.equal(reconciledRes.success, true)
  assert.equal(reconciledRes.reconciled, true)
  assert.equal(reconciledRes.outcome, 'confirmed')
  assert.equal(
    submitCallsA,
    1,
    'Must not submit a second transaction when reconciliation confirms settlement'
  )

  // Case 3B: Timeout on first submit, reconciliation confirms tx did NOT land -> retries once with fresh sequence
  let submitCallsB = 0
  const horizon3B = createStubHorizon({
    submitHandler: async (tx, ledgerSeq) => {
      submitCallsB += 1
      if (submitCallsB === 1) {
        const err = new Error('Gateway timeout')
        err.status = 504
        throw err
      }
      const nextSeq = (ledgerSeq.get(tx.payerPublicKey) ?? 0n) + 1n
      ledgerSeq.set(tx.payerPublicKey, nextSeq)
      return { hash: `retried_${nextSeq}`, ledger: 1001 }
    },
  })

  const retriedRes = await sendPayment(
    payerA.secret(),
    recipient,
    '0.01',
    'uncertain-not-settled',
    {
      coordinator,
      horizonServer: horizon3B,
      buildTransaction: stubBuildTransaction,
      reconcileTx: async () => ({ settled: false }),
    }
  )
  assert.equal(retriedRes.success, true)
  assert.equal(retriedRes.outcome, 'confirmed')
  assert.equal(retriedRes.attempts, 2)
  assert.equal(submitCallsB, 2)

  // Case 3C: Timeout on first submit, reconciliation is unresolved ('unknown') -> refuses to retry and flags reconciliationRequired
  let submitCallsC = 0
  const horizon3C = createStubHorizon({
    submitHandler: async () => {
      submitCallsC += 1
      const err = new Error('Socket hang up')
      err.code = 'ECONNRESET'
      throw err
    },
  })

  const unresolvedRes = await sendPayment(payerA.secret(), recipient, '0.01', 'uncertain-unknown', {
    coordinator,
    horizonServer: horizon3C,
    buildTransaction: stubBuildTransaction,
    reconcileTx: async () => ({ settled: 'unknown' }),
  })
  assert.equal(unresolvedRes.success, false)
  assert.equal(unresolvedRes.outcome, 'uncertain')
  assert.equal(unresolvedRes.reconciliationRequired, true)
  assert.equal(submitCallsC, 1, 'Must not retry when prior submission outcome remains uncertain')

  console.log(
    '✓ Uncertain submissions reconciled before retry (settled, not-settled, and unresolved paths)'
  )
}

// 4. Bounded waiting timeout when a previous submission is delayed beyond waitTimeoutMs
{
  const coordinator = new PayerSubmissionCoordinator({ waitTimeoutMs: 30, maxRetries: 0 })
  const slowHorizon = createStubHorizon({
    submitHandler: async (tx, ledgerSeq) => {
      await new Promise((r) => setTimeout(r, 80))
      const nextSeq = (ledgerSeq.get(tx.payerPublicKey) ?? 0n) + 1n
      ledgerSeq.set(tx.payerPublicKey, nextSeq)
      return { hash: `slow_${nextSeq}`, ledger: 300 }
    },
  })

  const [slowFirst, timedOutSecond] = await Promise.all([
    sendPayment(payerA.secret(), recipient, '0.01', 'slow-1', {
      coordinator,
      horizonServer: slowHorizon,
      buildTransaction: stubBuildTransaction,
      waitTimeoutMs: 500,
    }),
    sendPayment(payerA.secret(), recipient, '0.01', 'wait-timeout-2', {
      coordinator,
      horizonServer: slowHorizon,
      buildTransaction: stubBuildTransaction,
      waitTimeoutMs: 20,
    }),
  ])

  assert.equal(slowFirst.success, true)
  assert.equal(timedOutSecond.success, false)
  assert.equal(timedOutSecond.code, 'PAYER_QUEUE_TIMEOUT')

  // Queue recovers after slowFirst completes
  const thirdAfterRecovery = await sendPayment(payerA.secret(), recipient, '0.01', 'after-slow', {
    coordinator,
    horizonServer: slowHorizon,
    buildTransaction: stubBuildTransaction,
    waitTimeoutMs: 500,
  })
  assert.equal(thirdAfterRecovery.success, true)
  console.log('✓ Bounded queue wait timeout and subsequent queue recovery verified')
}

console.log('=== All Issue #133 tests passed ===')
