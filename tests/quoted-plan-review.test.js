/**
 * Tests for Quoted Execution Plan Review UI & State Machine (Issue #166).
 *
 * Covers:
 *  - Preview shows per-step and total quoted service charges with their asset, selected agents, inputs, and dependency order.
 *  - Editing the task or budget invalidates the prior preview.
 *  - Only explicit confirmation starts execution, and repeated clicks produce one run.
 *  - Insufficient budget is flagged in preview and blocks execution.
 *  - Expired or changed quotes return the user to a clear review state.
 *
 * Run: node tests/quoted-plan-review.test.js
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

async function createDashboardHarness(fetchMock) {
  const renderingSource = await fs.readFile(
    path.join(__dirname, '..', 'public', 'assets', 'js', 'rendering.js'),
    'utf8'
  )
  const orchestrationSource = await fs.readFile(
    path.join(__dirname, '..', 'public', 'assets', 'js', 'orchestration.js'),
    'utf8'
  )

  const elements = new Map()
  let focusedElementId = null

  const makeElement = (id) => ({
    id,
    value: id === 'budget-slider' ? '0.15' : '',
    textContent: '',
    innerHTML: '',
    disabled: false,
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
    focus() {
      focusedElementId = id
    },
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

  // Pre-populate core elements
  documentMock.getElementById('task-input').value = 'Analyze Stellar DEX volume'
  documentMock.getElementById('budget-slider').value = '0.15'
  documentMock.getElementById('plan-preview-panel')
  documentMock.getElementById('result-panel')
  documentMock.getElementById('btn-run')
  documentMock.getElementById('btn-confirm-plan')

  const feedEvents = []
  let walletsLoaded = 0

  const sandbox = {
    console,
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
    parseFloat,
    parseInt,
    encodeURIComponent,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    document: documentMock,
    fetch: fetchMock,
    escapeHtml: (val) => String(val ?? ''),
    addFeed: (ev) => feedEvents.push(ev),
    loadWallets: () => {
      walletsLoaded += 1
    },
  }

  vm.createContext(sandbox)
  vm.runInContext(renderingSource, sandbox, { filename: 'rendering.js' })
  vm.runInContext(orchestrationSource, sandbox, { filename: 'orchestration.js' })

  return {
    sandbox,
    elements,
    feedEvents,
    getWalletsLoaded: () => walletsLoaded,
    getFocusedElementId: () => focusedElementId,
  }
}

console.log('--- Running Quoted Plan Review Tests (#166) ---')

await test('preview displays selected agents, inputs, dependency order, and per-step + total quoted charges with asset without starting execution', async () => {
  const apiCalls = []
  const futureExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { sandbox, elements } = await createDashboardHarness(async (url, opts) => {
    apiCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
    if (url === '/api/orchestrate/preview') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          planId: 'plan_review_1',
          task: 'Analyze Stellar DEX volume',
          budget: 0.15,
          plan: 'Step 1: Research DEX -> Step 2: Summarize findings',
          steps: [
            {
              agentId: 'research-bot',
              agentName: 'Research Agent',
              model: 'claude-sonnet-4-5',
              input: 'Analyze Stellar DEX volume',
              quote: '0.0100',
              currency: 'USDC',
            },
            {
              agentId: 'summary-bot',
              agentName: 'Summary Agent',
              model: 'claude-haiku-4-5',
              input: 'Summarize findings about: Analyze Stellar DEX volume',
              quote: '0.0100',
              currency: 'USDC',
            },
          ],
          totalQuote: '0.0200',
          expiresAt: futureExpiry,
        }),
      }
    }
    throw new Error(`Unexpected call to ${url}`)
  })

  // Calling runOrchestration() only previews the plan and does NOT start execution
  const preview = await sandbox.runOrchestration()

  assert.equal(apiCalls.length, 1)
  assert.equal(apiCalls[0].url, '/api/orchestrate/preview')
  assert.equal(preview.planId, 'plan_review_1')

  const state = sandbox.getReviewState()
  assert.equal(state.state, 'review')
  assert.equal(state.isRunning, false)

  const previewPanel = elements.get('plan-preview-panel')
  assert.equal(previewPanel.style.display, 'block')
  assert.equal(elements.get('preview-tag').textContent, 'Quote Ready')
  assert.equal(elements.get('preview-total-quote').textContent, '0.0200 USDC')
  assert.equal(elements.get('preview-budget').textContent, '0.15 USDC')
  assert.equal(elements.get('btn-confirm-plan').disabled, false)

  const stepsHtml = elements.get('preview-steps').innerHTML
  assert.match(stepsHtml, /#1 · Research Agent/)
  assert.match(stepsHtml, /0\.0100 USDC/)
  assert.match(stepsHtml, /Step 1 \(initial task input\)/)
  assert.match(stepsHtml, /#2 · Summary Agent/)
  assert.match(stepsHtml, /Step 2 \(depends on Step 1: Research Agent\)/)
  assert.match(stepsHtml, /Summarize findings about: Analyze Stellar DEX volume/)
})

await test('editing the task or budget invalidates the prior preview and prevents execution until re-previewed', async () => {
  const apiCalls = []
  const futureExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { sandbox, elements, getFocusedElementId } = await createDashboardHarness(
    async (url, opts) => {
      apiCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          planId: 'plan_edit_test',
          task: 'Analyze Stellar DEX volume',
          budget: 0.15,
          plan: 'Research only',
          steps: [
            {
              agentId: 'research-bot',
              agentName: 'Research Agent',
              input: 'Analyze Stellar DEX volume',
              quote: '0.0100',
              currency: 'USDC',
            },
          ],
          totalQuote: '0.0100',
          expiresAt: futureExpiry,
        }),
      }
    }
  )

  await sandbox.previewPlan()
  assert.equal(sandbox.getReviewState().preview.invalidated, false)
  assert.equal(elements.get('btn-confirm-plan').disabled, false)

  // Edit task input -> invalidates preview
  elements.get('task-input').value = 'Analyze Soroban smart contract fees'
  sandbox.handleTaskOrBudgetEdit()

  assert.equal(sandbox.getReviewState().preview.invalidated, true)
  assert.equal(elements.get('preview-tag').textContent, 'Preview Outdated')
  assert.equal(elements.get('btn-confirm-plan').disabled, true)
  assert.match(elements.get('preview-warning').textContent, /Task or budget changed/)

  // Attempting to confirm after task edit must NOT call /api/orchestrate/execute
  const execResult = await sandbox.confirmPlanExecution()
  assert.equal(execResult, null)
  assert.equal(apiCalls.length, 1, 'No execute request should be sent for an invalidated preview')

  // Re-preview with new task, then edit budget -> also invalidates preview
  await sandbox.previewPlan()
  assert.equal(sandbox.getReviewState().preview.invalidated, false)
  elements.get('budget-slider').value = '0.25'
  sandbox.handleTaskOrBudgetEdit()
  assert.equal(sandbox.getReviewState().preview.invalidated, true)
  assert.equal(elements.get('btn-confirm-plan').disabled, true)

  // Clicking Edit Task action focuses #task-input and invalidates
  await sandbox.previewPlan()
  sandbox.editTaskFromPreview()
  assert.equal(sandbox.getReviewState().preview.invalidated, true)
  assert.equal(getFocusedElementId(), 'task-input')
})

await test('only explicit confirmation starts execution and repeated double clicks produce exactly one run', async () => {
  const apiCalls = []
  const futureExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { sandbox, elements, getWalletsLoaded } = await createDashboardHarness(
    async (url, opts) => {
      apiCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
      if (url === '/api/orchestrate/preview') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            planId: 'plan_double_click_1',
            task: 'Analyze Stellar DEX volume',
            budget: 0.15,
            plan: 'Research -> Summary',
            steps: [
              {
                agentId: 'research-bot',
                agentName: 'Research Agent',
                input: 'Analyze Stellar DEX volume',
                quote: '0.0100',
                currency: 'USDC',
              },
            ],
            totalQuote: '0.0100',
            expiresAt: futureExpiry,
          }),
        }
      }
      if (url === '/api/orchestrate/execute') {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            runId: 'run_confirmed_1',
            task: 'Analyze Stellar DEX volume',
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
                output: 'Confirmed run output.',
              },
            ],
            payments: [],
            agentsUsed: 1,
            txCount: 1,
            paymentProtocol: 'x402',
            elapsed: '40ms',
          }),
        }
      }
      throw new Error(`Unexpected URL: ${url}`)
    }
  )

  await sandbox.previewPlan()
  assert.equal(apiCalls.filter((c) => c.url === '/api/orchestrate/execute').length, 0)

  // Trigger two concurrent confirmation clicks (double-click simulation)
  const [res1, res2] = await Promise.all([
    sandbox.confirmPlanExecution(),
    sandbox.confirmPlanExecution(),
  ])

  const executeCalls = apiCalls.filter((c) => c.url === '/api/orchestrate/execute')
  assert.equal(
    executeCalls.length,
    1,
    'Repeated confirmation clicks must produce only one execute request'
  )
  assert.equal(executeCalls[0].body.planId, 'plan_double_click_1')
  assert.ok(res1)
  assert.equal(res2, null)
  assert.equal(getWalletsLoaded(), 1)
  assert.equal(elements.get('plan-preview-panel').style.display, 'none')
  assert.match(elements.get('result-out').textContent, /Confirmed run output\./)
})

await test('insufficient budget is surfaced in preview and blocks confirmation', async () => {
  const apiCalls = []
  const futureExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { sandbox, elements } = await createDashboardHarness(async (url) => {
    apiCalls.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        planId: 'plan_over_budget',
        task: 'Analyze Stellar DEX volume',
        budget: 0.02,
        plan: 'Research + Analyst',
        steps: [
          {
            agentId: 'research-bot',
            agentName: 'Research Agent',
            input: 'Research',
            quote: '0.0100',
            currency: 'USDC',
          },
          {
            agentId: 'analyst-bot',
            agentName: 'Analyst Agent',
            input: 'Analyze',
            quote: '0.0500',
            currency: 'USDC',
          },
        ],
        totalQuote: '0.0600',
        expiresAt: futureExpiry,
      }),
    }
  })

  elements.get('budget-slider').value = '0.02'
  const preview = await sandbox.previewPlan()

  assert.equal(preview.insufficientBudget, true)
  assert.equal(elements.get('preview-tag').textContent, 'Insufficient Budget')
  assert.equal(elements.get('btn-confirm-plan').disabled, true)
  assert.match(elements.get('preview-warning').textContent, /exceeds the selected budget/)

  const execRes = await sandbox.confirmPlanExecution()
  assert.equal(execRes, null)
  assert.equal(apiCalls.includes('/api/orchestrate/execute'), false)
})

await test('expired or changed quotes return the user to a clear review state without rendering a completed run', async () => {
  let executeErrorResponse = {
    code: 'QUOTE_EXPIRED',
    message: 'Plan quote has expired. Please request a new preview.',
  }
  const futureExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  const { sandbox, elements } = await createDashboardHarness(async (url) => {
    if (url === '/api/orchestrate/preview') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          planId: 'plan_expiring_1',
          task: 'Analyze Stellar DEX volume',
          budget: 0.15,
          plan: 'Research workflow',
          steps: [
            {
              agentId: 'research-bot',
              agentName: 'Research Agent',
              input: 'Analyze Stellar DEX volume',
              quote: '0.0100',
              currency: 'USDC',
            },
          ],
          totalQuote: '0.0100',
          expiresAt: futureExpiry,
        }),
      }
    }
    if (url === '/api/orchestrate/execute') {
      return {
        ok: false,
        status: 400,
        json: async () => executeErrorResponse,
      }
    }
    throw new Error(`Unexpected URL: ${url}`)
  })

  // 1. Server returns QUOTE_EXPIRED
  await sandbox.previewPlan()
  const expiredRes = await sandbox.confirmPlanExecution()
  assert.equal(expiredRes, null)

  let state = sandbox.getReviewState()
  assert.equal(state.state, 'review')
  assert.equal(state.preview.expired, true)
  assert.equal(elements.get('plan-preview-panel').style.display, 'block')
  assert.equal(elements.get('preview-tag').textContent, 'Quote Expired')
  assert.equal(elements.get('btn-confirm-plan').disabled, true)
  assert.match(elements.get('preview-warning').textContent, /Plan quote has expired/)

  // 2. Server returns QUOTE_CHANGED after re-preview
  executeErrorResponse = {
    code: 'QUOTE_CHANGED',
    message:
      "Agent 'research-bot' pricing has changed from 0.01 to 0.02. Please request a new preview.",
  }
  await sandbox.previewPlan()
  const changedRes = await sandbox.confirmPlanExecution()
  assert.equal(changedRes, null)

  state = sandbox.getReviewState()
  assert.equal(state.state, 'review')
  assert.equal(state.preview.quoteChanged, true)
  assert.equal(elements.get('preview-tag').textContent, 'Quote Changed')
  assert.equal(elements.get('btn-confirm-plan').disabled, true)
  assert.match(elements.get('preview-warning').textContent, /pricing has changed/)
})

console.log(`\nResults: ${passed} passed, ${failures.length} failed.`)
if (failures.length > 0) {
  process.exit(1)
}
