/**
 * Tests for Run Report Export (JSON & Markdown) with verifiable receipts (Issue #167).
 *
 * Covers:
 *  - Exports include run ID, timestamps, step outcomes, provenance, and actual asset amounts.
 *  - Confirmed receipts include network and transaction hash; pending or synthetic receipts are labeled.
 *  - Exports omit deployment paths and credentials.
 *  - Downloading after restart produces the same substantive result as the run-detail page.
 *  - Validation across live-fixture, mixed-payment, failed, and legacy runs, verifying receipt links against stored network metadata.
 *
 * Run: node tests/run-report-export.test.js
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import {
  FileRunHistoryStore,
  InMemoryRunHistoryStore,
  REPORT_SCHEMA_VERSION,
  buildRunReport,
  formatRunReportMarkdown,
} from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'
import { STELLAR_TESTNET, getNetworkProfile, explorerTxUrl } from '../src/stellar/network.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n    ${err.message}`)
  }
}

async function createExportTestServer(store) {
  const app = express()
  app.use(express.json())
  app.use(requestId)

  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: async () => ({}),
    broadcast: () => {},
  })

  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  }
}

async function withRenderingModule(fn, fetchImpl = null) {
  const sourcePath = path.join(__dirname, '..', 'public', 'assets', 'js', 'rendering.js')
  const source = await fs.readFile(sourcePath, 'utf8')
  const exportList = [
    'showResult',
    'renderRunDetail',
    'formatAssetTotals',
    'formatSettlementLabel',
    'buildRunExportUrl',
    'exportRunReport',
  ].join(', ')
  const tempPath = path.join(
    __dirname,
    `.rendering-export-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  )
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
    click() {},
  })
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement: (tag) => makeElement(tag),
    body: makeElement('body'),
  }
  globalThis.escapeHtml = (value) => String(value ?? '')
  globalThis.stopRunHeartbeat = () => {}
  globalThis.renderLiveChips = () => {}
  globalThis.pushLiveLine = () => {}
  globalThis.activeRun = null

  const originalFetch = globalThis.fetch
  if (fetchImpl) {
    globalThis.fetch = fetchImpl
  }

  try {
    const mod = await import(pathToFileURL(tempPath).href)
    await fn(mod, elements)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
    globalThis.fetch = originalFetch
    delete globalThis.document
    delete globalThis.escapeHtml
    delete globalThis.stopRunHeartbeat
    delete globalThis.renderLiveChips
    delete globalThis.pushLiveLine
    delete globalThis.activeRun
  }
}

console.log('--- Running Run Report Export Tests (#167) ---')

const testnetProfile = getNetworkProfile(STELLAR_TESTNET)

await test('live-fixture run export includes run ID, timestamps, step outcomes, provenance, actual asset amounts, and verified receipt links', async () => {
  const store = new InMemoryRunHistoryStore(50)
  await store.init()

  const created = await store.createRun({
    task: 'Analyze Stellar x402 liquidity',
    budget: 0.1,
    source: 'POST /api/orchestrate',
  })

  const txHash1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0'
  const txHash2 = 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d'

  await store.completeRun(created.id, {
    task: 'Analyze Stellar x402 liquidity',
    budget: 0.1,
    plan: '1. Research liquidity -> 2. Summarize findings',
    totalSpent: '0.0200',
    quotedTotal: '0.0200',
    settledTotals: [
      {
        asset: 'USDC',
        issuer: testnetProfile.usdc.issuer,
        network: STELLAR_TESTNET,
        amount: '0.02',
        count: 2,
        txCount: 2,
      },
    ],
    settledSummary: '0.02 USDC',
    paymentProtocol: 'x402',
    txCount: 2,
    x402PaymentCount: 2,
    xlmFallbackCount: 0,
    unpaidCount: 0,
    budgetExhausted: false,
    elapsed: '420ms',
    results: [
      {
        stepId: 'step-0',
        agentId: 'research-bot',
        agentName: 'Research Agent',
        model: 'claude-sonnet-4-5',
        input: 'Analyze Stellar x402 liquidity',
        output: 'Live research findings on Stellar x402 channels.',
        cost: '0.01',
        currency: 'USDC',
        quotedAmount: '0.01',
        quotedAsset: 'USDC',
        settledAmount: '0.01',
        settledAsset: 'USDC',
        settledIssuer: testnetProfile.usdc.issuer,
        settledNetwork: STELLAR_TESTNET,
        paidVia: 'x402',
        paymentSuccess: true,
        txHash: txHash1,
        explorerUrl: explorerTxUrl(testnetProfile, txHash1),
        usage: {
          available: true,
          inputTokens: 120,
          outputTokens: 240,
          totalTokens: 360,
        },
      },
      {
        stepId: 'step-1',
        agentId: 'summary-bot',
        agentName: 'Summary Agent',
        model: 'claude-haiku-4-5',
        input: 'Summarize findings',
        output: 'Executive summary of Stellar x402 liquidity.',
        cost: '0.01',
        currency: 'USDC',
        quotedAmount: '0.01',
        quotedAsset: 'USDC',
        settledAmount: '0.01',
        settledAsset: 'USDC',
        settledIssuer: testnetProfile.usdc.issuer,
        settledNetwork: STELLAR_TESTNET,
        paidVia: 'x402',
        paymentSuccess: true,
        txHash: txHash2,
        explorerUrl: explorerTxUrl(testnetProfile, txHash2),
        usage: {
          available: true,
          inputTokens: 180,
          outputTokens: 90,
          totalTokens: 270,
        },
      },
    ],
    payments: [
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: txHash1,
        explorerUrl: explorerTxUrl(testnetProfile, txHash1),
        settledAmount: '0.01',
        settledAsset: 'USDC',
        settledIssuer: testnetProfile.usdc.issuer,
        settledNetwork: STELLAR_TESTNET,
        quotedAmount: '0.01',
        quotedAsset: 'USDC',
      },
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: txHash2,
        explorerUrl: explorerTxUrl(testnetProfile, txHash2),
        settledAmount: '0.01',
        settledAsset: 'USDC',
        settledIssuer: testnetProfile.usdc.issuer,
        settledNetwork: STELLAR_TESTNET,
        quotedAmount: '0.01',
        quotedAsset: 'USDC',
      },
    ],
  })

  const jsonExport = await store.exportRun(created.id, 'json')
  const parsed = JSON.parse(jsonExport.body)

  assert.equal(parsed.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(parsed.runId, created.id)
  assert.ok(parsed.timestamps.createdAt)
  assert.ok(parsed.timestamps.completedAt)
  assert.equal(parsed.provenance.mode, 'live')
  assert.equal(parsed.settledSummary, '0.02 USDC')
  assert.equal(parsed.steps.length, 2)
  assert.equal(parsed.steps[0].outcome, 'completed')
  assert.equal(parsed.steps[0].provenance.mode, 'live')
  assert.equal(parsed.steps[0].settlement.amount, '0.01')
  assert.equal(parsed.steps[0].settlement.asset, 'USDC')

  assert.equal(parsed.receipts.length, 2)
  for (const rcpt of parsed.receipts) {
    assert.equal(rcpt.status, 'confirmed')
    assert.equal(rcpt.verifiable, true)
    assert.equal(rcpt.network, STELLAR_TESTNET)
    assert.ok(rcpt.txHash)
    assert.equal(rcpt.explorerUrl, explorerTxUrl(testnetProfile, rcpt.txHash))
  }

  const mdExport = await store.exportRun(created.id, 'markdown')
  assert.match(mdExport.body, new RegExp(created.id))
  assert.match(mdExport.body, /\[CONFIRMED\]/)
  assert.match(mdExport.body, new RegExp(txHash1))
  assert.match(mdExport.body, /0\.02 USDC/)
})

await test('mixed-payment run with pending and synthetic receipts labels each receipt and reports per-asset amounts', async () => {
  const mixedRun = {
    id: 'run_mixed_167',
    status: 'completed',
    task: 'Mixed payment & synthetic check',
    budget: 0.1,
    createdAt: '2026-11-10T01:00:00.000Z',
    updatedAt: '2026-11-10T01:00:08.000Z',
    completedAt: '2026-11-10T01:00:08.000Z',
    quotedTotal: '0.0700',
    summary: {
      quotedTotal: '0.0700',
      totalSpent: '0.0700',
      settledTotals: [
        {
          asset: 'USDC',
          issuer: testnetProfile.usdc.issuer,
          network: STELLAR_TESTNET,
          amount: '0.01',
          count: 1,
          txCount: 1,
        },
        {
          asset: 'XLM',
          issuer: null,
          network: STELLAR_TESTNET,
          amount: '0.05',
          count: 1,
          txCount: 1,
        },
      ],
      settledSummary: '0.01 USDC + 0.05 XLM',
      budget: 0.1,
      paymentProtocol: 'mixed',
    },
    results: [
      {
        stepId: 'step-0',
        agentId: 'research-bot',
        agentName: 'Research Agent',
        output: 'USDC step output',
        cost: '0.01',
        currency: 'USDC',
        settledAmount: '0.01',
        settledAsset: 'USDC',
        settledNetwork: STELLAR_TESTNET,
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'tx_confirmed_usdc_1',
      },
      {
        stepId: 'step-1',
        agentId: 'analyst-bot',
        agentName: 'Analyst Agent',
        output: 'XLM fallback output',
        cost: '0.05',
        currency: 'USDC',
        settledAmount: '0.05',
        settledAsset: 'XLM',
        settledNetwork: STELLAR_TESTNET,
        paymentSuccess: true,
        paidVia: 'stellar-xlm-direct',
        txHash: 'tx_confirmed_xlm_2',
      },
      {
        stepId: 'step-2',
        agentId: 'summary-bot',
        agentName: 'Summary Agent',
        output: '[Demo Response] Synthetic step output',
        cost: '0.01',
        currency: 'USDC',
        settledAmount: '0.01',
        settledAsset: 'USDC',
        synthetic: true,
        paidVia: 'demo-stub',
        txHash: 'stub_tx_demo_3',
      },
      {
        stepId: 'step-3',
        agentId: 'code-bot',
        agentName: 'Code Agent',
        skipped: true,
        reason: 'Exceeded remaining budget',
        cost: '0.03',
        currency: 'USDC',
      },
    ],
    txProofs: [
      {
        method: 'x402',
        txHash: 'tx_confirmed_usdc_1',
        amount: '0.01',
        asset: 'USDC',
        network: STELLAR_TESTNET,
      },
      {
        method: 'stellar-xlm-direct',
        txHash: 'tx_confirmed_xlm_2',
        amount: '0.05',
        asset: 'XLM',
        network: STELLAR_TESTNET,
      },
      {
        method: 'demo-stub',
        txHash: 'stub_tx_demo_3',
        amount: '0.01',
        asset: 'USDC',
        network: STELLAR_TESTNET,
        synthetic: true,
      },
    ],
    paymentAttempts: [
      {
        id: 'pay:run_mixed_167:step-pending',
        stepId: 'step-pending',
        agentId: 'code-bot',
        outcome: 'unknown',
        method: 'x402',
        amount: '0.03',
        currency: 'USDC',
        network: STELLAR_TESTNET,
      },
    ],
  }

  const report = buildRunReport(mixedRun)
  assert.equal(report.settledSummary, '0.01 USDC + 0.05 XLM')
  assert.equal(report.steps.length, 4)
  assert.equal(report.steps[3].outcome, 'skipped')
  assert.equal(report.steps[2].provenance.mode, 'synthetic')

  const confirmedUsdc = report.receipts.find((r) => r.txHash === 'tx_confirmed_usdc_1')
  const confirmedXlm = report.receipts.find((r) => r.txHash === 'tx_confirmed_xlm_2')
  const syntheticReceipt = report.receipts.find((r) => r.txHash === 'stub_tx_demo_3')
  const pendingReceipt = report.receipts.find(
    (r) => r.receiptId === 'pay:run_mixed_167:step-pending'
  )

  assert.ok(confirmedUsdc)
  assert.equal(confirmedUsdc.status, 'confirmed')
  assert.equal(confirmedUsdc.asset, 'USDC')
  assert.equal(confirmedUsdc.amount, '0.01')
  assert.equal(confirmedUsdc.network, STELLAR_TESTNET)
  assert.equal(confirmedUsdc.explorerUrl, explorerTxUrl(testnetProfile, 'tx_confirmed_usdc_1'))

  assert.ok(confirmedXlm)
  assert.equal(confirmedXlm.status, 'confirmed')
  assert.equal(confirmedXlm.asset, 'XLM')
  assert.equal(confirmedXlm.amount, '0.05')

  assert.ok(syntheticReceipt)
  assert.equal(syntheticReceipt.status, 'synthetic')
  assert.equal(syntheticReceipt.verifiable, false)
  assert.equal(syntheticReceipt.explorerUrl, null, 'Synthetic receipts must never link to explorer')

  assert.ok(pendingReceipt)
  assert.equal(pendingReceipt.status, 'pending')
  assert.equal(pendingReceipt.verifiable, false)
  assert.equal(pendingReceipt.explorerUrl, null)

  const md = formatRunReportMarkdown(report)
  assert.match(md, /\[CONFIRMED\]/)
  assert.match(md, /\[SYNTHETIC\]/)
  assert.match(md, /\[PENDING\]/)
})

await test('failed and legacy runs export cleanly while redacting deployment paths and credentials', async () => {
  const secretStellarKey = 'S' + 'A'.repeat(55)
  const secretApiKey = 'sk-ant-api03-supersecretkeyvalue1234567890'
  const internalFilePath = '/home/deploy/stellarmind/data/run-history.json'

  const failedRun = {
    id: 'run_failed_167',
    status: 'failed',
    task: `Debug task from ${internalFilePath} using ${secretApiKey}`,
    budget: 0.05,
    filePath: internalFilePath,
    orchestratorSecret: secretStellarKey,
    apiKey: secretApiKey,
    createdAt: '2026-11-10T02:00:00.000Z',
    updatedAt: '2026-11-10T02:00:03.000Z',
    completedAt: '2026-11-10T02:00:03.000Z',
    error: {
      code: 'UPSTREAM_FAILURE',
      message: `Failed loading ${internalFilePath} with key ${secretApiKey} and signer ${secretStellarKey}`,
      stack: `Error at ${internalFilePath}:42:10`,
    },
    results: [
      {
        stepId: 'step-0',
        agentId: 'research-bot',
        error: `Step failed at /tmp/drips-wave11/stellarmind-b/src/server.js with Bearer secret_jwt_token_999`,
      },
    ],
  }

  const failedReport = buildRunReport(failedRun)
  const serialized = JSON.stringify(failedReport)
  const markdown = formatRunReportMarkdown(failedReport)

  assert.equal(failedReport.status, 'failed')
  assert.equal(failedReport.error.code, 'UPSTREAM_FAILURE')
  assert.equal(failedReport.steps[0].outcome, 'failed')

  for (const content of [serialized, markdown]) {
    assert.ok(!content.includes(secretStellarKey), 'Must omit Stellar secret key')
    assert.ok(!content.includes(secretApiKey), 'Must omit Anthropic API key')
    assert.ok(!content.includes(internalFilePath), 'Must omit deployment path')
    assert.ok(!content.includes('/tmp/drips-wave11'), 'Must omit temp deployment path')
    assert.ok(!content.includes('secret_jwt_token_999'), 'Must omit bearer token')
  }

  // Legacy run fixture: only events recorded, no summary.settledTotals or txProofs
  const legacyRun = {
    id: 'run_legacy_167',
    status: 'completed',
    task: 'Legacy run before structured settledTotals',
    budget: 0.05,
    createdAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T00:00:05.000Z',
    totalSpent: '0.0100',
    results: [
      {
        agentId: 'research-bot',
        result: 'Legacy research result text',
        cost: '0.01',
        currency: 'USDC',
      },
    ],
    events: [
      {
        type: 'x402_payment',
        agentId: 'research-bot',
        amount: '0.01',
        asset: 'USDC',
        network: STELLAR_TESTNET,
        txHash: 'legacy_tx_hash_abc123',
      },
    ],
  }

  const legacyReport = buildRunReport(legacyRun)
  assert.equal(legacyReport.runId, 'run_legacy_167')
  assert.equal(legacyReport.settledSummary, '0.01 USDC')
  assert.equal(legacyReport.receipts.length, 1)
  assert.equal(legacyReport.receipts[0].txHash, 'legacy_tx_hash_abc123')
  assert.equal(
    legacyReport.receipts[0].explorerUrl,
    explorerTxUrl(testnetProfile, 'legacy_tx_hash_abc123')
  )
})

await test('downloading after restart produces the same substantive result as the run-detail page', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-export-167-'))
  const historyFile = path.join(tempDir, 'run-history.json')

  try {
    // 1. Create and complete a run on initial store instance
    const storeBeforeRestart = new FileRunHistoryStore(historyFile, 50)
    await storeBeforeRestart.init()

    const created = await storeBeforeRestart.createRun({
      task: 'Cross-restart export parity verification',
      budget: 0.15,
      source: 'POST /api/orchestrate',
    })

    const txHash = '99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa'
    await storeBeforeRestart.completeRun(created.id, {
      task: 'Cross-restart export parity verification',
      budget: 0.15,
      plan: 'Step 1: Research -> Step 2: Summary',
      totalSpent: '0.0200',
      quotedTotal: '0.0200',
      settledTotals: [
        {
          asset: 'USDC',
          issuer: testnetProfile.usdc.issuer,
          network: STELLAR_TESTNET,
          amount: '0.02',
          count: 1,
          txCount: 1,
        },
      ],
      settledSummary: '0.02 USDC',
      paymentProtocol: 'x402',
      txCount: 1,
      x402PaymentCount: 1,
      xlmFallbackCount: 0,
      unpaidCount: 0,
      budgetExhausted: false,
      elapsed: '250ms',
      results: [
        {
          stepId: 'step-0',
          agentId: 'research-bot',
          agentName: 'Research Agent',
          output: 'Persisted step output across restart.',
          cost: '0.02',
          currency: 'USDC',
          settledAmount: '0.02',
          settledAsset: 'USDC',
          settledNetwork: STELLAR_TESTNET,
          paidVia: 'x402',
          paymentSuccess: true,
          txHash,
          explorerUrl: explorerTxUrl(testnetProfile, txHash),
        },
      ],
      payments: [
        {
          paymentSuccess: true,
          paidVia: 'x402',
          txHash,
          explorerUrl: explorerTxUrl(testnetProfile, txHash),
          settledAmount: '0.02',
          settledAsset: 'USDC',
          settledIssuer: testnetProfile.usdc.issuer,
          settledNetwork: STELLAR_TESTNET,
          quotedAmount: '0.02',
          quotedAsset: 'USDC',
        },
      ],
    })
    await storeBeforeRestart.flush()

    // 2. Simulate server restart by initializing a fresh FileRunHistoryStore on the same file
    const storeAfterRestart = new FileRunHistoryStore(historyFile, 50)
    await storeAfterRestart.init()

    const { server, baseUrl } = await createExportTestServer(storeAfterRestart)
    try {
      const detailRes = await fetch(`${baseUrl}/api/runs/${created.id}`)
      assert.equal(detailRes.status, 200)
      const detailData = await detailRes.json()

      const exportJsonRes = await fetch(`${baseUrl}/api/runs/${created.id}/export?format=json`)
      assert.equal(exportJsonRes.status, 200)
      assert.match(exportJsonRes.headers.get('content-disposition') || '', /attachment; filename=/)
      const exportedReport = await exportJsonRes.json()

      const exportMdRes = await fetch(`${baseUrl}/api/runs/${created.id}/export?format=markdown`)
      assert.equal(exportMdRes.status, 200)
      const exportedMarkdown = await exportMdRes.text()

      // Render in dashboard run-detail view and compare with exported report
      const nativeFetch = globalThis.fetch
      await withRenderingModule(
        async (rendering, elements) => {
          rendering.renderRunDetail(detailData)

          assert.match(elements.get('detail-run-id').innerHTML, new RegExp(exportedReport.runId))
          assert.equal(elements.get('detail-status').textContent, exportedReport.status)
          assert.equal(elements.get('detail-task').textContent, exportedReport.task)
          assert.equal(elements.get('detail-spent').textContent, exportedReport.quotedTotal)
          assert.equal(elements.get('detail-settled').textContent, exportedReport.settledSummary)
          assert.equal(elements.get('detail-plan').textContent, exportedReport.plan)
          assert.match(
            elements.get('detail-outputs').innerHTML,
            new RegExp(exportedReport.steps[0].output)
          )
          assert.match(
            elements.get('detail-payments').innerHTML,
            new RegExp(exportedReport.receipts[0].txHash.slice(0, 12))
          )

          // Verify client-side export helper downloads the same report
          const clientExport = await rendering.exportRunReport(created.id, 'json')
          assert.equal(clientExport.data.runId, exportedReport.runId)
          assert.equal(clientExport.data.settledSummary, exportedReport.settledSummary)
          assert.equal(clientExport.data.steps[0].output, exportedReport.steps[0].output)
        },
        (url, opts) => nativeFetch(`${baseUrl}${url}`, opts)
      )

      assert.match(exportedMarkdown, new RegExp(exportedReport.runId))
      assert.match(exportedMarkdown, new RegExp(exportedReport.steps[0].output))
      assert.match(exportedMarkdown, new RegExp(txHash))
    } finally {
      server.close()
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

console.log(`\nResults: ${passed} passed, ${failures.length} failed.`)
if (failures.length > 0) {
  process.exit(1)
}
