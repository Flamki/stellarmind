/**
 * Tests for Issue #155:
 * Provide a deterministic offline demo mode with stub payment receipts
 *
 * Run: node tests/offline-demo-mode.test.js
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import {
  OFFLINE_DEMO_FIXTURES,
  SYNTHETIC_RECEIPT_LABEL,
  SYNTHETIC_TX_PREFIX,
  buildSyntheticPaymentReceipt,
  createProvider,
  getOfflineWalletBalances,
  getOfflineWalletTransactions,
  isOfflineDemoEnabled,
  isSyntheticReceiptHash,
  listOfflineDemoFixtures,
  setOfflineDemoMode,
} from '../src/providers/index.js'
import { executePlan, orchestrate, previewOrchestration } from '../src/agents/orchestrator.js'
import { createServerApp } from '../src/server.js'
import { runOfflineDemo } from '../src/demo.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.stack || err.message}`)
    failed++
  }
}

/**
 * Guard `globalThis.fetch` so any attempt to contact an external host
 * (Horizon, Stellar RPC, x402 facilitator, Anthropic API, etc.) fails immediately.
 * Only loopback test server calls (`127.0.0.1` / `localhost`) are permitted.
 */
async function withExternalNetworkBlocked(fn) {
  const originalFetch = globalThis.fetch
  const externalAttempts = []

  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || String(input)
    let hostname = ''
    try {
      hostname = new URL(rawUrl).hostname
    } catch {
      hostname = 'localhost'
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      externalAttempts.push(rawUrl)
      throw new Error(`External network request blocked in offline demo test: ${rawUrl}`)
    }
    return originalFetch(input, init)
  }

  try {
    const result = await fn(externalAttempts)
    assert.equal(
      externalAttempts.length,
      0,
      `Expected zero external network requests, saw: ${externalAttempts.join(', ')}`
    )
    return result
  } finally {
    globalThis.fetch = originalFetch
  }
}

function listenOnEphemeralPort(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(res)),
      })
    })
    server.on('error', reject)
  })
}

console.log('\n── Deterministic Offline Demo Mode Tests (#155) ───────────────────\n')

await test('1. Offline mode is strictly opt-in by default', async () => {
  setOfflineDemoMode(null)
  assert.equal(isOfflineDemoEnabled({ env: {}, argv: ['node', 'src/server.js'] }), false)
  assert.equal(
    isOfflineDemoEnabled({ env: { OFFLINE_DEMO_MODE: 'false' }, argv: ['node', 'src/server.js'] }),
    false
  )
  assert.equal(
    isOfflineDemoEnabled({ env: { OFFLINE_DEMO_MODE: 'true' }, argv: ['node', 'src/server.js'] }),
    true
  )
  assert.equal(
    isOfflineDemoEnabled({ env: {}, argv: ['node', 'src/server.js', '--offline'] }),
    true
  )

  const liveServer = await createServerApp({ offlineMode: false, runHistoryStorage: 'memory' })
  const listener = await listenOnEphemeralPort(liveServer.app)
  try {
    const statusRes = await fetch(`${listener.baseUrl}/api/status`)
    assert.equal(statusRes.status, 200)
    const statusBody = await statusRes.json()
    assert.equal(statusBody.offlineMode, false)
    assert.equal(statusBody.demoMode, 'live')
    assert.equal(statusBody.executionMode, 'live')
    assert.equal(statusBody.receiptMode, 'on-chain')
  } finally {
    await listener.close()
    liveServer.close()
    setOfflineDemoMode(null)
  }
})

await test('2. Synthetic payment receipts are visibly marked and never link to Stellar Expert', async () => {
  const receiptA = buildSyntheticPaymentReceipt({
    scenario: 'successful',
    stepIndex: 0,
    agentId: 'research-bot',
    method: 'x402',
    amount: '0.01',
    asset: 'USDC',
    task: 'Test offline task',
  })
  const receiptB = buildSyntheticPaymentReceipt({
    scenario: 'successful',
    stepIndex: 0,
    agentId: 'research-bot',
    method: 'x402',
    amount: '0.01',
    asset: 'USDC',
    task: 'Test offline task',
  })

  // Deterministic across calls
  assert.equal(receiptA.txHash, receiptB.txHash)
  assert.equal(receiptA.txHash.startsWith(SYNTHETIC_TX_PREFIX), true)
  assert.equal(isSyntheticReceiptHash(receiptA.txHash), true)
  assert.equal(receiptA.synthetic, true)
  assert.equal(receiptA.offlineMode, true)
  assert.equal(receiptA.receiptMode, 'synthetic-stub')
  assert.equal(receiptA.receiptLabel, SYNTHETIC_RECEIPT_LABEL)
  assert.equal(receiptA.explorerUrl, null)

  const offlineProvider = createProvider('offline')
  const completion = await offlineProvider.complete('Test prompt', { role: 'research-bot' })
  assert.equal(completion.offlineMode, true)
  assert.equal(completion.synthetic, true)
  assert.equal(typeof completion.text, 'string')
  assert.ok(completion.text.length > 20)
})

await test('3. Canonical fixtures cover successful, partial, and budget-limited runs with zero external requests', async () => {
  const fixtures = listOfflineDemoFixtures()
  assert.deepEqual(
    fixtures.map((f) => f.id),
    ['successful', 'partial', 'budget-limited']
  )

  await withExternalNetworkBlocked(async () => {
    // 3a. Successful fixture
    const successEvents = []
    const successRun = await orchestrate(
      OFFLINE_DEMO_FIXTURES.successful.task,
      OFFLINE_DEMO_FIXTURES.successful.budget,
      (e) => successEvents.push(e),
      { offlineMode: true, fixture: 'successful' }
    )
    assert.equal(successRun.offlineMode, true)
    assert.equal(successRun.executionMode, 'offline-demo')
    assert.equal(successRun.receiptMode, 'synthetic-stub')
    assert.equal(successRun.scenario, 'successful')
    assert.equal(successRun.agentsUsed, 3)
    assert.equal(successRun.agentsSkipped, 0)
    assert.equal(successRun.x402PaymentCount, 3)
    assert.equal(successRun.xlmFallbackCount, 0)
    assert.equal(successRun.unpaidCount, 0)
    assert.equal(successRun.settledSummary, '0.07 USDC')

    for (const payment of successRun.payments) {
      assert.equal(payment.synthetic, true)
      assert.equal(payment.offlineMode, true)
      assert.equal(payment.receiptMode, 'synthetic-stub')
      assert.equal(payment.receiptLabel, SYNTHETIC_RECEIPT_LABEL)
      assert.equal(payment.txHash.startsWith(SYNTHETIC_TX_PREFIX), true)
      assert.equal(payment.explorerUrl, null)
      assert.equal(payment.settlement.explorerUrl, null)
    }

    for (const evt of successEvents) {
      if ('explorerUrl' in evt) {
        assert.equal(evt.explorerUrl, null, `Event ${evt.type} must not have an explorer URL`)
      }
      assert.equal(evt.offlineMode, true, `Event ${evt.type} must report offlineMode: true`)
    }

    // 3b. Partial fixture (1 x402 USDC + 1 XLM fallback + 1 unresolved transport error)
    const partialEvents = []
    const partialRun = await orchestrate(
      OFFLINE_DEMO_FIXTURES.partial.task,
      OFFLINE_DEMO_FIXTURES.partial.budget,
      (e) => partialEvents.push(e),
      { offlineMode: true, fixture: 'partial' }
    )
    assert.equal(partialRun.offlineMode, true)
    assert.equal(partialRun.scenario, 'partial')
    assert.equal(partialRun.agentsUsed, 3)
    assert.equal(partialRun.agentsSkipped, 0)
    assert.equal(partialRun.x402PaymentCount, 1)
    assert.equal(partialRun.xlmFallbackCount, 1)
    assert.equal(partialRun.unpaidCount, 1)
    assert.equal(partialRun.pendingPaymentCount, 1)
    assert.equal(partialRun.payments.length, 2)
    assert.ok(partialEvents.some((e) => e.type === 'x402_retry'))
    assert.ok(partialEvents.some((e) => e.type === 'x402_settlement_unresolved'))
    for (const payment of partialRun.payments) {
      assert.equal(payment.synthetic, true)
      assert.equal(payment.explorerUrl, null)
    }

    // 3c. Budget-limited fixture (2 steps executed, 2 skipped by budget guardrail)
    const budgetEvents = []
    const budgetRun = await orchestrate(
      OFFLINE_DEMO_FIXTURES['budget-limited'].task,
      OFFLINE_DEMO_FIXTURES['budget-limited'].budget,
      (e) => budgetEvents.push(e),
      { offlineMode: true, fixture: 'budget-limited' }
    )
    assert.equal(budgetRun.offlineMode, true)
    assert.equal(budgetRun.scenario, 'budget-limited')
    assert.equal(budgetRun.agentsUsed, 2)
    assert.equal(budgetRun.agentsSkipped, 2)
    assert.equal(budgetRun.budgetExhausted, true)
    assert.equal(budgetRun.totalSpent, '0.0200')
    assert.equal(budgetRun.settledSummary, '0.02 USDC')
    assert.equal(budgetEvents.filter((e) => e.type === 'budget_limit').length, 2)
    for (const step of budgetRun.results) {
      assert.equal(step.offlineMode, true)
      if (!step.skipped) {
        assert.equal(step.synthetic, true)
        assert.equal(step.explorerUrl, null)
      }
    }
  })
})

await test('4. Preview and executePlan run offline deterministically without external requests', async () => {
  await withExternalNetworkBlocked(async () => {
    const previewEvents = []
    const preview = await previewOrchestration(
      OFFLINE_DEMO_FIXTURES.successful.task,
      OFFLINE_DEMO_FIXTURES.successful.budget,
      (e) => previewEvents.push(e),
      { offlineMode: true, fixture: 'successful' }
    )
    assert.equal(preview.offlineMode, true)
    assert.equal(preview.executionMode, 'offline-demo')
    assert.equal(preview.receiptMode, 'synthetic-stub')
    assert.equal(preview.steps.length, 3)
    assert.equal(preview.totalQuote, '0.0700')

    const executed = await executePlan(preview.planId, null, { offlineMode: true })
    assert.equal(executed.offlineMode, true)
    assert.equal(executed.agentsUsed, 3)
    assert.equal(
      executed.payments.every((p) => p.synthetic && p.explorerUrl === null),
      true
    )
  })
})

await test('5. CLI runOfflineDemo produces identical deterministic receipts across runs', async () => {
  await withExternalNetworkBlocked(async () => {
    const logsA = []
    const logsB = []
    const runA = await runOfflineDemo({ log: (...args) => logsA.push(args.join(' ')) })
    const runB = await runOfflineDemo({ log: (...args) => logsB.push(args.join(' ')) })

    assert.equal(runA.offlineMode, true)
    assert.equal(runA.runs.length, 3)
    assert.ok(runA.syntheticReceipts.length >= 6)
    assert.deepEqual(
      runA.syntheticReceipts.map((r) => r.txHash),
      runB.syntheticReceipts.map((r) => r.txHash)
    )
    for (const receipt of runA.syntheticReceipts) {
      assert.equal(receipt.synthetic, true)
      assert.equal(receipt.offlineMode, true)
      assert.equal(receipt.explorerUrl, null)
      assert.equal(receipt.txHash.startsWith(SYNTHETIC_TX_PREFIX), true)
    }
    const combinedOutput = logsA.join('\n')
    assert.equal(combinedOutput.includes('stellar.expert'), false)
    assert.equal(combinedOutput.includes(SYNTHETIC_RECEIPT_LABEL), true)
  })
})

await test('6. Full HTTP dashboard server operates 100% offline with consistent status, wallet, premium, and orchestrate endpoints', async () => {
  await withExternalNetworkBlocked(async () => {
    const offlineServer = await createServerApp({
      offlineMode: true,
      runHistoryStorage: 'memory',
    })
    const listener = await listenOnEphemeralPort(offlineServer.app)

    try {
      // /readyz
      const readyRes = await fetch(`${listener.baseUrl}/readyz`)
      assert.equal(readyRes.status, 200)
      const readyBody = await readyRes.json()
      assert.equal(readyBody.ready, true)
      assert.equal(readyBody.offlineMode, true)
      assert.equal(readyBody.executionMode, 'offline-demo')
      assert.equal(readyBody.receiptMode, 'synthetic-stub')

      // /api/status
      const statusRes = await fetch(`${listener.baseUrl}/api/status`)
      assert.equal(statusRes.status, 200)
      const statusBody = await statusRes.json()
      assert.equal(statusBody.offlineMode, true)
      assert.equal(statusBody.demoMode, 'offline-deterministic')
      assert.equal(statusBody.executionMode, 'offline-demo')
      assert.equal(statusBody.receiptMode, 'synthetic-stub')
      assert.equal(statusBody.x402.offlineMode, true)
      assert.equal(statusBody.x402.syntheticReceipts, true)
      assert.equal(statusBody.x402.explorerLinksEnabled, false)
      assert.equal(statusBody.offlineFixtures.length, 3)

      // /api/wallet/balances
      const balRes = await fetch(`${listener.baseUrl}/api/wallet/balances`)
      assert.equal(balRes.status, 200)
      const balBody = await balRes.json()
      assert.equal(balBody.offlineMode, true)
      assert.equal(balBody.synthetic, true)
      assert.equal(balBody.wallets.orchestrator.available, true)
      assert.equal(balBody.wallets.server.available, true)

      // /api/wallet/transactions
      const txRes = await fetch(`${listener.baseUrl}/api/wallet/transactions?limit=2`)
      assert.equal(txRes.status, 200)
      const txBody = await txRes.json()
      assert.equal(txBody.offlineMode, true)
      assert.equal(txBody.synthetic, true)
      assert.equal(txBody.transactions.length, 2)
      for (const tx of txBody.transactions) {
        assert.equal(tx.synthetic, true)
        assert.equal(tx.explorerUrl, null)
        assert.equal(tx.hash.startsWith(SYNTHETIC_TX_PREFIX), true)
      }

      // /api/research & /api/premium/research
      const freeRes = await fetch(`${listener.baseUrl}/api/research?topic=Stellar+x402`)
      assert.equal(freeRes.status, 200)
      const freeBody = await freeRes.json()
      assert.equal(freeBody.offlineMode, true)
      assert.equal(freeBody.synthetic, true)
      assert.equal(freeBody.explorerUrl, null)

      const premRes = await fetch(`${listener.baseUrl}/api/premium/research?topic=Stellar+x402`)
      assert.equal(premRes.status, 200)
      const paymentHeader = premRes.headers.get('payment-response')
      assert.ok(paymentHeader)
      const parsedHeader = JSON.parse(paymentHeader)
      assert.equal(parsedHeader.synthetic, true)
      assert.equal(parsedHeader.offlineMode, true)
      assert.equal(parsedHeader.transaction.startsWith(SYNTHETIC_TX_PREFIX), true)
      const premBody = await premRes.json()
      assert.equal(premBody.offlineMode, true)
      assert.equal(premBody.synthetic, true)
      assert.equal(premBody.explorerUrl, null)

      // POST /api/orchestrate with fixture
      const orchRes = await fetch(`${listener.baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixture: 'budget-limited' }),
      })
      assert.equal(orchRes.status, 200)
      const orchBody = await orchRes.json()
      assert.equal(orchBody.offlineMode, true)
      assert.equal(orchBody.executionMode, 'offline-demo')
      assert.equal(orchBody.receiptMode, 'synthetic-stub')
      assert.equal(orchBody.scenario, 'budget-limited')
      assert.equal(orchBody.agentsUsed, 2)
      assert.equal(orchBody.agentsSkipped, 2)
      assert.equal(
        orchBody.payments.every((p) => p.synthetic && p.explorerUrl === null),
        true
      )

      // Verify persisted run in /api/runs/:id
      const runRes = await fetch(`${listener.baseUrl}/api/runs/${orchBody.runId}`)
      assert.equal(runRes.status, 200)
      const runRecord = await runRes.json()
      assert.equal(runRecord.status, 'completed')
      assert.equal(
        runRecord.events.every((e) => e.explorerUrl === null),
        true
      )
    } finally {
      await listener.close()
      offlineServer.close()
      setOfflineDemoMode(null)
    }
  })

  // Direct helper coverage for wallet balances/transactions
  const directBals = getOfflineWalletBalances('corr-1')
  assert.equal(directBals.offlineMode, true)
  const directTxs = getOfflineWalletTransactions(undefined, 5, 'corr-1')
  assert.equal(directTxs.offlineMode, true)
  assert.equal(
    directTxs.transactions.every((t) => t.explorerUrl === null),
    true
  )
})

console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
