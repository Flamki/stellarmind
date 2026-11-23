/**
 * Per-account submission coordination (#133).
 *
 * Network-free: account loading, submission and transaction lookup are stubbed,
 * but transactions are built and signed by the real Stellar SDK so sequence
 * numbers are the real thing.
 *
 *   node tests/submission-coordinator.test.js
 */

import assert from 'node:assert'
import { Account, Keypair } from '@stellar/stellar-sdk'
import { createSubmissionCoordinator } from '../src/stellar/submission-coordinator.js'
import { createPaymentSender } from '../src/stellar/payment-sender.js'

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ── coordinator ──────────────────────────────────────────────────────────────

await test('same account runs one at a time, in order, without dropping any', async () => {
  const coordinator = createSubmissionCoordinator({ maxQueueDepth: 50 })
  let active = 0
  let maxActive = 0
  const order = []
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      coordinator.run('GA', async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await delay(2)
        order.push(i)
        active -= 1
        return i
      })
    )
  )
  assert.strictEqual(maxActive, 1)
  assert.deepStrictEqual(order, [...Array(20).keys()])
  assert.deepStrictEqual(results, [...Array(20).keys()])
  assert.strictEqual(coordinator.depth('GA'), 0)
})

await test('different accounts progress independently', async () => {
  const coordinator = createSubmissionCoordinator()
  const gate = deferred()
  const events = []
  const slow = coordinator.run('GA', async () => {
    await gate.promise
    events.push('A')
  })
  const fast = coordinator.run('GB', async () => {
    events.push('B')
  })
  await fast
  assert.deepStrictEqual(events, ['B'])
  gate.resolve()
  await slow
  assert.deepStrictEqual(events, ['B', 'A'])
})

await test('a failing task releases the queue and keeps a structured outcome', async () => {
  const coordinator = createSubmissionCoordinator()
  const failing = coordinator.run('GA', async () => {
    const err = new Error('boom')
    err.code = 'E_BOOM'
    throw err
  })
  const next = coordinator.run('GA', async () => 'recovered')
  await assert.rejects(failing, /boom/)
  assert.strictEqual(await next, 'recovered')
  assert.strictEqual(coordinator.lastOutcome('GA').status, 'ok')

  await assert.rejects(coordinator.run('GA', () => Promise.reject(new Error('again'))))
  const outcome = coordinator.lastOutcome('GA')
  assert.strictEqual(outcome.status, 'error')
  assert.strictEqual(outcome.error, 'again')
  assert.strictEqual(coordinator.depth('GA'), 0)
})

await test('a synchronous throw also releases the queue', async () => {
  const coordinator = createSubmissionCoordinator()
  await assert.rejects(
    coordinator.run('GA', () => {
      throw new Error('sync')
    }),
    /sync/
  )
  assert.strictEqual(await coordinator.run('GA', async () => 'ok'), 'ok')
})

await test('a full queue rejects with queue_full instead of growing', async () => {
  const coordinator = createSubmissionCoordinator({ maxQueueDepth: 2 })
  const gate = deferred()
  const first = coordinator.run('GA', () => gate.promise)
  const second = coordinator.run('GA', async () => 'second')
  await assert.rejects(
    coordinator.run('GA', async () => 'third'),
    (err) => err.code === 'queue_full' && err.maxQueueDepth === 2
  )
  gate.resolve()
  await first
  assert.strictEqual(await second, 'second')
  // Another account is not affected by this account's full queue.
  assert.strictEqual(await coordinator.run('GB', async () => 'b'), 'b')
})

await test('waiting is bounded: a waiter times out and the running task is untouched', async () => {
  const coordinator = createSubmissionCoordinator({ maxWaitMs: 20 })
  const gate = deferred()
  const running = coordinator.run('GA', () => gate.promise.then(() => 'done'))
  await assert.rejects(
    coordinator.run('GA', async () => 'never'),
    (err) => err.code === 'queue_wait_timeout' && err.maxWaitMs === 20
  )
  assert.strictEqual(coordinator.depth('GA'), 1)
  gate.resolve()
  assert.strictEqual(await running, 'done')
  assert.strictEqual(await coordinator.run('GA', async () => 'after'), 'after')
})

// ── payment sender ───────────────────────────────────────────────────────────

const RECIPIENT = Keypair.random().publicKey()

/** A stub ledger: one sequence counter per account, like Horizon's loadAccount. */
function makeLedger({ startSequence = 100n } = {}) {
  const sequences = new Map()
  const state = {
    loads: [],
    submitted: [],
    activeSubmits: 0,
    maxActiveSubmits: 0,
    submitDelayMs: 0,
    submitImpl: null,
    lookupImpl: async () => ({ found: false }),
    lookups: 0,
  }
  const deps = {
    loadAccount: async (publicKey) => {
      await delay(1)
      const seq = sequences.get(publicKey) ?? startSequence
      state.loads.push({ publicKey, sequence: seq })
      return new Account(publicKey, String(seq))
    },
    submitTransaction: async (tx) => {
      state.activeSubmits += 1
      state.maxActiveSubmits = Math.max(state.maxActiveSubmits, state.activeSubmits)
      try {
        if (state.submitDelayMs) await delay(state.submitDelayMs)
        if (state.submitImpl) await state.submitImpl(tx, state)
        // Horizon rejects a sequence that is not exactly current + 1.
        const current = sequences.get(tx.source) ?? startSequence
        if (BigInt(tx.sequence) !== current + 1n) {
          const err = new Error('Transaction failed')
          err.response = {
            status: 400,
            data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } },
          }
          throw err
        }
        sequences.set(tx.source, BigInt(tx.sequence))
        state.submitted.push({ source: tx.source, sequence: BigInt(tx.sequence) })
        return { hash: tx.hash().toString('hex'), ledger: 1000 + state.submitted.length }
      } finally {
        state.activeSubmits -= 1
      }
    },
    lookupTransaction: async (hash) => {
      state.lookups += 1
      return state.lookupImpl(hash, state)
    },
  }
  return { state, deps, sequences }
}

function makeSender(ledger, overrides = {}) {
  return createPaymentSender({
    ...ledger.deps,
    coordinator: createSubmissionCoordinator(),
    passphrase: 'Test SDF Network ; September 2015',
    sleep: async () => {},
    logger: { warn() {} },
    ...overrides,
  })
}

const rejection = (code) => {
  const err = new Error('Transaction failed')
  err.response = { status: 400, data: { extras: { result_codes: { transaction: code } } } }
  return err
}

await test('concurrent payments from one payer all succeed with consecutive sequences', async () => {
  const ledger = makeLedger()
  const { sendPayment } = makeSender(ledger)
  const payer = Keypair.random()
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => sendPayment(payer.secret(), RECIPIENT, '0.01', `pay:${i}`))
  )
  assert.ok(
    results.every((r) => r.success && r.outcome === 'confirmed'),
    JSON.stringify(results)
  )
  assert.strictEqual(ledger.state.maxActiveSubmits, 1)
  assert.deepStrictEqual(
    ledger.state.submitted.map((s) => s.sequence),
    Array.from({ length: 12 }, (_, i) => 101n + BigInt(i))
  )
  // Every payment loaded a fresh sequence after the previous one finished.
  assert.deepStrictEqual(
    ledger.state.loads.map((l) => l.sequence),
    Array.from({ length: 12 }, (_, i) => 100n + BigInt(i))
  )
  assert.strictEqual(new Set(results.map((r) => r.txHash)).size, 12)
})

await test('different payers submit concurrently and do not wait for each other', async () => {
  const ledger = makeLedger()
  const { sendPayment } = makeSender(ledger)
  const a = Keypair.random()
  const b = Keypair.random()
  const gate = deferred()
  let aStarted = false
  ledger.state.submitImpl = async (tx) => {
    if (tx.source === a.publicKey()) {
      aStarted = true
      await gate.promise
    }
  }
  const slowA = sendPayment(a.secret(), RECIPIENT, '0.01')
  while (!aStarted) await tick()
  const resultB = await sendPayment(b.secret(), RECIPIENT, '0.01')
  assert.strictEqual(resultB.success, true)
  assert.strictEqual(ledger.state.submitted.length, 1)
  gate.resolve()
  assert.strictEqual((await slowA).success, true)
  assert.deepStrictEqual(
    new Set(ledger.state.submitted.map((s) => s.source)),
    new Set([a.publicKey(), b.publicKey()])
  )
})

await test('a rejected transaction releases the queue and reports a structured outcome', async () => {
  const ledger = makeLedger()
  const { sendPayment } = makeSender(ledger)
  const payer = Keypair.random()
  let calls = 0
  ledger.state.submitImpl = async () => {
    calls += 1
    if (calls === 1) throw rejection('tx_failed')
  }
  const [first, second, third] = await Promise.all([
    sendPayment(payer.secret(), RECIPIENT, '0.01'),
    sendPayment(payer.secret(), RECIPIENT, '0.01'),
    sendPayment(payer.secret(), RECIPIENT, '0.01'),
  ])
  assert.strictEqual(first.success, false)
  assert.strictEqual(first.outcome, 'rejected')
  assert.strictEqual(first.errorType, 'REJECTED')
  assert.deepStrictEqual(first.resultCodes, { transaction: 'tx_failed' })
  assert.strictEqual(first.attempts, 1)
  assert.ok(second.success && third.success)
  assert.strictEqual(ledger.state.maxActiveSubmits, 1)
})

await test('a stale sequence is retried once with a fresh load, within the attempt bound', async () => {
  const ledger = makeLedger()
  const { sendPayment } = makeSender(ledger)
  const payer = Keypair.random()
  let calls = 0
  ledger.state.submitImpl = async () => {
    calls += 1
    if (calls === 1) throw rejection('tx_bad_seq')
  }
  const result = await sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.attempts, 2)
  assert.strictEqual(ledger.state.loads.length, 2)
  assert.strictEqual(calls, 2)
})

await test('retries stop at maxAttempts', async () => {
  const ledger = makeLedger()
  const { sendPayment } = makeSender(ledger, { maxAttempts: 3 })
  const payer = Keypair.random()
  let calls = 0
  ledger.state.submitImpl = async () => {
    calls += 1
    throw rejection('tx_bad_seq')
  }
  const result = await sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(calls, 3)
  assert.strictEqual(result.success, false)
  assert.strictEqual(result.errorType, 'BAD_SEQUENCE')
  assert.strictEqual(result.attempts, 3)
})

await test('a delayed response keeps later payments waiting, then they proceed in order', async () => {
  const ledger = makeLedger()
  const { sendPayment } = makeSender(ledger)
  const payer = Keypair.random()
  ledger.state.submitDelayMs = 25
  const results = await Promise.all([
    sendPayment(payer.secret(), RECIPIENT, '0.01'),
    sendPayment(payer.secret(), RECIPIENT, '0.01'),
    sendPayment(payer.secret(), RECIPIENT, '0.01'),
  ])
  assert.ok(results.every((r) => r.success))
  assert.ok(results[0].queueWaitMs < 20)
  assert.ok(results[2].queueWaitMs >= 40, `third waited ${results[2].queueWaitMs}ms`)
  assert.deepStrictEqual(
    ledger.state.submitted.map((s) => s.sequence),
    [101n, 102n, 103n]
  )
})

await test('an uncertain submission is resolved by lookup before any retry', async () => {
  const ledger = makeLedger()
  const payer = Keypair.random()
  let submits = 0
  ledger.state.submitImpl = async (tx) => {
    submits += 1
    if (submits === 1) {
      // The ledger applies it, but the response is lost.
      const err = new Error('timeout of 60000ms exceeded')
      err.code = 'ECONNABORTED'
      ledger.state.appliedHash = tx.hash().toString('hex')
      throw err
    }
  }
  ledger.state.lookupImpl = async (hash, state) =>
    hash === state.appliedHash ? { found: true, ledger: 4242 } : { found: false }
  // The ledger counter only advances on a normal return, so mark it applied by hand.
  const original = ledger.deps.submitTransaction
  ledger.deps.submitTransaction = async (tx) => {
    try {
      return await original(tx)
    } catch (err) {
      if (err.code === 'ECONNABORTED') ledger.sequences.set(tx.source, BigInt(tx.sequence))
      throw err
    }
  }
  const result = await makeSender(ledger).sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.reconciled, true)
  assert.strictEqual(result.ledger, 4242)
  assert.strictEqual(submits, 1, 'no second submission once the first is found applied')
})

await test('an unresolved submission blocks the next one until it is resolved', async () => {
  let clock = 1_000_000
  const ledger = makeLedger()
  const sender = makeSender(ledger, { now: () => clock, resolveChecks: 2 })
  const payer = Keypair.random()
  let submits = 0
  ledger.state.submitImpl = async () => {
    submits += 1
    if (submits === 1) throw new Error('socket hang up')
  }

  const first = await sender.sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(first.success, false)
  assert.strictEqual(first.outcome, 'unknown')
  assert.strictEqual(first.errorType, 'SUBMISSION_UNCERTAIN')
  assert.ok(first.txHash)

  // Still inside the transaction's validity window and not on the ledger: do not submit again.
  const blocked = await sender.sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(blocked.success, false)
  assert.strictEqual(blocked.errorType, 'PRIOR_SUBMISSION_UNRESOLVED')
  assert.strictEqual(blocked.txHash, first.txHash)
  assert.strictEqual(submits, 1)

  // Past its max time the first can never apply, so the account is free again.
  clock += 60_000
  const third = await sender.sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(third.success, true)
  assert.strictEqual(submits, 2)
})

await test('a retry after an uncertain failure only happens once it is known not to have applied', async () => {
  let clock = 5_000_000
  const ledger = makeLedger()
  const sender = makeSender(ledger, { now: () => clock, resolveChecks: 2 })
  const payer = Keypair.random()
  let submits = 0
  ledger.state.submitImpl = async () => {
    submits += 1
    if (submits === 1) {
      clock += 60_000 // the response is slow enough that the transaction has expired
      throw new Error('ETIMEDOUT')
    }
  }
  const result = await sender.sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(result.success, true)
  assert.strictEqual(result.attempts, 2)
  assert.strictEqual(submits, 2)
  assert.ok(ledger.state.lookups >= 1, 'the first attempt was looked up before the retry')
})

await test('a full queue returns a structured failure without touching the network', async () => {
  const ledger = makeLedger()
  const gate = deferred()
  ledger.state.submitImpl = () => gate.promise
  const sender = makeSender(ledger, {
    coordinator: createSubmissionCoordinator({ maxQueueDepth: 1 }),
  })
  const payer = Keypair.random()
  const running = sender.sendPayment(payer.secret(), RECIPIENT, '0.01')
  await delay(10)
  const rejected = await sender.sendPayment(payer.secret(), RECIPIENT, '0.01')
  assert.strictEqual(rejected.success, false)
  assert.strictEqual(rejected.errorType, 'QUEUE_FULL')
  assert.strictEqual(rejected.outcome, 'failed')
  gate.resolve()
  assert.strictEqual((await running).success, true)
})

await test('an invalid secret fails cleanly', async () => {
  const sender = makeSender(makeLedger())
  const result = await sender.sendPayment('not-a-secret', RECIPIENT, '1')
  assert.strictEqual(result.success, false)
  assert.strictEqual(result.errorType, 'INVALID_SECRET')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
