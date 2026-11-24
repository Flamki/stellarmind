/**
 * Settlement reporting tests (issue #130).
 *
 * Validates that every payment record reports the asset and amount that
 * actually settled, that XLM never lands in a USDC total, and that the run
 * response separates quoted/reserved cost from settled totals. The four
 * required scenarios - x402-only, XLM-only, mixed, and unpaid - are driven
 * through the real orchestrator with stubbed payment and agent services, then
 * compared against the API result, broadcast events, persisted run history,
 * and the dashboard rendering code.
 *
 * Run: node tests/settlement-reporting.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildQuote,
  buildSettlement,
  noSettlement,
  summarizeSettledTotals,
  settledAmountForAsset,
  hasMixedSettledAssets,
  formatSettledTotals,
  XLM_FALLBACK_POLICY,
  SETTLEMENT_CONVERSION_POLICY,
} from '../src/agents/settlement.js'
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

// ─── Fixtures ────────────────────────────────────────────────────
const researchAgent = { id: 'research-bot', price: '0.01', currency: 'USDC' }
const analystAgent = { id: 'analyst-bot', price: '0.05', currency: 'USDC' }

const researchQuote = buildQuote(researchAgent, networkProfile)
const analystQuote = buildQuote(analystAgent, networkProfile)

const x402Settlement = (quote, hash) =>
  buildSettlement(quote, {
    method: 'x402',
    asset: quote.asset,
    issuer: quote.issuer,
    network: quote.network,
    amount: quote.amount,
    txHash: hash,
    explorerUrl: `https://explorer.test/tx/${hash}`,
  })

const xlmSettlement = (quote, hash) =>
  buildSettlement(quote, {
    method: 'stellar-xlm-direct',
    asset: XLM_FALLBACK_POLICY.asset,
    issuer: XLM_FALLBACK_POLICY.issuer,
    network: quote.network,
    amount: quote.amount,
    txHash: hash,
    explorerUrl: `https://explorer.test/tx/${hash}`,
    policy: XLM_FALLBACK_POLICY.id,
  })

// Stub payment paths -------------------------------------------------
function jsonResponse(body, headerValue) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        const key = String(name).toLowerCase()
        if (key === 'content-type') return 'application/json'
        if (key === 'payment-response' || key === 'x-payment-response') return headerValue
        return null
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function rejectionResponse(status = 400) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: 'rejected' }),
    text: async () => 'rejected',
  }
}

function stubX402Fetch(decide) {
  return async (url) => {
    const choice = decide(url)
    if (choice === 'reject') return rejectionResponse(400)
    return jsonResponse({ result: `x402:${choice}` }, JSON.stringify({ transaction: choice }))
  }
}

async function runScenario({ task, subtasks, x402Fetch, sendPayment }) {
  const events = []
  const paymentCalls = []
  const serviceCalls = []

  const serviceMap = {
    'research-bot': async (input) => {
      serviceCalls.push(['research-bot', input])
      return `research:${input}`
    },
    'analyst-bot': async (input) => {
      serviceCalls.push(['analyst-bot', input])
      return `analysis:${input}`
    },
  }

  const context = {
    plan: { plan: 'settlement test plan', subtasks },
    serviceMap,
  }
  if (x402Fetch !== undefined) context.x402Fetch = x402Fetch
  if (sendPayment !== undefined) {
    context.sendPayment = async (...args) => {
      paymentCalls.push(args)
      return sendPayment(...args)
    }
  }

  const result = await orchestrate(task, 1, (event) => events.push(event), context)
  return { result, events, paymentCalls, serviceCalls }
}

function findEvent(events, type) {
  return events.filter((event) => event.type === type)
}

async function persistRun(result, events) {
  const store = new InMemoryRunHistoryStore(10)
  const run = await store.createRun({ task: result.task, budget: result.budget, source: 'test' })
  for (const event of events) await store.appendEvent(run.id, event)
  await store.completeRun(run.id, result)
  return store.getRun(run.id)
}

const twoStepPlan = [
  { agentId: 'research-bot', input: 'research input', stepId: 'step-0' },
  { agentId: 'analyst-bot', input: 'analysis input', stepId: 'step-1' },
]

// ─── Pure settlement accounting ──────────────────────────────────
console.log('settlement records')

await test('a quote carries amount, asset, issuer and network', () => {
  assert.strictEqual(researchQuote.amount, '0.01')
  assert.strictEqual(researchQuote.asset, 'USDC')
  assert.strictEqual(researchQuote.issuer, networkProfile.usdc.issuer)
  assert.strictEqual(researchQuote.network, networkProfile.network)
  assert.deepStrictEqual(researchQuote.amountExact, {
    amount: '0.0100000',
    baseUnits: '100000',
    asset: 'USDC',
    precision: 7,
  })
})

await test('an x402 settlement reports USDC and its issuer', () => {
  const settlement = x402Settlement(researchQuote, 'tx-x402')
  assert.strictEqual(settlement.success, true)
  assert.strictEqual(settlement.asset, 'USDC')
  assert.strictEqual(settlement.amount, '0.01')
  assert.strictEqual(settlement.issuer, networkProfile.usdc.issuer)
  assert.strictEqual(settlement.network, networkProfile.network)
  assert.strictEqual(settlement.quotedAsset, 'USDC')
  assert.strictEqual(settlement.txHash, 'tx-x402')
})

await test('an XLM fallback settlement reports native XLM, with the demo policy', () => {
  const settlement = xlmSettlement(analystQuote, 'tx-xlm')
  assert.strictEqual(settlement.asset, 'XLM')
  assert.strictEqual(settlement.issuer, null)
  assert.strictEqual(settlement.amount, '0.05')
  assert.strictEqual(settlement.policy, XLM_FALLBACK_POLICY.id)
  // The quote is still USDC; only the settlement is XLM.
  assert.strictEqual(settlement.quotedAmount, '0.05')
  assert.strictEqual(settlement.quotedAsset, 'USDC')
})

await test('unpaid steps carry no settled asset or amount', () => {
  const unpaid = noSettlement()
  assert.strictEqual(unpaid.success, false)
  assert.strictEqual(unpaid.asset, null)
  assert.strictEqual(unpaid.amount, null)
})

console.log('per-asset totals')

await test('XLM is never added to a USDC settled total', () => {
  const totals = summarizeSettledTotals([
    x402Settlement(researchQuote, 'tx-usdc-1'),
    x402Settlement(analystQuote, 'tx-usdc-2'),
    xlmSettlement(analystQuote, 'tx-xlm'),
  ])

  assert.strictEqual(totals.length, 2)
  assert.strictEqual(settledAmountForAsset(totals, 'USDC'), '0.06')
  assert.strictEqual(settledAmountForAsset(totals, 'XLM'), '0.05')
  assert.strictEqual(formatSettledTotals(totals), '0.06 USDC + 0.05 XLM')
  assert.strictEqual(hasMixedSettledAssets(totals), true)
  // A naive sum would be 0.11; there must be no such single total anywhere.
  assert.ok(!totals.some((total) => total.asset === 'MIXED'))
})

await test('mixed quotes settle into separate exact per-asset totals', () => {
  const totals = summarizeSettledTotals([
    x402Settlement(researchQuote, 'tx-1'),
    xlmSettlement(analystQuote, 'tx-2'),
  ])
  assert.deepStrictEqual(
    totals.map(({ asset, amount }) => ({ asset, amount })),
    [
      { asset: 'USDC', amount: '0.01' },
      { asset: 'XLM', amount: '0.05' },
    ]
  )
})

await test('unpaid and failed settlements contribute nothing', () => {
  const totals = summarizeSettledTotals([
    noSettlement(),
    { success: false, asset: 'USDC', amount: '0.05' },
    x402Settlement(researchQuote, 'tx-usdc'),
  ])
  assert.strictEqual(totals.length, 1)
  assert.strictEqual(totals[0].asset, 'USDC')
  assert.strictEqual(totals[0].amount, '0.01')
})

await test('no conversion policy is applied across assets', () => {
  assert.strictEqual(SETTLEMENT_CONVERSION_POLICY.applied, false)
  assert.match(SETTLEMENT_CONVERSION_POLICY.reason, /never added across assets/)
})

// ─── API, event, and storage comparison per scenario ─────────────
console.log('run scenarios')

await test('x402-only run: quoted and settled totals agree in USDC', async () => {
  const { result, events } = await runScenario({
    task: 'x402 only',
    subtasks: twoStepPlan,
    x402Fetch: stubX402Fetch(() => 'x402-settled'),
    sendPayment: undefined,
  })

  assert.strictEqual(result.quotedTotal, '0.0600')
  assert.strictEqual(result.totalSpent, result.quotedTotal, 'totalSpent stays the reserved total')
  assert.deepStrictEqual(
    result.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [{ asset: 'USDC', amount: '0.06' }]
  )
  assert.strictEqual(result.settledSummary, '0.06 USDC')

  for (const payment of result.payments) {
    assert.strictEqual(payment.settlement.asset, 'USDC')
    assert.strictEqual(payment.settledAsset, 'USDC')
    assert.strictEqual(payment.settledAmount, payment.quotedAmount)
    assert.strictEqual(payment.paymentAttempt.settledAsset, 'USDC')
    assert.strictEqual(payment.paymentAttempt.settledAmount, payment.quotedAmount)
  }

  const paymentEvents = findEvent(events, 'payment')
  assert.strictEqual(paymentEvents.length, 2)
  for (const event of paymentEvents) {
    assert.strictEqual(event.asset, 'USDC')
    assert.strictEqual(event.amount, event.quotedAmount)
  }

  const run = await persistRun(result, events)
  assert.deepStrictEqual(
    run.summary.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [{ asset: 'USDC', amount: '0.06' }]
  )
  assert.strictEqual(run.summary.quotedTotal, '0.0600')
  for (const proof of run.txProofs) {
    assert.strictEqual(proof.asset, 'USDC')
    assert.strictEqual(proof.amount, proof.quotedAmount)
    assert.ok(proof.amountExact)
  }
})

await test('XLM-only run: settlement is XLM and no USDC total is fabricated', async () => {
  const { result, events, paymentCalls } = await runScenario({
    task: 'xlm only',
    subtasks: twoStepPlan,
    x402Fetch: null,
    sendPayment: async (_secret, _recipient, amount) => ({
      success: true,
      txHash: `xlm-${amount}`,
      explorerUrl: `https://explorer.test/tx/xlm-${amount}`,
    }),
  })

  // The quote is still USDC and drives the budget guardrail.
  assert.strictEqual(result.quotedTotal, '0.0600')
  assert.deepStrictEqual(
    result.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [{ asset: 'XLM', amount: '0.06' }]
  )
  assert.strictEqual(settledAmountForAsset(result.settledTotals, 'USDC'), null)
  assert.strictEqual(result.paymentProtocol, 'stellar-xlm')

  // The exact quoted decimal is transferred, not a re-formatted float.
  assert.deepStrictEqual(
    paymentCalls.map((call) => call[2]),
    ['0.01', '0.05']
  )

  for (const payment of result.payments) {
    assert.strictEqual(payment.paidVia, 'stellar-xlm-direct')
    assert.strictEqual(payment.settlement.asset, 'XLM')
    assert.strictEqual(payment.settledAsset, 'XLM')
    assert.strictEqual(payment.quotedAsset, 'USDC')
    assert.strictEqual(payment.settlement.policy, XLM_FALLBACK_POLICY.id)
    assert.strictEqual(payment.paymentAttempt.settledAsset, 'XLM')
  }

  const paymentEvents = findEvent(events, 'payment')
  assert.strictEqual(paymentEvents.length, 2)
  for (const event of paymentEvents) {
    assert.strictEqual(event.asset, 'XLM')
    assert.strictEqual(event.currency, 'XLM')
    assert.strictEqual(event.quotedAsset, 'USDC')
  }
  const responseEvents = findEvent(events, 'agent_response')
  for (const event of responseEvents) assert.strictEqual(event.settledAsset, 'XLM')

  const complete = findEvent(events, 'orchestrator_complete')[0]
  assert.strictEqual(complete.quotedTotal, '0.0600')
  assert.deepStrictEqual(
    complete.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [{ asset: 'XLM', amount: '0.06' }]
  )
  assert.strictEqual(complete.settledSummary, '0.06 XLM')

  const run = await persistRun(result, events)
  assert.deepStrictEqual(
    run.summary.settledTotals.map(({ asset }) => asset),
    ['XLM']
  )
  for (const proof of run.txProofs) {
    assert.strictEqual(proof.asset, 'XLM')
    assert.strictEqual(proof.issuer, null)
    assert.ok(proof.txHash.startsWith('xlm-'))
  }
  const persistedPayment = run.events.find((event) => event.type === 'payment')
  assert.strictEqual(persistedPayment.asset, 'XLM')
  assert.strictEqual(persistedPayment.quotedAsset, 'USDC')
})

await test('mixed run: USDC and XLM settle separately, not as one total', async () => {
  const { result, events } = await runScenario({
    task: 'mixed',
    subtasks: twoStepPlan,
    x402Fetch: stubX402Fetch((url) => (url.includes('research') ? 'x402-settled' : 'reject')),
    sendPayment: async () => ({
      success: true,
      txHash: 'xlm-fallback-tx',
      explorerUrl: 'https://explorer.test/tx/xlm-fallback-tx',
    }),
  })

  assert.strictEqual(result.quotedTotal, '0.0600')
  assert.strictEqual(result.paymentProtocol, 'mixed')
  assert.deepStrictEqual(
    result.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [
      { asset: 'USDC', amount: '0.01' },
      { asset: 'XLM', amount: '0.05' },
    ]
  )
  assert.strictEqual(result.settledSummary, '0.01 USDC + 0.05 XLM')
  // The USDC settled total must not absorb the 0.05 XLM step.
  assert.strictEqual(settledAmountForAsset(result.settledTotals, 'USDC'), '0.01')

  const paymentEvents = findEvent(events, 'payment')
  assert.strictEqual(paymentEvents.length, 2)
  assert.deepStrictEqual(
    paymentEvents.map((event) => [event.asset, event.amount]),
    [
      ['USDC', '0.01'],
      ['XLM', '0.05'],
    ]
  )

  const run = await persistRun(result, events)
  assert.deepStrictEqual(
    run.summary.settledTotals.map(({ asset, amount }) => ({ asset, amount })),
    [
      { asset: 'USDC', amount: '0.01' },
      { asset: 'XLM', amount: '0.05' },
    ]
  )
  assert.deepStrictEqual(
    run.txProofs.map((proof) => [proof.asset, proof.amount]),
    [
      ['USDC', '0.01'],
      ['XLM', '0.05'],
    ]
  )
})

await test('unpaid run: quote is reported, nothing is settled', async () => {
  const { result, events, paymentCalls } = await runScenario({
    task: 'unpaid',
    subtasks: twoStepPlan,
    x402Fetch: null,
    sendPayment: undefined,
  })

  assert.strictEqual(result.quotedTotal, '0.0600')
  assert.deepStrictEqual(result.settledTotals, [])
  assert.strictEqual(result.settledSummary, 'none')
  assert.strictEqual(result.settledPaymentCount, 0)
  assert.strictEqual(result.payments.length, 0)
  assert.strictEqual(result.unpaidCount, 2)
  assert.strictEqual(paymentCalls.length, 0)

  for (const step of result.results) {
    assert.strictEqual(step.settledAsset, null)
    assert.strictEqual(step.settledAmount, null)
    assert.strictEqual(step.quotedAsset, 'USDC')
  }
  assert.strictEqual(findEvent(events, 'payment').length, 0)

  const complete = findEvent(events, 'orchestrator_complete')[0]
  assert.deepStrictEqual(complete.settledTotals, [])
  assert.strictEqual(complete.settledSummary, 'none')

  const run = await persistRun(result, events)
  assert.deepStrictEqual(run.summary.settledTotals, [])
  assert.deepStrictEqual(run.txProofs, [])
})

// ─── Dashboard rendering fixtures ───────────────────────────────
console.log('dashboard rendering')

async function withRenderingModule(fn) {
  const sourcePath = path.join(__dirname, '..', 'public', 'assets', 'js', 'rendering.js')
  const source = await fs.readFile(sourcePath, 'utf8')
  const exportList = [
    'showResult',
    'renderRunDetail',
    'formatAssetTotals',
    'formatSettlementLabel',
  ].join(', ')
  const tempPath = path.join(__dirname, `.rendering-under-test-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(tempPath, `${source}\nexport { ${exportList} }\n`, 'utf8')

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
    const mod = await import(pathToFileURL(tempPath).href)
    await fn(mod, elements)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
    delete globalThis.document
    delete globalThis.escapeHtml
    delete globalThis.stopRunHeartbeat
    delete globalThis.renderLiveChips
    delete globalThis.pushLiveLine
    delete globalThis.activeRun
  }
}

const mixedRunFixture = {
  task: 'mixed dashboard fixture',
  quotedTotal: '0.0600',
  totalSpent: '0.0600',
  settledTotals: [
    { asset: 'USDC', issuer: 'issuer', network: 'stellar:testnet', amount: '0.01', count: 1 },
    { asset: 'XLM', issuer: null, network: 'stellar:testnet', amount: '0.05', count: 1 },
  ],
  settledSummary: '0.01 USDC + 0.05 XLM',
  results: [
    {
      agentId: 'research-bot',
      agentName: 'Research Agent',
      cost: '0.01',
      currency: 'USDC',
      quotedAmount: '0.01',
      quotedAsset: 'USDC',
      settledAmount: '0.01',
      settledAsset: 'USDC',
      settlement: { success: true, amount: '0.01', asset: 'USDC' },
      output: 'research output',
    },
    {
      agentId: 'analyst-bot',
      agentName: 'Analysis Agent',
      cost: '0.05',
      currency: 'USDC',
      quotedAmount: '0.05',
      quotedAsset: 'USDC',
      settledAmount: '0.05',
      settledAsset: 'XLM',
      settlement: { success: true, amount: '0.05', asset: 'XLM' },
      output: 'analysis output',
    },
  ],
  payments: [],
  agentsUsed: 2,
  txCount: 2,
  paymentProtocol: 'mixed',
  elapsed: '10ms',
  budgetExhausted: false,
}

const persistedRunFixture = {
  id: 'run-fixture',
  status: 'completed',
  task: 'mixed dashboard fixture',
  createdAt: '2026-10-21T00:00:00.000Z',
  completedAt: '2026-10-21T00:00:10.000Z',
  updatedAt: '2026-10-21T00:00:10.000Z',
  quotedTotal: '0.0600',
  budget: 1,
  summary: {
    quotedTotal: '0.0600',
    totalSpent: '0.0600',
    settledSummary: '0.01 USDC + 0.05 XLM',
    settledTotals: mixedRunFixture.settledTotals,
    budget: 1,
  },
  txProofs: [
    {
      method: 'x402',
      txHash: 'usdc-tx-hash',
      explorerUrl: 'https://explorer.test/usdc',
      amount: '0.01',
      asset: 'USDC',
    },
    {
      method: 'stellar-xlm-direct',
      txHash: 'xlm-tx-hash',
      explorerUrl: 'https://explorer.test/xlm',
      amount: '0.05',
      asset: 'XLM',
    },
  ],
  paymentAttempts: [
    {
      id: 'pay:run-fixture:analyst-bot',
      method: 'stellar-xlm-direct',
      outcome: 'confirmed',
      txHash: 'xlm-tx-hash',
      explorerUrl: 'https://explorer.test/xlm',
      amount: '0.05',
      currency: 'USDC',
      settledAmount: '0.05',
      settledAsset: 'XLM',
    },
  ],
  outputAvailable: true,
  output: [],
  results: [],
}

await test('showResult displays quoted cost and per-asset settled totals', async () => {
  await withRenderingModule(async (rendering, elements) => {
    rendering.showResult(mixedRunFixture)

    const chips = elements.get('result-chips').innerHTML
    assert.match(chips, /Quoted:.*0\.0600 USDC/s)
    assert.match(chips, /Settled:.*0\.01 USDC \+ 0\.05 XLM/s)

    const output = elements.get('result-out').textContent
    assert.match(output, /quoted 0\.05 USDC; settled 0\.05 XLM/)
    assert.match(output, /quoted 0\.01 USDC; settled 0\.01 USDC/)
  })
})

await test('renderRunDetail shows quoted cost and matching settled asset proofs', async () => {
  await withRenderingModule(async (rendering, elements) => {
    rendering.renderRunDetail(persistedRunFixture)

    assert.strictEqual(elements.get('detail-spent').textContent, '0.0600')
    assert.strictEqual(elements.get('detail-settled').textContent, '0.01 USDC + 0.05 XLM')

    const payments = elements.get('detail-payments').innerHTML
    assert.match(payments, /0\.01 USDC/)
    assert.match(payments, /0\.05 XLM/)
    assert.match(payments, /usdc-tx-hash/)
    assert.match(payments, /xlm-tx-hash/)
  })
})

await test('persisted proofs and dashboard use the same asset information', async () => {
  await withRenderingModule(async (rendering, elements) => {
    rendering.renderRunDetail(persistedRunFixture)
    const html = elements.get('detail-payments').innerHTML
    for (const proof of persistedRunFixture.txProofs) {
      assert.ok(
        html.includes(`${proof.amount} ${proof.asset}`),
        `dashboard must render proof ${proof.amount} ${proof.asset}`
      )
    }
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n${name}:\n${err.stack}`)
  }
  process.exit(1)
}
