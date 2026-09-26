/**
 * Guards for issue #160: transaction-operation lookups must be bounded and cached.
 *
 * `getTransactions` decorates every listed transaction with its operations. It
 * used to do that with `Promise.all` over the whole page — one Horizon request
 * per transaction, all in flight at once — and it re-fetched immutable data on
 * every refresh. A failed lookup and a transaction with no operations were also
 * indistinguishable, because both came back as an empty array.
 *
 * Run: node tests/horizon-transaction-ops.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.js'
import {
  clearOperationsCache,
  fetchTransactionOperations,
  mapWithConcurrency,
  operationsCacheEntryCount,
  operationsCacheKey,
} from '../src/stellar/wallet.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const walletSource = fs.readFileSync(path.join(repoRoot, 'src/stellar/wallet.js'), 'utf8')

/** Minimal stand-in for a Horizon server, mirroring the SDK call chain. */
function fakeHorizon({
  recordsFor = () => [],
  fail = null,
  delayMs = 0,
  onCall = () => {},
  serverURL = undefined,
} = {}) {
  const calls = []
  const server = {
    serverURL,
    operations() {
      return {
        forTransaction(hash) {
          return {
            order: () => ({
              limit: () => ({
                call: async () => {
                  calls.push(hash)
                  onCall(hash)
                  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
                  if (fail && fail(hash)) throw new Error(`horizon exploded for ${hash}`)
                  return { records: recordsFor(hash) }
                },
              }),
            }),
          }
        },
      }
    },
  }
  return { server, calls }
}

const opRecord = (id) => ({
  id,
  type: 'payment',
  asset_type: 'native',
  amount: '10.0000000',
  from: 'GFROM',
  to: 'GTO',
})

// ── 1. concurrency is bounded ───────────────────────────────────────────────

{
  const items = Array.from({ length: 12 }, (_, i) => `tx${i}`)
  let inFlight = 0
  let peak = 0

  const results = await mapWithConcurrency(items, 3, async (item) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
    return `${item}-done`
  })

  assert.strictEqual(peak, 3, `expected at most 3 lookups in flight, peaked at ${peak}`)
  assert.deepStrictEqual(
    results,
    items.map((i) => `${i}-done`),
    'results must stay in the order of the input'
  )
  assert.strictEqual(await mapWithConcurrency([], 4, async () => 'never').then((r) => r.length), 0)
}

// ── 2. a successful lookup is reused ────────────────────────────────────────

{
  clearOperationsCache()
  const { server, calls } = fakeHorizon({ recordsFor: () => [opRecord('op-1')] })

  const first = await fetchTransactionOperations('hash-a', server)
  const second = await fetchTransactionOperations('hash-a', server)

  assert.strictEqual(calls.length, 1, 'a cached lookup must not hit Horizon twice')
  assert.strictEqual(first.error, null)
  assert.strictEqual(second.error, null)
  assert.strictEqual(second.operations.length, 1)
  assert.strictEqual(first.operations[0].asset_code, 'XLM', 'native asset must map to XLM')
}

// ── 3. the cache is bounded and evicts the least recently used ───────────────

{
  clearOperationsCache()
  const original = config.horizonOpsCacheSize
  config.horizonOpsCacheSize = 2
  try {
    const { server, calls } = fakeHorizon({ recordsFor: () => [] })

    await fetchTransactionOperations('hash-1', server)
    await fetchTransactionOperations('hash-2', server)
    // Touch hash-1 so hash-2 becomes the oldest entry.
    await fetchTransactionOperations('hash-1', server)
    await fetchTransactionOperations('hash-3', server)

    assert.strictEqual(operationsCacheEntryCount(), 2, 'cache must not grow past its bound')
    const callsBefore = calls.length
    await fetchTransactionOperations('hash-2', server)
    assert.strictEqual(
      calls.length,
      callsBefore + 1,
      'the least recently used entry should have been evicted, so this must refetch'
    )
  } finally {
    config.horizonOpsCacheSize = original
    clearOperationsCache()
  }
}

// ── 4. failures are surfaced and never cached ───────────────────────────────

{
  clearOperationsCache()
  const failing = fakeHorizon({ fail: () => true })
  const first = await fetchTransactionOperations('hash-fail', failing.server)
  const second = await fetchTransactionOperations('hash-fail', failing.server)

  assert.strictEqual(first.operations.length, 0)
  assert.match(
    first.error,
    /horizon exploded/,
    'a failed lookup must report an error, not an empty list'
  )
  assert.match(
    second.error,
    /horizon exploded/,
    'the retry must fail the same way, not silently succeed'
  )
  assert.strictEqual(failing.calls.length, 2, 'a failure must not be cached as a successful result')

  // A genuinely empty result is a success and *is* cached.
  const empty = fakeHorizon({ recordsFor: () => [] })
  const emptyFirst = await fetchTransactionOperations('hash-empty', empty.server)
  const emptySecond = await fetchTransactionOperations('hash-empty', empty.server)
  assert.strictEqual(emptyFirst.error, null)
  assert.strictEqual(emptyFirst.operations.length, 0)
  assert.strictEqual(empty.calls.length, 1, 'an empty-but-successful lookup may be cached')
  assert.strictEqual(emptySecond.error, null)
}

// ── 5. the unbounded fan-out does not come back ─────────────────────────────

{
  assert.match(
    walletSource,
    /mapWithConcurrency\(/,
    'getTransactions must decorate transactions through the bounded helper'
  )
  assert.match(
    walletSource,
    /config\.horizonOpsMaxConcurrency/,
    'the bound must come from configuration, not a literal'
  )
  assert.ok(
    !/Promise\.all\(\s*txs\.records\.map/.test(walletSource),
    'the unbounded Promise.all over txs.records must not return'
  )
}

// ── 6. the cache key separates network profiles ─────────────────────────────

{
  clearOperationsCache()
  const testnet = fakeHorizon({
    serverURL: 'https://horizon-testnet.stellar.org',
    recordsFor: () => [opRecord('op-testnet')],
  })
  const mainnet = fakeHorizon({
    serverURL: 'https://horizon-mainnet.stellar.org',
    recordsFor: () => [opRecord('op-mainnet')],
  })

  const fromTestnet = await fetchTransactionOperations('same-hash', testnet.server)
  const fromMainnet = await fetchTransactionOperations('same-hash', mainnet.server)

  assert.strictEqual(
    mainnet.calls.length,
    1,
    'a lookup on another profile must not be answered from this profile’s cache'
  )
  assert.strictEqual(fromTestnet.operations[0].id, 'op-testnet')
  assert.strictEqual(
    fromMainnet.operations[0].id,
    'op-mainnet',
    'each profile must keep its own result for the same hash'
  )

  // Reuse still happens, but only inside one profile.
  await fetchTransactionOperations('same-hash', testnet.server)
  assert.strictEqual(testnet.calls.length, 1, 'a repeat on one profile is still a cache hit')

  assert.strictEqual(
    operationsCacheKey('same-hash', testnet.server),
    operationsCacheKey('same-hash', testnet.server),
    'the key must be stable for one profile and hash'
  )
  assert.notStrictEqual(
    operationsCacheKey('same-hash', testnet.server),
    operationsCacheKey('same-hash', mainnet.server),
    'the key must differ between profiles'
  )
  assert.notStrictEqual(
    operationsCacheKey('hash-a', testnet.server),
    operationsCacheKey('hash-b', testnet.server),
    'the key must differ between hashes on one profile'
  )
}

console.log('✅ horizon transaction-operation lookup checks passed')
