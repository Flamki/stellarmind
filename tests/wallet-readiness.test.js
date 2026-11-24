/**
 * Tests for wallet readiness (#157): a bounded, refreshable readiness cache that
 * only the configured settlement asset (code AND issuer) can satisfy.
 *
 * Covers: unfunded -> funded without a restart, same-code/different-issuer
 * balances, expired and fresh cache, explicit refresh and its throttle, shared
 * concurrent lookups, and upstream failures that must never read as a confirmed
 * zero balance. No network access: balances and the clock are injected.
 *
 * Run: node tests/wallet-readiness.test.js
 */

import assert from 'node:assert'
import { createWalletReadiness, READINESS_STATES } from '../src/stellar/wallet-readiness.js'
import { getNetworkProfile, STELLAR_TESTNET } from '../src/stellar/network.js'

// ─── Tiny test harness ───────────────────────────────────────
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

// ─── Fixtures ────────────────────────────────────────────────
const USDC = getNetworkProfile(STELLAR_TESTNET).usdc
const OTHER_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const ADDRESS = 'GORCHESTRATORADDRESS'

const xlm = { asset: 'XLM', balance: '100.0000000', issuer: null }
const usdc = (balance, issuer = USDC.issuer) => ({ asset: 'USDC', balance, issuer })
const ok = (...balances) => ({ success: true, balances })

/** A fake balance source whose next answer can change, counting every call. */
function fakeBalances(initial) {
  const source = {
    calls: 0,
    answer: initial,
    getBalance: async () => {
      source.calls += 1
      if (source.answer instanceof Error) throw source.answer
      return source.answer
    },
  }
  return source
}

function build(source, overrides = {}) {
  const clock = { t: 1_000_000 }
  const readiness = createWalletReadiness({
    getBalance: source.getBalance,
    address: ADDRESS,
    asset: USDC,
    network: STELLAR_TESTNET,
    faucetUrl: 'https://faucet.circle.com',
    ttlMs: 30_000,
    failureTtlMs: 5_000,
    requestTimeoutMs: 1_000,
    minRefreshIntervalMs: 2_000,
    now: () => clock.t,
    ...overrides,
  })
  return { readiness, clock }
}

// ─── Asset identity ──────────────────────────────────────────
console.log('Configured asset identity')

await test('a funded trustline for the configured asset is ready', async () => {
  const { readiness } = build(fakeBalances(ok(xlm, usdc('25.5000000'))))
  const result = await readiness.check()
  assert.strictEqual(result.ready, true)
  assert.strictEqual(result.state, READINESS_STATES.READY)
  assert.strictEqual(result.reason, null)
  assert.strictEqual(result.balance, '25.5000000')
  assert.deepStrictEqual(result.asset, USDC)
  assert.strictEqual(result.network, STELLAR_TESTNET)
})

await test('same code from a different issuer does not satisfy readiness', async () => {
  const { readiness } = build(fakeBalances(ok(xlm, usdc('500.0000000', OTHER_ISSUER))))
  const result = await readiness.check()
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state, READINESS_STATES.WRONG_ISSUER)
  assert.strictEqual(result.balance, null, 'a foreign balance must not be reported as ours')
  assert.match(result.reason, /different issuer/)
  assert.ok(result.reason.includes(USDC.issuer), 'reason names the configured issuer')
})

await test('the configured issuer wins when both issuers are held', async () => {
  const { readiness } = build(
    fakeBalances(ok(usdc('999.0000000', OTHER_ISSUER), usdc('0.0000000')))
  )
  const result = await readiness.check()
  assert.strictEqual(result.ready, false, 'the foreign balance must not count')
  assert.strictEqual(result.state, READINESS_STATES.UNFUNDED)
})

await test('no trustline for the asset is reported with the setup command', async () => {
  const { readiness } = build(fakeBalances(ok(xlm)))
  const result = await readiness.check()
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state, READINESS_STATES.NO_TRUSTLINE)
  assert.match(result.reason, /npm run setup:usdc/)
})

await test('a zero balance is unfunded and names the faucet', async () => {
  for (const zero of ['0', '0.0000000']) {
    const { readiness } = build(fakeBalances(ok(usdc(zero))))
    const result = await readiness.check()
    assert.strictEqual(result.ready, false, `balance ${zero}`)
    assert.strictEqual(result.state, READINESS_STATES.UNFUNDED)
    assert.match(result.reason, /faucet\.circle\.com/)
  }
})

await test('the smallest non-zero amount is ready', async () => {
  const { readiness } = build(fakeBalances(ok(usdc('0.0000001'))))
  assert.strictEqual((await readiness.check()).ready, true)
})

await test('a missing account is a definite answer, not an upstream failure', async () => {
  const { readiness } = build(
    fakeBalances({ success: false, errorType: 'ACCOUNT_NOT_FOUND', error: 'Not Found' })
  )
  const result = await readiness.check()
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state, READINESS_STATES.ACCOUNT_NOT_FOUND)
})

await test('an unconfigured wallet makes no lookup and says why', async () => {
  const source = fakeBalances(ok(usdc('10')))
  const { readiness } = build(source, { address: '' })
  const result = await readiness.check()
  assert.strictEqual(result.ready, false)
  assert.strictEqual(result.state, READINESS_STATES.NOT_CONFIGURED)
  assert.match(result.reason, /ORCHESTRATOR_STELLAR_ADDRESS/)
  assert.strictEqual(source.calls, 0)
})

await test('an asset without an issuer is rejected at construction', () => {
  assert.throws(
    () =>
      createWalletReadiness({
        getBalance: async () => ok(),
        address: ADDRESS,
        asset: { code: 'USDC' },
      }),
    /code and issuer/
  )
})

// ─── Refresh without a restart ───────────────────────────────
console.log('Refresh and freshness')

await test('readiness updates after funding once the cache expires, no restart', async () => {
  const source = fakeBalances(ok(xlm))
  const { readiness, clock } = build(source)

  assert.strictEqual((await readiness.check()).ready, false)

  source.answer = ok(xlm, usdc('50.0000000')) // funded after startup
  clock.t += 30_001 // past the TTL
  const after = await readiness.check()

  assert.strictEqual(after.ready, true)
  assert.strictEqual(after.state, READINESS_STATES.READY)
  assert.strictEqual(source.calls, 2)
})

await test('an explicit refresh picks up funding before the TTL elapses', async () => {
  const source = fakeBalances(ok(xlm))
  const { readiness, clock } = build(source)
  await readiness.check()

  source.answer = ok(usdc('50.0000000'))
  clock.t += 2_500 // past the refresh throttle, well inside the TTL

  assert.strictEqual((await readiness.check()).ready, false, 'a plain check serves the cache')
  assert.strictEqual((await readiness.check({ refresh: true })).ready, true)
})

await test('a fresh answer is served from cache without another lookup', async () => {
  const source = fakeBalances(ok(usdc('5')))
  const { readiness, clock } = build(source)
  await readiness.check()
  clock.t += 29_999
  const cached = await readiness.check()
  assert.strictEqual(source.calls, 1)
  assert.strictEqual(cached.fresh, true)
})

await test('explicit refreshes are throttled so they cannot hammer the upstream', async () => {
  const source = fakeBalances(ok(usdc('5')))
  const { readiness, clock } = build(source)
  await readiness.check()

  clock.t += 500
  await readiness.check({ refresh: true })
  await readiness.check({ refresh: true })
  assert.strictEqual(source.calls, 1, 'refreshes inside the throttle window reuse the answer')

  clock.t += 1_600 // 2.1s since the last lookup
  await readiness.check({ refresh: true })
  assert.strictEqual(source.calls, 2)
})

await test('responses expose the check time, expiry, age and freshness', async () => {
  const { readiness, clock } = build(fakeBalances(ok(usdc('5'))))

  const unchecked = readiness.peek()
  assert.strictEqual(unchecked.state, 'unchecked')
  assert.strictEqual(unchecked.ready, null)
  assert.strictEqual(unchecked.checkedAt, null)
  assert.strictEqual(unchecked.fresh, false)

  const first = await readiness.check()
  assert.strictEqual(first.checkedAt, new Date(1_000_000).toISOString())
  assert.strictEqual(first.expiresAt, new Date(1_030_000).toISOString())
  assert.strictEqual(first.ageMs, 0)
  assert.strictEqual(first.fresh, true)

  clock.t += 40_000
  const stale = readiness.peek() // no network call
  assert.strictEqual(stale.fresh, false)
  assert.strictEqual(stale.ageMs, 40_000)
  assert.strictEqual(stale.ready, true, 'the last answer is still shown, flagged stale')
})

// ─── Concurrency ─────────────────────────────────────────────
console.log('Concurrent checks')

await test('concurrent checks share one upstream request', async () => {
  const source = fakeBalances(ok(usdc('5')))
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const slow = {
    ...source,
    getBalance: async (address) => {
      await gate
      return source.getBalance(address)
    },
  }
  const { readiness } = build(slow)

  const pending = Array.from({ length: 8 }, (_, i) => readiness.check({ refresh: i % 2 === 0 }))
  release()
  const results = await Promise.all(pending)

  assert.strictEqual(source.calls, 1)
  assert.ok(results.every((r) => r.ready === true && r.checkedAt === results[0].checkedAt))
})

await test('a failed shared lookup is shared too, then a later check retries', async () => {
  const source = fakeBalances(new Error('connect ECONNREFUSED'))
  const { readiness, clock } = build(source)

  const results = await Promise.all([readiness.check(), readiness.check(), readiness.check()])
  assert.strictEqual(source.calls, 1)
  assert.ok(results.every((r) => r.state === READINESS_STATES.UNAVAILABLE))

  source.answer = ok(usdc('5'))
  clock.t += 5_001 // the failure TTL, much shorter than the success TTL
  assert.strictEqual((await readiness.check()).ready, true)
})

// ─── Upstream failure ────────────────────────────────────────
console.log('Upstream failure')

await test('a failed lookup is unknown, never a confirmed zero balance', async () => {
  const failures = [
    fakeBalances({ success: false, error: 'boom', errorType: 'UPSTREAM_ERROR' }),
    fakeBalances({ success: false, error: 'slow', errorType: 'TIMEOUT' }),
    fakeBalances(new Error('socket hang up')),
    fakeBalances(undefined),
    fakeBalances({ success: true, balances: 'not-a-list' }),
  ]
  for (const source of failures) {
    const result = await build(source).readiness.check()
    assert.strictEqual(result.ready, null, 'unknown, not false')
    assert.strictEqual(result.state, READINESS_STATES.UNAVAILABLE)
    assert.match(result.reason, /not a confirmed empty balance/)
    assert.strictEqual(result.balance, null)
    assert.doesNotMatch(result.reason, /USDC balance is 0/)
  }
})

await test('a failure after a ready answer does not keep claiming ready', async () => {
  const source = fakeBalances(ok(usdc('5')))
  const { readiness, clock } = build(source)
  assert.strictEqual((await readiness.check()).ready, true)

  source.answer = { success: false, error: 'Horizon 503', errorType: 'UPSTREAM_ERROR' }
  clock.t += 30_001
  const result = await readiness.check()
  assert.strictEqual(result.ready, null)
  assert.match(result.reason, /Horizon 503/)
})

await test('a lookup that never answers times out as unavailable', async () => {
  const hung = { calls: 0, getBalance: () => new Promise(() => {}) }
  const { readiness } = build(hung, { requestTimeoutMs: 25 })
  const result = await readiness.check()
  assert.strictEqual(result.ready, null)
  assert.match(result.reason, /timed out after 25ms/)
})

await test('upstream failure reasons are bounded in length', async () => {
  const { readiness } = build(fakeBalances(new Error('x'.repeat(5_000))))
  const result = await readiness.check()
  assert.ok(result.reason.length < 400)
})

// ─── Transition logging ──────────────────────────────────────
console.log('Logging')

await test('only state changes are logged', async () => {
  const lines = []
  const logger = {
    info: (msg, data) => lines.push(['info', msg, data]),
    warn: (msg, data) => lines.push(['warn', msg, data]),
  }
  const source = fakeBalances(ok(xlm))
  const { readiness, clock } = build(source, { logger })

  await readiness.check() // no_trustline
  clock.t += 30_001
  await readiness.check() // still no_trustline: not logged again
  source.answer = ok(usdc('5'))
  clock.t += 30_001
  await readiness.check() // ready

  assert.deepStrictEqual(
    lines.map(([level, , data]) => [level, data.state]),
    [
      ['warn', 'no_trustline'],
      ['info', 'ready'],
    ]
  )
  assert.ok(!JSON.stringify(lines).includes(ADDRESS), 'logs carry no wallet identifiers')
})

// ─── Summary ─────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
