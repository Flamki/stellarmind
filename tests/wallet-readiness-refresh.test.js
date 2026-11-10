/**
 * Guards for issue #157: Refresh wallet readiness and match USDC by its
 * configured asset identity.
 *
 * Exercises:
 *   1. Unfunded -> trustline added -> funded transitions without restart
 *      (both via explicit refresh and via TTL cache expiry)
 *   2. Asset identity matching against the network profile's USDC code + issuer
 *      or contract identity (rejecting same-code/different-issuer balances)
 *   3. Check timestamp, freshness metadata, bounded LRU eviction, and
 *      actionable failure reasons
 *   4. Concurrent check deduplication (single shared request) and upstream
 *      failure separation (never masquerading as a confirmed zero balance)
 *
 * Run: node tests/wallet-readiness-refresh.test.js
 */

import assert from 'node:assert'
import { config } from '../src/config.js'
import {
  STELLAR_PUBNET,
  STELLAR_TESTNET,
  getNetworkProfile,
  resolveNetworkProfile,
} from '../src/stellar/network.js'
import {
  checkWalletReadiness,
  clearWalletReadinessCache,
  findSettlementBalance,
  getWalletReadinessSnapshot,
  matchesSettlementAsset,
  refreshWalletReadiness,
  resolveSettlementAssetIdentity,
  walletReadinessCacheEntryCount,
  walletReadinessCacheKey,
} from '../src/stellar/wallet.js'
import {
  checkX402WalletReadiness,
  getX402WalletReadiness,
  orchestrate,
  refreshX402WalletReadiness,
} from '../src/agents/orchestrator.js'

const testnetProfile = resolveNetworkProfile({ network: STELLAR_TESTNET })
const pubnetProfile = getNetworkProfile(STELLAR_PUBNET)
const TESTNET_USDC_ISSUER = testnetProfile.usdc.issuer
const PUBNET_USDC_ISSUER = pubnetProfile.usdc.issuer
const FAKE_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const ORCHESTRATOR_ADDR = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'

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

console.log('1. Settlement asset identity matching')

await test('matches only the configured network profile USDC code and issuer', () => {
  const realTestnetUsdc = {
    asset: 'USDC',
    balance: '25.0000000',
    issuer: TESTNET_USDC_ISSUER,
  }
  const wrongIssuerUsdc = {
    asset: 'USDC',
    balance: '9999.0000000',
    issuer: FAKE_ISSUER,
  }
  const mainnetIssuerOnTestnet = {
    asset: 'USDC',
    balance: '100.0000000',
    issuer: PUBNET_USDC_ISSUER,
  }
  const missingIssuerUsdc = {
    asset: 'USDC',
    balance: '100.0000000',
    issuer: null,
  }
  const nativeXlm = {
    asset: 'XLM',
    balance: '500.0000000',
    issuer: null,
  }

  assert.strictEqual(matchesSettlementAsset(realTestnetUsdc, testnetProfile.usdc), true)
  assert.strictEqual(matchesSettlementAsset(wrongIssuerUsdc, testnetProfile.usdc), false)
  assert.strictEqual(matchesSettlementAsset(mainnetIssuerOnTestnet, testnetProfile.usdc), false)
  assert.strictEqual(matchesSettlementAsset(missingIssuerUsdc, testnetProfile.usdc), false)
  assert.strictEqual(matchesSettlementAsset(nativeXlm, testnetProfile.usdc), false)
})

await test('matches contract identity when settlement asset specifies a contractId', () => {
  const contractAsset = resolveSettlementAssetIdentity(testnetProfile, {
    code: 'USDC',
    issuer: TESTNET_USDC_ISSUER,
    contractId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  })

  assert.strictEqual(
    matchesSettlementAsset(
      {
        asset: 'USDC',
        balance: '10.0000000',
        issuer: TESTNET_USDC_ISSUER,
        contractId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      },
      contractAsset
    ),
    true
  )

  assert.strictEqual(
    matchesSettlementAsset(
      {
        asset: 'USDC',
        balance: '10.0000000',
        issuer: TESTNET_USDC_ISSUER,
        contractId: 'CDIFFCONTRACT0000000000000000000000000000000000000000000',
      },
      contractAsset
    ),
    false,
    'mismatched contractId must be rejected'
  )

  const contractOnlyAsset = {
    code: 'USDC',
    issuer: null,
    contractId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  }
  assert.strictEqual(
    matchesSettlementAsset(
      { asset: 'USDC', balance: '10.0000000', issuer: TESTNET_USDC_ISSUER },
      contractOnlyAsset
    ),
    false,
    'contract-only identity must not match a classic balance without contractId'
  )
})

await test('findSettlementBalance separates configured USDC from same-code wrong-issuer balances', () => {
  const balances = [
    { asset: 'XLM', balance: '100.0000000', issuer: null },
    { asset: 'USDC', balance: '500.0000000', issuer: FAKE_ISSUER },
    { asset: 'USDC', balance: '12.5000000', issuer: TESTNET_USDC_ISSUER },
  ]

  const found = findSettlementBalance(balances, testnetProfile.usdc)
  assert.ok(found.match, 'must find the configured issuer balance')
  assert.strictEqual(found.match.balance, '12.5000000')
  assert.strictEqual(found.match.issuer, TESTNET_USDC_ISSUER)
  assert.deepStrictEqual(found.mismatchedIssuers, [FAKE_ISSUER])
})

console.log('2. Unfunded-to-funded transitions & explicit refresh without restart')

await test('updates readiness across unfunded -> trustline -> funded states via explicit refresh', async () => {
  clearWalletReadinessCache()
  let nowMs = 1_700_000_000_000
  let ledgerState = 'unfunded'
  let calls = 0

  const getBalanceStub = async () => {
    calls += 1
    if (ledgerState === 'unfunded') {
      return {
        success: false,
        error: 'Request failed with status code 404',
        errorType: 'ACCOUNT_NOT_FOUND',
      }
    }
    if (ledgerState === 'no_trustline') {
      return {
        success: true,
        balances: [{ asset: 'XLM', balance: '10000.0000000', issuer: null }],
      }
    }
    if (ledgerState === 'zero_usdc') {
      return {
        success: true,
        balances: [
          { asset: 'XLM', balance: '10000.0000000', issuer: null },
          { asset: 'USDC', balance: '0.0000000', issuer: TESTNET_USDC_ISSUER },
        ],
      }
    }
    return {
      success: true,
      balances: [
        { asset: 'XLM', balance: '10000.0000000', issuer: null },
        { asset: 'USDC', balance: '25.0000000', issuer: TESTNET_USDC_ISSUER },
      ],
    }
  }

  // Step 1: Account not yet funded on testnet
  const step1 = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 30_000,
    now: () => nowMs,
  })
  assert.strictEqual(step1.ready, false)
  assert.strictEqual(step1.reasonCode, 'ACCOUNT_UNFUNDED')
  assert.strictEqual(step1.hasTrustline, false)
  assert.strictEqual(step1.balance, null)
  assert.match(step1.reason, /npm run setup/)
  assert.strictEqual(step1.cached, false)
  assert.strictEqual(step1.fresh, true)
  assert.strictEqual(calls, 1)

  // Within TTL, normal check returns cached result
  nowMs += 5_000
  const cachedStep1 = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 30_000,
    now: () => nowMs,
  })
  assert.strictEqual(cachedStep1.ready, false)
  assert.strictEqual(cachedStep1.cached, true)
  assert.strictEqual(cachedStep1.ageMs, 5_000)
  assert.strictEqual(calls, 1, 'cached check must not call upstream again before TTL expiry')

  // Step 2: Friendbot funded XLM, but USDC trustline not added yet -> explicit refresh
  ledgerState = 'no_trustline'
  nowMs += 1_000
  const step2 = await refreshWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 30_000,
    now: () => nowMs,
  })
  assert.strictEqual(step2.ready, false)
  assert.strictEqual(step2.reasonCode, 'MISSING_TRUSTLINE')
  assert.match(step2.reason, /npm run setup:usdc/)
  assert.strictEqual(step2.cached, false)
  assert.strictEqual(calls, 2)

  // Step 3: Trustline added with 0 USDC -> explicit refresh
  ledgerState = 'zero_usdc'
  nowMs += 1_000
  const step3 = await refreshWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 30_000,
    now: () => nowMs,
  })
  assert.strictEqual(step3.ready, false)
  assert.strictEqual(step3.reasonCode, 'ZERO_BALANCE')
  assert.strictEqual(step3.hasTrustline, true)
  assert.strictEqual(step3.balance, '0.0000000')
  assert.match(step3.reason, /https:\/\/faucet\.circle\.com/)
  assert.strictEqual(calls, 3)

  // Step 4: Testnet USDC funded -> explicit refresh updates readiness to true without restart
  ledgerState = 'funded'
  nowMs += 1_000
  const step4 = await refreshWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 30_000,
    now: () => nowMs,
  })
  assert.strictEqual(step4.ready, true)
  assert.strictEqual(step4.status, 'ready')
  assert.strictEqual(step4.reasonCode, null)
  assert.strictEqual(step4.reason, null)
  assert.strictEqual(step4.balance, '25.0000000')
  assert.strictEqual(step4.hasTrustline, true)
  assert.strictEqual(step4.balanceConfirmed, true)
  assert.strictEqual(step4.cached, false)
  assert.strictEqual(calls, 4)
})

await test('same-code USDC from a different issuer fails readiness with WRONG_ASSET_ISSUER', async () => {
  clearWalletReadinessCache()
  const res = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: async () => ({
      success: true,
      balances: [
        { asset: 'XLM', balance: '100.0000000', issuer: null },
        { asset: 'USDC', balance: '500.0000000', issuer: FAKE_ISSUER },
      ],
    }),
  })

  assert.strictEqual(res.ready, false)
  assert.strictEqual(res.reasonCode, 'WRONG_ASSET_ISSUER')
  assert.strictEqual(res.hasTrustline, false)
  assert.strictEqual(res.balance, null)
  assert.deepStrictEqual(res.mismatchedIssuers, [FAKE_ISSUER])
  assert.match(res.reason, new RegExp(TESTNET_USDC_ISSUER))
  assert.match(res.reason, new RegExp(FAKE_ISSUER))
  assert.match(res.reason, /npm run setup:usdc/)
})

console.log('3. Cache expiry, freshness metadata, and bounded LRU eviction')

await test('expired cache automatically re-fetches and updates readiness after funding', async () => {
  clearWalletReadinessCache()
  let nowMs = 1_700_000_100_000
  let balance = '0.0000000'
  let calls = 0

  const getBalanceStub = async () => {
    calls += 1
    return {
      success: true,
      balances: [{ asset: 'USDC', balance, issuer: TESTNET_USDC_ISSUER }],
    }
  }

  const initial = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 10_000,
    now: () => nowMs,
  })
  assert.strictEqual(initial.ready, false)
  assert.strictEqual(initial.reasonCode, 'ZERO_BALANCE')
  assert.strictEqual(initial.fresh, true)
  assert.strictEqual(initial.cached, false)
  assert.strictEqual(initial.checkedAt, new Date(nowMs).toISOString())
  assert.strictEqual(initial.expiresAt, new Date(nowMs + 10_000).toISOString())

  // Fund the wallet while cache is still warm
  balance = '42.5000000'
  nowMs += 4_000
  const warm = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 10_000,
    now: () => nowMs,
  })
  assert.strictEqual(warm.ready, false, 'still serves cached entry before TTL expires')
  assert.strictEqual(warm.cached, true)
  assert.strictEqual(warm.fresh, true)
  assert.strictEqual(warm.ageMs, 4_000)
  assert.strictEqual(calls, 1)

  // Advance past TTL: snapshot reports stale, and next check re-fetches automatically
  nowMs += 7_000
  const staleSnapshot = getWalletReadinessSnapshot({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    now: () => nowMs,
  })
  assert.strictEqual(staleSnapshot.fresh, false)
  assert.strictEqual(staleSnapshot.stale, true)
  assert.strictEqual(staleSnapshot.freshness.state, 'stale')

  const afterExpiry = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: getBalanceStub,
    ttlMs: 10_000,
    now: () => nowMs,
  })
  assert.strictEqual(afterExpiry.ready, true, 'must see funded balance once cache expires')
  assert.strictEqual(afterExpiry.balance, '42.5000000')
  assert.strictEqual(afterExpiry.cached, false)
  assert.strictEqual(afterExpiry.fresh, true)
  assert.strictEqual(afterExpiry.ageMs, 0)
  assert.strictEqual(calls, 2)
})

await test('readiness cache is bounded and evicts least-recently-used entries', async () => {
  clearWalletReadinessCache()
  const calls = []
  const getBalanceStub = async (addr) => {
    calls.push(addr)
    return {
      success: true,
      balances: [{ asset: 'USDC', balance: '10.0000000', issuer: TESTNET_USDC_ISSUER }],
    }
  }

  await checkWalletReadiness({ address: 'GADDR1', getBalance: getBalanceStub, cacheSize: 2 })
  await checkWalletReadiness({ address: 'GADDR2', getBalance: getBalanceStub, cacheSize: 2 })
  // Touch GADDR1 so GADDR2 becomes LRU
  await checkWalletReadiness({ address: 'GADDR1', getBalance: getBalanceStub, cacheSize: 2 })
  await checkWalletReadiness({ address: 'GADDR3', getBalance: getBalanceStub, cacheSize: 2 })

  assert.strictEqual(walletReadinessCacheEntryCount(), 2, 'cache size must stay within bound')
  const countBefore = calls.length
  await checkWalletReadiness({ address: 'GADDR1', getBalance: getBalanceStub, cacheSize: 2 })
  assert.strictEqual(calls.length, countBefore, 'GADDR1 was recently used and should remain cached')

  await checkWalletReadiness({ address: 'GADDR2', getBalance: getBalanceStub, cacheSize: 2 })
  assert.strictEqual(calls.length, countBefore + 1, 'GADDR2 was LRU-evicted and must re-fetch')
})

console.log('4. Concurrent request sharing and upstream failure handling')

await test('concurrent readiness checks share a single upstream request', async () => {
  clearWalletReadinessCache()
  let calls = 0

  const slowGetBalance = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 25))
    return {
      success: true,
      balances: [{ asset: 'USDC', balance: '15.0000000', issuer: TESTNET_USDC_ISSUER }],
    }
  }

  const [r1, r2, r3, r4] = await Promise.all([
    checkWalletReadiness({ address: ORCHESTRATOR_ADDR, getBalance: slowGetBalance }),
    checkWalletReadiness({ address: ORCHESTRATOR_ADDR, getBalance: slowGetBalance }),
    checkWalletReadiness({ address: ORCHESTRATOR_ADDR, getBalance: slowGetBalance }),
    refreshWalletReadiness({ address: ORCHESTRATOR_ADDR, getBalance: slowGetBalance }),
  ])

  assert.strictEqual(calls, 1, 'concurrent checks for the same key must share one upstream request')
  for (const res of [r1, r2, r3, r4]) {
    assert.strictEqual(res.ready, true)
    assert.strictEqual(res.balance, '15.0000000')
  }
  const sharedCount = [r1, r2, r3, r4].filter((r) => r.sharedInFlight).length
  assert.strictEqual(sharedCount, 3, 'followers must report sharedInFlight: true')
})

await test('upstream failures do not masquerade as confirmed zero balances and are not cached', async () => {
  clearWalletReadinessCache()
  let shouldFail = true
  let calls = 0

  const flakyGetBalance = async () => {
    calls += 1
    if (shouldFail) {
      return {
        success: false,
        error: 'Request timed out after 30000ms',
        errorType: 'TIMEOUT',
      }
    }
    return {
      success: true,
      balances: [{ asset: 'USDC', balance: '100.0000000', issuer: TESTNET_USDC_ISSUER }],
    }
  }

  const failedCheck = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: flakyGetBalance,
    ttlMs: 60_000,
  })

  assert.strictEqual(failedCheck.ready, false)
  assert.strictEqual(failedCheck.status, 'unknown')
  assert.strictEqual(failedCheck.upstreamError, true)
  assert.strictEqual(failedCheck.balanceConfirmed, false)
  assert.strictEqual(failedCheck.balance, null, 'upstream failure must never report a 0 balance')
  assert.strictEqual(
    failedCheck.hasTrustline,
    null,
    'upstream failure must never report missing trustline'
  )
  assert.strictEqual(failedCheck.reasonCode, 'UPSTREAM_ERROR')
  assert.strictEqual(failedCheck.errorType, 'TIMEOUT')
  assert.ok(!/balance is 0/i.test(failedCheck.reason))
  assert.ok(!/No USDC trustline/i.test(failedCheck.reason))
  assert.strictEqual(walletReadinessCacheEntryCount(), 0, 'upstream failures must not be cached')

  // Immediately recovers on next check without needing forceRefresh
  shouldFail = false
  const recovered = await checkWalletReadiness({
    address: ORCHESTRATOR_ADDR,
    networkProfile: testnetProfile,
    getBalance: flakyGetBalance,
    ttlMs: 60_000,
  })
  assert.strictEqual(calls, 2)
  assert.strictEqual(recovered.ready, true)
  assert.strictEqual(recovered.balance, '100.0000000')
  assert.strictEqual(recovered.balanceConfirmed, true)
})

console.log('5. Orchestrator integration')

await test('orchestrator exposes updated readiness state and refreshes without restart', async () => {
  clearWalletReadinessCache()
  const originalAddress = config.orchestratorAddress
  config.orchestratorAddress = ORCHESTRATOR_ADDR

  try {
    let funded = false
    const getBalanceStub = async () => ({
      success: true,
      balances: [
        {
          asset: 'USDC',
          balance: funded ? '50.0000000' : '0.0000000',
          issuer: TESTNET_USDC_ISSUER,
        },
      ],
    })

    const beforeFunding = await checkX402WalletReadiness({
      getBalance: getBalanceStub,
      refresh: true,
    })
    assert.strictEqual(beforeFunding.ready, false)
    assert.strictEqual(beforeFunding.reasonCode, 'ZERO_BALANCE')
    assert.strictEqual(getX402WalletReadiness().ready, false)

    funded = true
    const events = []
    const runResult = await orchestrate(
      'Verify wallet readiness refresh during orchestration',
      0.01,
      (ev) => events.push(ev),
      {
        plan: {
          plan: 'single research step',
          subtasks: [{ agentId: 'research-bot', input: 'stellar x402', stepId: 'step-0' }],
        },
        serviceMap: {
          'research-bot': async () => 'research output',
        },
        x402Fetch: null,
        getBalance: getBalanceStub,
        refreshWalletReadiness: true,
      }
    )

    assert.strictEqual(runResult.x402WalletReady, true)
    assert.strictEqual(runResult.x402WalletHint, null)
    assert.ok(runResult.x402WalletReadiness)
    assert.strictEqual(runResult.x402WalletReadiness.ready, true)
    assert.strictEqual(runResult.x402WalletReadiness.balance, '50.0000000')
    assert.strictEqual(runResult.x402WalletReadiness.asset.issuer, TESTNET_USDC_ISSUER)

    const startEvent = events.find((e) => e.type === 'orchestrator_start')
    assert.strictEqual(startEvent.x402WalletReady, true)
    assert.strictEqual(startEvent.x402WalletReadiness.ready, true)

    const refreshed = await refreshX402WalletReadiness({ getBalance: getBalanceStub })
    assert.strictEqual(refreshed.ready, true)
    assert.notStrictEqual(
      walletReadinessCacheKey({ networkProfile: testnetProfile, address: ORCHESTRATOR_ADDR }),
      walletReadinessCacheKey({ networkProfile: pubnetProfile, address: ORCHESTRATOR_ADDR }),
      'cache key must separate network profiles and their asset issuers'
    )
  } finally {
    config.orchestratorAddress = originalAddress
    clearWalletReadinessCache()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
console.log('✅ wallet readiness refresh and USDC identity checks passed')
