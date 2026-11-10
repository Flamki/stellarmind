/**
 * Stellar network fee reporting tests (issue #161).
 *
 * Verifies:
 *  1. Fee policy has documented units (stroops / XLM), defaults (100 stroops /
 *     0.00001 XLM), and maximum cap (10,000 stroops / 0.001 XLM).
 *  2. Receipts, run results, and persisted run history distinguish quoted
 *     service charge, settled transfer, and network fee without adding network
 *     fees into quoted or settled agent totals.
 *  3. Unknown and pending fees are explicitly marked rather than fabricated as 0.
 *  4. UI formatting in pages.js and rendering.js preserves small XLM fee values
 *     (e.g. 0.00001 XLM / 100 stroops, 0.0000001 XLM / 1 stroop) without
 *     rounding them to 0.00 XLM.
 *
 * Run: node tests/network-fee-reporting.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Keypair, Account } from '@stellar/stellar-sdk'

import {
  DEFAULT_BASE_FEE_STROOPS,
  DEFAULT_MAX_FEE_STROOPS,
  HARD_MAX_FEE_STROOPS,
  MIN_BASE_FEE_STROOPS,
  STELLAR_STROOPS_PER_XLM,
  buildPaymentReceipt,
  buildQuote,
  buildSettlement,
  formatNetworkFee,
  normalizeNetworkFee,
  resolveDirectPaymentFee,
  resolveStellarFeePolicy,
  stroopsToXlmString,
  summarizeNetworkFees,
  summarizeSettledTotals,
  xlmToStroopsString,
} from '../src/agents/settlement.js'
import {
  getTransactions,
  normalizeTransactionFee,
  sendPayment,
  clearOperationsCache,
} from '../src/stellar/wallet.js'
import { orchestrate } from '../src/agents/orchestrator.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import { resolveNetworkProfile } from '../src/stellar/network.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const networkProfile = resolveNetworkProfile({})

const failures = []
let passed = 0

function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          passed += 1
          console.log(`  ✓ ${name}`)
        },
        (err) => {
          failures.push({ name, err })
          console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
        }
      )
    }
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
  return Promise.resolve()
}

// ─── 1. Fee Policy & Unit Conversion ─────────────────────────────
console.log('fee policy and unit conversion')

await test('fee policy exposes documented units, defaults, and maximum bounds', () => {
  const policy = resolveStellarFeePolicy()
  assert.strictEqual(policy.unit, 'stroops')
  assert.strictEqual(policy.asset, 'XLM')
  assert.strictEqual(policy.stroopsPerXlm, Number(STELLAR_STROOPS_PER_XLM))
  assert.strictEqual(policy.minBaseFeeStroops, MIN_BASE_FEE_STROOPS)
  assert.strictEqual(policy.minBaseFeeXlm, '0.00001')
  assert.strictEqual(policy.defaultBaseFeeStroops, DEFAULT_BASE_FEE_STROOPS)
  assert.strictEqual(policy.defaultBaseFeeXlm, '0.00001')
  assert.strictEqual(policy.defaultMaxFeeStroops, DEFAULT_MAX_FEE_STROOPS)
  assert.strictEqual(policy.defaultMaxFeeXlm, '0.001')
  assert.strictEqual(policy.hardMaxFeeStroops, HARD_MAX_FEE_STROOPS)
  assert.strictEqual(policy.hardMaxFeeXlm, '0.1')
  assert.strictEqual(policy.baseFeeStroops, 100)
  assert.strictEqual(policy.baseFeeXlm, '0.00001')
  assert.strictEqual(policy.maxFeeStroops, 10000)
  assert.strictEqual(policy.maxFeeXlm, '0.001')
})

await test('stroops <-> XLM conversion preserves exact 7-decimal precision', () => {
  assert.strictEqual(stroopsToXlmString(1), '0.0000001')
  assert.strictEqual(stroopsToXlmString(100), '0.00001')
  assert.strictEqual(stroopsToXlmString(250), '0.000025')
  assert.strictEqual(stroopsToXlmString(10000), '0.001')
  assert.strictEqual(stroopsToXlmString(10000000), '1')
  assert.strictEqual(xlmToStroopsString('0.0000001'), '1')
  assert.strictEqual(xlmToStroopsString('0.00001'), '100')
  assert.strictEqual(xlmToStroopsString('0.001'), '10000')

  const normalized = normalizeNetworkFee({ fee_charged: '100', max_fee: '1000' })
  assert.strictEqual(formatNetworkFee(normalized), '0.00001 XLM (100 stroops)')
  const txFee = normalizeTransactionFee({ fee_charged: '250', successful: true })
  assert.strictEqual(txFee.amount, '0.000025')
  const summary = summarizeNetworkFees([normalized, txFee])
  assert.strictEqual(summary.amount, '0.000035')
  assert.strictEqual(summary.stroops, '350')
})

await test('fee policy rejects out-of-range base or maximum fee configurations', () => {
  assert.throws(
    () => resolveStellarFeePolicy({ baseFeeStroops: 50 }),
    (err) =>
      err.code === 'INVALID_FEE_POLICY' && /cannot be less than Stellar minimum/.test(err.message)
  )
  assert.throws(
    () => resolveStellarFeePolicy({ baseFeeStroops: 500, maxFeeStroops: 200 }),
    (err) => err.code === 'INVALID_FEE_POLICY' && /cannot exceed maxFeeStroops/.test(err.message)
  )
  assert.throws(
    () => resolveStellarFeePolicy({ maxFeeStroops: HARD_MAX_FEE_STROOPS + 1 }),
    (err) => err.code === 'INVALID_FEE_POLICY' && /exceeds hard safety ceiling/.test(err.message)
  )
})

await test('resolveDirectPaymentFee enforces maximum fee cap and supports explicit clamping', () => {
  const policy = resolveStellarFeePolicy({ baseFeeStroops: 200, maxFeeStroops: 1000 })
  const withinBounds = resolveDirectPaymentFee({ feeStroops: 500 }, policy)
  assert.strictEqual(withinBounds.feeStroops, '500')
  assert.strictEqual(withinBounds.feeXlm, '0.00005')
  assert.strictEqual(withinBounds.clamped, false)

  assert.throws(
    () => resolveDirectPaymentFee({ feeStroops: 2500 }, policy),
    (err) =>
      err.code === 'FEE_EXCEEDS_MAXIMUM' && /exceeds configured maximum fee/.test(err.message)
  )

  const clamped = resolveDirectPaymentFee({ feeStroops: 2500, clampFee: true }, policy)
  assert.strictEqual(clamped.feeStroops, '1000')
  assert.strictEqual(clamped.feeXlm, '0.0001')
  assert.strictEqual(clamped.clamped, true)
})

// ─── 2. Ledger Response Fixtures (sendPayment & getTransactions) ─
console.log('ledger response fixtures')

function makeStubHorizonServer({ submitResult, txRecords = [], opsByHash = {} }) {
  return {
    serverURL: 'https://horizon-testnet.stellar.org',
    async loadAccount(publicKey) {
      return new Account(publicKey, '1000')
    },
    async submitTransaction(tx) {
      if (typeof submitResult === 'function') return submitResult(tx)
      return submitResult
    },
    transactions() {
      return {
        forAccount() {
          return this
        },
        order() {
          return this
        },
        limit() {
          return this
        },
        cursor() {
          return this
        },
        async call() {
          return { records: txRecords }
        },
      }
    },
    operations() {
      return {
        forTransaction(hash) {
          this._hash = hash
          return this
        },
        order() {
          return this
        },
        limit() {
          return this
        },
        async call() {
          return { records: opsByHash[this._hash] || [] }
        },
      }
    },
  }
}

await test('sendPayment normalizes different ledger fee_charged fixtures and enforces max fee', async () => {
  const sender = Keypair.random()
  const recipient = Keypair.random().publicKey()
  let submittedTxFee = null

  const horizon100 = makeStubHorizonServer({
    submitResult(tx) {
      submittedTxFee = String(tx.fee)
      return {
        hash: 'tx-fee-100',
        ledger: 4201,
        successful: true,
        fee_charged: '100',
        max_fee: '250',
      }
    },
  })

  const res100 = await sendPayment(sender.secret(), recipient, '0.05', 'pay:research-bot', {
    horizonServer: horizon100,
    feeStroops: 250,
    feePolicy: { baseFeeStroops: 100, maxFeeStroops: 1000 },
  })

  assert.strictEqual(res100.success, true)
  assert.strictEqual(submittedTxFee, '250')
  assert.strictEqual(res100.feeCharged, '100')
  assert.strictEqual(res100.feeChargedStroops, '100')
  assert.strictEqual(res100.feeChargedXlm, '0.00001')
  assert.strictEqual(res100.maxFeeStroops, '250')
  assert.strictEqual(res100.maxFeeXlm, '0.000025')
  assert.strictEqual(res100.feeStatus, 'confirmed')
  assert.strictEqual(res100.networkFee.status, 'confirmed')
  assert.strictEqual(res100.networkFee.amount, '0.00001')
  assert.strictEqual(res100.networkFee.stroops, '100')

  // Higher surge fee fixture (3500 stroops = 0.00035 XLM)
  const horizonSurge = makeStubHorizonServer({
    submitResult: {
      hash: 'tx-fee-3500',
      ledger: 4202,
      successful: true,
      fee_charged: '3500',
      max_fee: '5000',
    },
  })
  const resSurge = await sendPayment(sender.secret(), recipient, '0.05', 'pay:analyst-bot', {
    horizonServer: horizonSurge,
    feeStroops: 5000,
    feePolicy: { baseFeeStroops: 100, maxFeeStroops: 5000 },
  })
  assert.strictEqual(resSurge.success, true)
  assert.strictEqual(resSurge.feeChargedStroops, '3500')
  assert.strictEqual(resSurge.feeChargedXlm, '0.00035')

  // Pending ledger outcome fixture
  const horizonPending = makeStubHorizonServer({
    submitResult: {
      hash: 'tx-pending',
      status: 'PENDING',
      pending: true,
      max_fee: '100',
    },
  })
  const resPending = await sendPayment(sender.secret(), recipient, '0.05', 'pay:summary-bot', {
    horizonServer: horizonPending,
  })
  assert.strictEqual(resPending.success, false)
  assert.strictEqual(resPending.pending, true)
  assert.strictEqual(resPending.feeStatus, 'pending')
  assert.strictEqual(resPending.networkFee.status, 'pending')
  assert.strictEqual(resPending.networkFee.amount, null)

  // Rejects fee exceeding policy maximum before hitting Horizon
  const resExceeded = await sendPayment(sender.secret(), recipient, '0.05', 'pay:code-bot', {
    horizonServer: horizon100,
    feeStroops: 50000,
    feePolicy: { baseFeeStroops: 100, maxFeeStroops: 10000 },
  })
  assert.strictEqual(resExceeded.success, false)
  assert.strictEqual(resExceeded.errorCode, 'FEE_EXCEEDS_MAXIMUM')
})

await test('getTransactions normalizes confirmed, surge, pending, and unknown fees', async () => {
  clearOperationsCache()
  const accountKey = Keypair.random().publicKey()
  const stubServer = makeStubHorizonServer({
    txRecords: [
      {
        hash: 'tx-100',
        paging_token: 'pt-1',
        ledger: 10,
        created_at: '2026-10-21T00:00:00Z',
        memo: 'pay:research',
        memo_type: 'text',
        fee_charged: '100',
        max_fee: '100',
        operation_count: 1,
        successful: true,
      },
      {
        hash: 'tx-surge',
        paging_token: 'pt-2',
        ledger: 11,
        created_at: '2026-10-21T00:01:00Z',
        memo: 'pay:analyst',
        memo_type: 'text',
        fee_charged: '4200',
        max_fee: '10000',
        operation_count: 1,
        successful: true,
      },
      {
        hash: 'tx-pending',
        paging_token: 'pt-3',
        ledger: null,
        created_at: '2026-10-21T00:02:00Z',
        memo: null,
        memo_type: 'none',
        pending: true,
        max_fee: '200',
        operation_count: 1,
        successful: null,
      },
      {
        hash: 'tx-unknown',
        paging_token: 'pt-4',
        ledger: 12,
        created_at: '2026-10-21T00:03:00Z',
        memo: null,
        memo_type: 'none',
        operation_count: 1,
        successful: true,
      },
    ],
    opsByHash: {
      'tx-100': [{ id: 'op-1', type: 'payment', amount: '0.0100000', asset_type: 'native' }],
    },
  })

  const out = await getTransactions(accountKey, 10, null, 'desc', { horizonServer: stubServer })
  assert.strictEqual(out.success, true)
  assert.strictEqual(out.transactions.length, 4)

  const [t1, t2, t3, t4] = out.transactions
  assert.strictEqual(t1.feeStatus, 'confirmed')
  assert.strictEqual(t1.feeChargedStroops, '100')
  assert.strictEqual(t1.feeChargedXlm, '0.00001')

  assert.strictEqual(t2.feeStatus, 'confirmed')
  assert.strictEqual(t2.feeChargedStroops, '4200')
  assert.strictEqual(t2.feeChargedXlm, '0.00042')

  assert.strictEqual(t3.feeStatus, 'pending')
  assert.strictEqual(t3.feeChargedStroops, null)
  assert.strictEqual(t3.feeChargedXlm, null)

  assert.strictEqual(t4.feeStatus, 'unknown')
  assert.strictEqual(t4.feeChargedStroops, null)
  assert.strictEqual(t4.feeChargedXlm, null)
})

// ─── 3. Receipts & Orchestrator Separation ───────────────────────
console.log('receipts and orchestrator fee separation')

await test('receipts distinguish quoted service charge, settled transfer, and network fee', () => {
  const quote = buildQuote({ id: 'analyst-bot', price: '0.05', currency: 'USDC' }, networkProfile)
  const settlement = buildSettlement(quote, {
    method: 'stellar-xlm-direct',
    asset: 'XLM',
    issuer: null,
    network: quote.network,
    amount: '0.05',
    txHash: 'tx-direct-1',
    fee_charged: '100',
    max_fee: '1000',
  })
  const receipt = buildPaymentReceipt({
    quote,
    settlement,
    stepId: 'step-0',
    agentId: 'analyst-bot',
    agentName: 'Analysis Agent',
  })

  assert.strictEqual(receipt.quotedServiceCharge.amount, '0.05')
  assert.strictEqual(receipt.quotedServiceCharge.asset, 'USDC')
  assert.strictEqual(receipt.settledTransfer.amount, '0.05')
  assert.strictEqual(receipt.settledTransfer.asset, 'XLM')
  assert.strictEqual(receipt.networkFee.status, 'confirmed')
  assert.strictEqual(receipt.networkFee.amount, '0.00001')
  assert.strictEqual(receipt.networkFee.stroops, '100')
  assert.strictEqual(receipt.networkFee.asset, 'XLM')

  // Settled totals must NEVER include the 0.00001 XLM network fee
  const settledTotals = summarizeSettledTotals([settlement])
  assert.strictEqual(settledTotals.length, 1)
  assert.strictEqual(settledTotals[0].asset, 'XLM')
  assert.strictEqual(settledTotals[0].amount, '0.05')
})

await test('orchestrate separates service charges, settled transfers, and network fees across confirmed, unknown, and pending steps', async () => {
  const events = []
  const subtasks = [
    { agentId: 'research-bot', input: 'research topic', stepId: 'step-0' },
    { agentId: 'analyst-bot', input: 'analyze topic', stepId: 'step-1' },
    { agentId: 'summary-bot', input: 'summarize topic', stepId: 'step-2' },
  ]
  const serviceMap = {
    'research-bot': async () => 'research result',
    'analyst-bot': async () => 'analyst result',
    'summary-bot': async () => 'summary result',
  }

  // Step 0: x402 succeeds without reporting ledger fee -> networkFee status 'unknown'
  // Step 1: x402 returns 400 -> falls back to direct XLM transfer with fee_charged: '250' stroops (0.000025 XLM) -> 'confirmed'
  // Step 2: x402 throws transport error -> unresolved payment attempt -> networkFee status 'pending'
  const x402Fetch = async (url) => {
    if (url.includes('/api/premium/research')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            const k = String(name).toLowerCase()
            if (k === 'content-type') return 'application/json'
            if (k === 'payment-response') return JSON.stringify({ transaction: 'tx-x402-1' })
            return null
          },
        },
        json: async () => ({ result: 'x402 research' }),
        text: async () => JSON.stringify({ result: 'x402 research' }),
      }
    }
    if (url.includes('/api/premium/analyze')) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => ({ error: 'rejected' }),
        text: async () => 'rejected',
      }
    }
    throw new Error('network timeout during x402 settlement')
  }

  const sendPaymentStub = async () => ({
    success: true,
    txHash: 'tx-xlm-250',
    explorerUrl: 'https://explorer.test/tx/tx-xlm-250',
    fee_charged: '250',
    max_fee: '1000',
  })

  const result = await orchestrate('fee separation run', 1, (ev) => events.push(ev), {
    plan: { plan: 'three step fee test', subtasks },
    serviceMap,
    x402Fetch,
    sendPayment: sendPaymentStub,
  })

  // Quoted total is strictly 0.01 + 0.05 + 0.01 = 0.0700 USDC
  assert.strictEqual(result.quotedTotal, '0.0700')
  // Settled totals are 0.01 USDC and 0.05 XLM (never including 0.000025 XLM fee)
  assert.deepStrictEqual(
    result.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [
      { asset: 'USDC', amount: '0.01' },
      { asset: 'XLM', amount: '0.05' },
    ]
  )

  // Step-by-step receipt and network fee verification
  const [step0, step1, step2] = result.results
  assert.strictEqual(step0.networkFee.status, 'unknown')
  assert.strictEqual(step0.receipt.quotedServiceCharge.amount, '0.01')
  assert.strictEqual(step0.receipt.settledTransfer.amount, '0.01')
  assert.strictEqual(step0.receipt.settledTransfer.asset, 'USDC')

  assert.strictEqual(step1.networkFee.status, 'confirmed')
  assert.strictEqual(step1.networkFee.stroops, '250')
  assert.strictEqual(step1.networkFee.amount, '0.000025')
  assert.strictEqual(step1.receipt.quotedServiceCharge.amount, '0.05')
  assert.strictEqual(step1.receipt.settledTransfer.amount, '0.05')
  assert.strictEqual(step1.receipt.settledTransfer.asset, 'XLM')

  assert.strictEqual(step2.networkFee.status, 'pending')
  assert.strictEqual(step2.receipt.quotedServiceCharge.amount, '0.01')
  assert.strictEqual(step2.receipt.settledTransfer.settled, false)

  // Run-level network fee summary
  assert.strictEqual(result.networkFees.status, 'partial')
  assert.strictEqual(result.networkFees.amount, '0.000025')
  assert.strictEqual(result.networkFees.stroops, '250')
  assert.strictEqual(result.networkFees.confirmedCount, 1)
  assert.strictEqual(result.networkFees.unknownCount, 1)
  assert.strictEqual(result.networkFees.pendingCount, 1)
  assert.strictEqual(result.networkFeeSummary, '0.000025 XLM (250 stroops) + 1 pending + 1 unknown')

  // Persist in run history and verify persisted proofs and summary
  const store = new InMemoryRunHistoryStore(10)
  const created = await store.createRun({ task: result.task, budget: result.budget })
  for (const ev of events) await store.appendEvent(created.id, ev)
  await store.completeRun(created.id, result)

  const persisted = await store.getRun(created.id)
  assert.strictEqual(
    persisted.summary.networkFeeSummary,
    '0.000025 XLM (250 stroops) + 1 pending + 1 unknown'
  )
  assert.strictEqual(persisted.txProofs.length, 2)
  assert.strictEqual(persisted.txProofs[0].networkFee.status, 'unknown')
  assert.strictEqual(persisted.txProofs[1].networkFee.status, 'confirmed')
  assert.strictEqual(persisted.txProofs[1].networkFee.amount, '0.000025')
  assert.strictEqual(persisted.txProofs[1].networkFee.stroops, '250')
})

// ─── 4. UI Formatting & Rendering (pages.js & rendering.js) ──────
console.log('UI formatting and rendering')

async function withFrontendModules(fn) {
  const pagesPath = path.join(__dirname, '..', 'public', 'assets', 'js', 'pages.js')
  const renderingPath = path.join(__dirname, '..', 'public', 'assets', 'js', 'rendering.js')
  const pagesSource = await fs.readFile(pagesPath, 'utf8')
  const renderingSource = await fs.readFile(renderingPath, 'utf8')

  const tempPagesPath = path.join(__dirname, `.pages-under-test-${process.pid}-${Date.now()}.mjs`)
  const tempRenderingPath = path.join(
    __dirname,
    `.rendering-fee-under-test-${process.pid}-${Date.now()}.mjs`
  )

  await fs.writeFile(
    tempPagesPath,
    `${pagesSource}\nexport { loadTxPage, stroopsToXlmDisplay, formatXlmAmount, formatNetworkFee }\n`,
    'utf8'
  )
  await fs.writeFile(
    tempRenderingPath,
    `${renderingSource}\nexport { showResult, renderRunDetail, formatXlmAmount, formatNetworkFeeLabel, formatNetworkFeeSummary }\n`,
    'utf8'
  )

  const elements = new Map()
  const makeElement = (id) => ({
    id,
    textContent: '',
    innerHTML: '',
    style: {},
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    classList: { add() {}, remove() {} },
    prepend() {},
    appendChild() {},
    removeChild() {},
  })
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement: (tag) => makeElement(tag),
  }
  globalThis.escapeHtml = (value) => String(value ?? '')
  globalThis.stopRunHeartbeat = () => {}
  globalThis.renderLiveChips = () => {}
  globalThis.pushLiveLine = () => {}
  globalThis.activeRun = null

  try {
    const pagesMod = await import(pathToFileURL(tempPagesPath).href)
    const renderingMod = await import(pathToFileURL(tempRenderingPath).href)
    await fn({ pagesMod, renderingMod, elements })
  } finally {
    await fs.unlink(tempPagesPath).catch(() => {})
    await fs.unlink(tempRenderingPath).catch(() => {})
    delete globalThis.document
    delete globalThis.escapeHtml
    delete globalThis.stopRunHeartbeat
    delete globalThis.renderLiveChips
    delete globalThis.pushLiveLine
    delete globalThis.activeRun
  }
}

await test('UI formatting preserves small XLM fee values without rounding to zero', async () => {
  await withFrontendModules(async ({ pagesMod, renderingMod }) => {
    assert.strictEqual(pagesMod.formatXlmAmount('0.00001'), '0.00001 XLM')
    assert.strictEqual(pagesMod.formatXlmAmount('0.0000001'), '0.0000001 XLM')
    assert.strictEqual(pagesMod.formatXlmAmount(0.00001), '0.00001 XLM')
    assert.strictEqual(
      pagesMod.formatXlmAmount('0.00001', { minDecimals: 2, maxDecimals: 7 }),
      '0.00001 XLM'
    )
    assert.strictEqual(
      pagesMod.formatNetworkFee({ feeCharged: '100', feeStatus: 'confirmed' }),
      '0.00001 XLM (100 stroops)'
    )
    assert.strictEqual(pagesMod.formatNetworkFee({ feeStatus: 'pending' }), 'pending')
    assert.strictEqual(pagesMod.formatNetworkFee({ feeStatus: 'unknown' }), 'unknown')

    assert.strictEqual(
      renderingMod.formatNetworkFeeLabel({
        networkFee: { status: 'confirmed', amount: '0.00001', stroops: '100', asset: 'XLM' },
      }),
      '0.00001 XLM (100 stroops)'
    )
    assert.strictEqual(
      renderingMod.formatNetworkFeeLabel({
        networkFee: { status: 'pending', amount: null, stroops: null, asset: 'XLM' },
      }),
      'pending'
    )
  })
})

await test('loadTxPage renders small XLM transfers and confirmed/pending/unknown network fees', async () => {
  const nativeFetch = globalThis.fetch
  await withFrontendModules(async ({ pagesMod, elements }) => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        transactions: [
          {
            hash: 'abcdef1234567890abcdef1234567890',
            created_at: '2026-10-21T00:00:00Z',
            memo: 'pay:research',
            memo_type: 'text',
            feeCharged: '100',
            feeChargedStroops: '100',
            feeChargedXlm: '0.00001',
            feeStatus: 'confirmed',
            operations: [{ type: 'payment', amount: '0.00001', asset_code: 'XLM' }],
          },
          {
            hash: '1234567890abcdef1234567890abcdef',
            created_at: '2026-10-21T00:01:00Z',
            memo: 'pay:pending',
            memo_type: 'text',
            feeStatus: 'pending',
            operations: [{ type: 'payment', amount: '0.05', asset_code: 'XLM' }],
          },
        ],
      }),
    })

    try {
      await pagesMod.loadTxPage()
      const txBody = elements.get('tx-body').innerHTML
      // Must NOT round 0.00001 XLM to 0.00 XLM
      assert.match(txBody, /0\.00001 XLM/)
      assert.doesNotMatch(txBody, />0\.00 XLM</)
      assert.match(txBody, /Network fee: 0\.00001 XLM \(100 stroops\)/)
      assert.match(txBody, /Network fee: pending/)
    } finally {
      globalThis.fetch = nativeFetch
    }
  })
})

await test('showResult and renderRunDetail display network fees separately from quoted and settled charges', async () => {
  await withFrontendModules(async ({ renderingMod, elements }) => {
    const runFixture = {
      id: 'run-fee-fixture',
      status: 'completed',
      task: 'fee rendering test',
      quotedTotal: '0.0600',
      totalSpent: '0.0600',
      budget: 1,
      settledTotals: [
        { asset: 'USDC', amount: '0.01', count: 1 },
        { asset: 'XLM', amount: '0.05', count: 1 },
      ],
      settledSummary: '0.01 USDC + 0.05 XLM',
      networkFees: {
        status: 'partial',
        amount: '0.00001',
        stroops: '100',
        asset: 'XLM',
        summary: '0.00001 XLM (100 stroops) + 1 unknown',
      },
      networkFeeSummary: '0.00001 XLM (100 stroops) + 1 unknown',
      results: [
        {
          agentId: 'research-bot',
          agentName: 'Research Agent',
          cost: '0.01',
          currency: 'USDC',
          settledAmount: '0.01',
          settledAsset: 'USDC',
          settlement: { success: true, amount: '0.01', asset: 'USDC' },
          networkFee: { status: 'unknown', amount: null, stroops: null, asset: 'XLM' },
          output: 'research output',
        },
        {
          agentId: 'analyst-bot',
          agentName: 'Analysis Agent',
          cost: '0.05',
          currency: 'USDC',
          settledAmount: '0.05',
          settledAsset: 'XLM',
          settlement: { success: true, amount: '0.05', asset: 'XLM' },
          networkFee: { status: 'confirmed', amount: '0.00001', stroops: '100', asset: 'XLM' },
          output: 'analysis output',
        },
      ],
      txProofs: [
        {
          method: 'x402',
          txHash: 'tx-usdc-hash-123456',
          explorerUrl: 'https://explorer.test/tx/usdc',
          amount: '0.01',
          asset: 'USDC',
          quotedAmount: '0.01',
          quotedAsset: 'USDC',
          networkFee: { status: 'unknown', amount: null, stroops: null, asset: 'XLM' },
        },
        {
          method: 'stellar-xlm-direct',
          txHash: 'tx-xlm-hash-654321',
          explorerUrl: 'https://explorer.test/tx/xlm',
          amount: '0.05',
          asset: 'XLM',
          quotedAmount: '0.05',
          quotedAsset: 'USDC',
          networkFee: { status: 'confirmed', amount: '0.00001', stroops: '100', asset: 'XLM' },
        },
      ],
      paymentAttempts: [
        {
          id: 'pay:run-fee-fixture:summary-bot',
          method: 'x402',
          outcome: 'unknown',
          amount: '0.01',
          currency: 'USDC',
          quotedAmount: '0.01',
          quotedAsset: 'USDC',
          networkFee: { status: 'pending', amount: null, stroops: null, asset: 'XLM' },
        },
      ],
      payments: [],
      agentsUsed: 2,
      txCount: 2,
      paymentProtocol: 'mixed',
      elapsed: '12ms',
    }

    renderingMod.showResult(runFixture)
    const chips = elements.get('result-chips').innerHTML
    assert.match(chips, /Quoted:.*0\.0600 USDC/s)
    assert.match(chips, /Settled:.*0\.01 USDC \+ 0\.05 XLM/s)
    assert.match(chips, /Network Fee:.*0\.00001 XLM \(100 stroops\) \+ 1 unknown/s)

    const outText = elements.get('result-out').textContent
    assert.match(outText, /quoted 0\.01 USDC; settled 0\.01 USDC; network fee unknown/)
    assert.match(
      outText,
      /quoted 0\.05 USDC; settled 0\.05 XLM; network fee 0\.00001 XLM \(100 stroops\)/
    )

    renderingMod.renderRunDetail(runFixture)
    assert.strictEqual(
      elements.get('detail-network-fee').textContent,
      '0.00001 XLM (100 stroops) + 1 unknown'
    )
    const detailPayments = elements.get('detail-payments').innerHTML
    assert.match(detailPayments, /network fee: unknown/)
    assert.match(detailPayments, /network fee: 0\.00001 XLM \(100 stroops\)/)
    assert.match(detailPayments, /network fee: pending/)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n${name}:\n${err.stack}`)
  }
  process.exit(1)
}
