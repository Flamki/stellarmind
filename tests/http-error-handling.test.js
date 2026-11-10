/**
 * Tests for Shared HTTP JSON Helper & Non-Success Response Handling (Issue #164).
 *
 * Covers:
 *  - Non-2xx responses (400 validation, 429 throttling, 500 server error) cannot produce a successful run display.
 *  - Structured API errors show a readable message and correlation ID.
 *  - Non-JSON (HTML error body, truncated JSON) and interrupted/dropped connections have a usable fallback message.
 *  - Run controls reset after errors, and retrying does not accidentally reuse stale progress.
 *  - Page loaders (status, transactions, history, run detail) surface structured errors with correlation IDs.
 *
 * Run: node tests/http-error-handling.test.js
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

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

async function createFrontendHarness(fetchMock) {
  const renderingSource = await fs.readFile(
    path.join(__dirname, '..', 'public', 'assets', 'js', 'rendering.js'),
    'utf8'
  )
  const orchestrationSource = await fs.readFile(
    path.join(__dirname, '..', 'public', 'assets', 'js', 'orchestration.js'),
    'utf8'
  )
  const pagesSource = await fs.readFile(
    path.join(__dirname, '..', 'public', 'assets', 'js', 'pages.js'),
    'utf8'
  )

  const elements = new Map()
  const makeElement = (id) => ({
    id,
    value: id === 'budget-slider' ? '0.15' : '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    className: '',
    style: { display: 'none', width: '0%' },
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      classes: new Set(),
      add(c) {
        this.classes.add(c)
      },
      remove(c) {
        this.classes.delete(c)
      },
      contains(c) {
        return this.classes.has(c)
      },
    },
    prepend(child) {
      this.children.unshift(child)
    },
    appendChild(child) {
      this.children.push(child)
    },
    removeChild(child) {
      const idx = this.children.indexOf(child)
      if (idx !== -1) this.children.splice(idx, 1)
    },
    focus() {},
  })

  const documentMock = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement(tag) {
      return makeElement(tag)
    },
  }

  documentMock.getElementById('task-input').value = 'Research Stellar payment channels'
  documentMock.getElementById('budget-slider').value = '0.15'
  documentMock.getElementById('btn-run').innerHTML = 'Run Agents'
  documentMock.getElementById('result-panel')
  documentMock.getElementById('result-tag')

  const feedEvents = []

  const sandbox = {
    console: { ...console, error: () => {} },
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Promise,
    JSON,
    URLSearchParams,
    parseFloat,
    parseInt,
    isNaN,
    encodeURIComponent,
    setInterval: () => 42,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    alert: () => {},
    document: documentMock,
    fetch: fetchMock,
    addFeed: (ev) => feedEvents.push(ev),
    loadWallets: () => {},
  }

  vm.createContext(sandbox)
  vm.runInContext(renderingSource, sandbox, { filename: 'rendering.js' })
  vm.runInContext(orchestrationSource, sandbox, { filename: 'orchestration.js' })
  vm.runInContext(pagesSource, sandbox, { filename: 'pages.js' })

  return { sandbox, elements, feedEvents }
}

function makeResponse({
  status = 200,
  ok = status >= 200 && status < 300,
  body = {},
  rawText = null,
  headers = {},
}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])
  )
  const textBody = rawText !== null ? rawText : JSON.stringify(body)
  return {
    status,
    ok,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null
      },
    },
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  }
}

console.log('--- Running HTTP Error Handling Tests (#164) ---')

await test('successful 200 JSON response renders completion normally', async () => {
  const { sandbox, elements } = await createFrontendHarness(async () =>
    makeResponse({
      status: 200,
      body: {
        task: 'Research Stellar payment channels',
        quotedTotal: '0.0100',
        totalSpent: '0.0100',
        settledTotals: [{ asset: 'USDC', amount: '0.01' }],
        results: [
          {
            agentId: 'research-bot',
            agentName: 'Research Agent',
            cost: '0.01',
            currency: 'USDC',
            settledAmount: '0.01',
            settledAsset: 'USDC',
            output: 'Verified Stellar research output.',
          },
        ],
        payments: [],
        agentsUsed: 1,
        txCount: 1,
        paymentProtocol: 'x402',
        elapsed: '120ms',
      },
    })
  )

  await sandbox.runOrchestration()

  assert.equal(elements.get('result-tag').textContent, 'Complete')
  assert.equal(elements.get('result-tag').className, 'tag green')
  assert.match(elements.get('result-out').textContent, /FINAL ANSWER/)
  assert.match(elements.get('result-out').textContent, /Verified Stellar research output\./)
  assert.equal(elements.get('btn-run').disabled, false)
  assert.equal(elements.get('btn-run').innerHTML, 'Run Agents')
})

await test('structured 400 validation failure, 429 throttling, and 500 server error show readable messages + correlation IDs and never render a successful run', async () => {
  const scenarios = [
    {
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid orchestration request',
        requestId: 'corr-val-400',
        details: [{ field: 'task', message: 'Task contains invalid characters' }],
      },
      expectedCode: 'VALIDATION_ERROR',
      expectedText: /Invalid orchestration request.*task: Task contains invalid characters/,
      expectedId: 'corr-val-400',
    },
    {
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        requestId: 'corr-rate-429',
        retryAfter: 12,
      },
      expectedCode: 'RATE_LIMITED',
      expectedText: /Too many requests.*Retry after 12s/,
      expectedId: 'corr-rate-429',
    },
    {
      status: 500,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'Upstream planner unavailable',
        requestId: 'corr-srv-500',
      },
      expectedCode: 'INTERNAL_ERROR',
      expectedText: /Upstream planner unavailable/,
      expectedId: 'corr-srv-500',
    },
  ]

  for (const scenario of scenarios) {
    const { sandbox, elements, feedEvents } = await createFrontendHarness(async () =>
      makeResponse({
        status: scenario.status,
        body: scenario.body,
      })
    )

    await sandbox.runOrchestration()

    assert.notEqual(
      elements.get('result-tag').textContent,
      'Complete',
      `HTTP ${scenario.status} must never show Complete tag`
    )
    assert.equal(elements.get('result-tag').textContent, 'Error')
    assert.ok(
      !elements.get('result-out').textContent.includes('FINAL ANSWER'),
      `HTTP ${scenario.status} must never render FINAL ANSWER`
    )
    assert.match(elements.get('result-out').textContent, new RegExp(scenario.expectedCode))
    assert.match(elements.get('result-status-line').textContent, scenario.expectedText)
    assert.match(elements.get('result-status-line').textContent, new RegExp(scenario.expectedId))
    assert.match(elements.get('result-chips').innerHTML, new RegExp(scenario.expectedId))
    assert.equal(elements.get('btn-run').disabled, false)
    assert.equal(elements.get('btn-run').innerHTML, 'Run Agents')
    assert.ok(
      feedEvents.some((ev) => ev.type === 'error' && ev.message.includes(scenario.expectedId))
    )
  }
})

await test('HTML error body, non-JSON 200 body, and dropped connection produce usable fallback messages', async () => {
  // 1. HTML 502 Bad Gateway response
  {
    const { sandbox, elements } = await createFrontendHarness(async () =>
      makeResponse({
        status: 502,
        rawText: '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>',
        headers: { 'x-correlation-id': 'corr-html-502', 'content-type': 'text/html' },
      })
    )

    await sandbox.runOrchestration()
    assert.equal(elements.get('result-tag').textContent, 'Error')
    assert.match(elements.get('result-status-line').textContent, /HTTP 502 non-JSON response/)
    assert.match(elements.get('result-status-line').textContent, /corr-html-502/)
    assert.equal(elements.get('btn-run').disabled, false)
  }

  // 2. Interrupted / truncated 200 JSON body
  {
    const { sandbox, elements } = await createFrontendHarness(async () =>
      makeResponse({
        status: 200,
        rawText: '{"task":"truncated...',
        headers: { 'x-correlation-id': 'corr-trunc-200' },
      })
    )

    await sandbox.runOrchestration()
    assert.equal(elements.get('result-tag').textContent, 'Error')
    assert.match(elements.get('result-status-line').textContent, /interrupted or non-JSON response/)
    assert.match(elements.get('result-status-line').textContent, /corr-trunc-200/)
  }

  // 3. Dropped connection / network rejection
  {
    const { sandbox, elements } = await createFrontendHarness(async () => {
      throw new TypeError('Failed to fetch: connection reset by peer')
    })

    await sandbox.runOrchestration()
    assert.equal(elements.get('result-tag').textContent, 'Error')
    assert.match(
      elements.get('result-status-line').textContent,
      /Connection failed or was interrupted.*connection reset by peer/
    )
    assert.equal(elements.get('btn-run').disabled, false)
    assert.equal(elements.get('btn-run').innerHTML, 'Run Agents')
  }
})

await test('run controls reset after error and retrying does not reuse stale progress', async () => {
  let attempt = 0
  let harnessRef = null

  const harness = await createFrontendHarness(async () => {
    attempt += 1
    if (attempt === 1) {
      // Simulate SSE progress events arriving before the first HTTP request fails mid-flight
      harnessRef.sandbox.trackLiveEvent({
        type: 'orchestrator_plan',
        subtaskCount: 3,
        plan: 'Stale plan from failed run',
      })
      harnessRef.sandbox.trackLiveEvent({
        type: 'agent_response',
        agentId: 'research-bot',
        agent: 'Research Agent',
        cost: '0.05',
        resultPreview: 'Stale partial result',
      })
      return makeResponse({
        status: 503,
        body: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Temporary failure during first attempt',
          requestId: 'corr-attempt-1',
        },
      })
    }

    // On retry (attempt 2), verify stale progress from attempt 1 was cleared when startLiveRun ran
    const progressBeforeComplete = harnessRef.sandbox.getRunProgressInfo()
    assert.equal(progressBeforeComplete.planned, 0, 'Retry must start with planned = 0')
    assert.equal(progressBeforeComplete.completed, 0, 'Retry must start with completed = 0')
    assert.match(
      harnessRef.elements.get('result-chips').innerHTML,
      /Spent:.*0\.00 \/ 0\.15 USDC/,
      'Retry must reset spent amount to 0.00'
    )

    return makeResponse({
      status: 200,
      body: {
        task: 'Research Stellar payment channels',
        quotedTotal: '0.0100',
        totalSpent: '0.0100',
        settledTotals: [{ asset: 'USDC', amount: '0.01' }],
        results: [
          {
            agentId: 'research-bot',
            agentName: 'Research Agent',
            cost: '0.01',
            currency: 'USDC',
            settledAmount: '0.01',
            settledAsset: 'USDC',
            output: 'Fresh retry result.',
          },
        ],
        payments: [],
        agentsUsed: 1,
        txCount: 1,
        paymentProtocol: 'x402',
        elapsed: '50ms',
      },
    })
  })
  harnessRef = harness

  // First attempt fails
  await harness.sandbox.runOrchestration()
  assert.equal(harness.elements.get('result-tag').textContent, 'Error')
  assert.equal(harness.elements.get('btn-run').disabled, false)
  assert.equal(harness.elements.get('progress-fill').style.width, '0%')

  // Second attempt (retry) succeeds without stale progress from attempt 1
  await harness.sandbox.runOrchestration()
  assert.equal(harness.elements.get('result-tag').textContent, 'Complete')
  assert.match(harness.elements.get('result-out').textContent, /Fresh retry result\./)
  assert.match(harness.elements.get('result-chips').innerHTML, /Progress:.*1\/1/)
  assert.match(harness.elements.get('result-chips').innerHTML, /Spent:.*0\.01 \/ 0\.15 USDC/)
})

await test('page loaders (status, transactions, history, run detail) display readable error and correlation ID on non-2xx responses', async () => {
  const { sandbox, elements } = await createFrontendHarness(async (url) =>
    makeResponse({
      status: 503,
      body: {
        code: 'UPSTREAM_ERROR',
        errorType: 'UPSTREAM_ERROR',
        message: `Service unavailable for ${url}`,
        requestId: 'corr-page-503',
      },
    })
  )

  await sandbox.loadStatusPage()
  assert.match(elements.get('status-grid').innerHTML, /Service unavailable for \/api\/status/)
  assert.match(elements.get('status-grid').innerHTML, /corr-page-503/)

  await sandbox.loadTxPage()
  assert.match(
    elements.get('tx-body').innerHTML,
    /Service unavailable for \/api\/wallet\/transactions/
  )
  assert.match(elements.get('tx-body').innerHTML, /corr-page-503/)

  await sandbox.loadHistoryPage()
  assert.match(elements.get('history-empty').innerHTML, /Service unavailable for \/api\/runs/)
  assert.match(elements.get('history-empty').innerHTML, /corr-page-503/)

  await sandbox.openRunDetail('run_missing_99')
  assert.match(
    elements.get('history-detail-error').innerHTML,
    /Service unavailable for \/api\/runs\/run_missing_99/
  )
  assert.match(elements.get('history-detail-error').innerHTML, /corr-page-503/)
})

console.log(`\nResults: ${passed} passed, ${failures.length} failed.`)
if (failures.length > 0) {
  process.exit(1)
}
