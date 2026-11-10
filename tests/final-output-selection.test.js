/**
 * Explicit Final Output Selection & Presentation Tests (Issue #173)
 *
 * Covers:
 *  - Plan validation assigns or validates `finalStepId` and rejects unknown step references.
 *  - Intermediate summary + final code step selects the final code step (`step-2`) rather than
 *    guessing `summary-bot` or `analyst-bot`, with zero unquoted synthesis calls.
 *  - Failed final step reports `available: false, status: 'failed', partialResultsAvailable: true`
 *    and renders a clear partial-result presentation in the dashboard and run history detail view.
 *  - Budget-skipped final step reports `available: false, status: 'skipped', partialResultsAvailable: true`.
 *  - Empty plan reports `available: false, status: 'empty_plan', stepId: null`.
 *  - API response, run-history persistence, export endpoint (`/api/runs/:id/export`), and dashboard
 *    rendering (`public/assets/js/rendering.js`) agree on `finalStepId` and `finalOutput`.
 *
 * Run: node tests/final-output-selection.test.js
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  validatePlan,
  buildFallbackPlan,
  resolveFinalOutput,
} from '../src/agents/plan-validator.js'
import { orchestrate, previewOrchestration } from '../src/agents/orchestrator.js'
import { InMemoryRunHistoryStore, buildRunExportPayload } from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

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

/**
 * Loads `public/assets/js/rendering.js` into an isolated VM context with a
 * lightweight DOM stub so `showResult`, `renderRunDetail`, `resolveRunFinalOutput`,
 * and `formatRunExport` can be tested directly against fixture runs.
 */
async function createDashboardRenderingHarness() {
  const renderingSource = await fs.readFile(
    path.join(repoRoot, 'public', 'assets', 'js', 'rendering.js'),
    'utf8'
  )

  const elements = new Map()
  function getOrCreateElement(id) {
    if (!elements.has(id)) {
      const el = {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        style: {},
        children: [],
        scrollTop: 0,
        scrollHeight: 0,
        classList: {
          _set: new Set(),
          add(...names) {
            names.forEach((n) => this._set.add(n))
          },
          remove(...names) {
            names.forEach((n) => this._set.delete(n))
          },
          contains(name) {
            return this._set.has(name)
          },
        },
        prepend(child) {
          this.children.unshift(child)
        },
        removeChild(child) {
          const idx = this.children.indexOf(child)
          if (idx !== -1) this.children.splice(idx, 1)
        },
        get lastChild() {
          return this.children[this.children.length - 1] || null
        },
      }
      elements.set(id, el)
    }
    return elements.get(id)
  }

  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    activeRun: {
      startedAt: Date.now() - 1000,
      planned: 3,
      completed: 0,
      spent: 0,
      budget: 0.15,
      running: true,
    },
    stopRunHeartbeat: () => {},
    escapeHtml: (str) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => getOrCreateElement(id),
      createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        innerHTML: '',
        style: {},
      }),
    },
  }

  vm.createContext(sandbox)
  vm.runInContext(renderingSource, sandbox, { filename: 'public/assets/js/rendering.js' })

  return {
    sandbox,
    elements,
    getElement: getOrCreateElement,
  }
}

console.log('Explicit Final Output Contract & Dashboard Rendering (Issue #173)')

await test('validatePlan defaults finalStepId to last step, accepts valid override, and rejects unknown finalStepId', () => {
  const defaultPlan = validatePlan({
    plan: 'Research, summarize, then generate code',
    subtasks: [
      { agentId: 'research-bot', input: 'Gather Stellar x402 specs' },
      { agentId: 'summary-bot', input: 'Condense specs into notes' },
      { agentId: 'code-bot', input: 'Implement payment client from notes' },
    ],
  })
  assert.equal(defaultPlan.valid, true)
  assert.equal(defaultPlan.plan.finalStepId, 'step-2')

  const explicitEarlierStep = validatePlan({
    plan: 'Explicit final step override',
    finalStepId: 'step-1',
    subtasks: [
      { agentId: 'research-bot', input: 'Gather specs' },
      { agentId: 'analyst-bot', input: 'Produce final risk assessment' },
    ],
  })
  assert.equal(explicitEarlierStep.valid, true)
  assert.equal(explicitEarlierStep.plan.finalStepId, 'step-1')

  const invalidFinalRef = validatePlan({
    plan: 'Bad final step reference',
    finalStepId: 'step-99',
    subtasks: [{ agentId: 'research-bot', input: 'Gather specs' }],
  })
  assert.equal(invalidFinalRef.valid, false)
  assert.equal(invalidFinalRef.reason, 'invalid_final_step_id')

  const emptyFallback = buildFallbackPlan('Zero budget task', 0)
  assert.equal(emptyFallback.subtasks.length, 0)
  assert.equal(emptyFallback.finalStepId, null)
})

await test('Intermediate summary + final code step selects the final code step and makes no unquoted synthesis call', async () => {
  const plan = {
    plan: 'Research -> intermediate summary -> final code implementation',
    subtasks: [
      { stepId: 'step-0', agentId: 'research-bot', input: 'Research x402 headers' },
      { stepId: 'step-1', agentId: 'summary-bot', input: 'Summarize intermediate notes' },
      { stepId: 'step-2', agentId: 'code-bot', input: 'Write final fetch wrapper' },
    ],
    finalStepId: 'step-2',
  }

  const calledAgents = []
  const result = await orchestrate('Build an x402 fetch wrapper', 0.1, () => {}, {
    plan,
    x402Fetch: null,
    sendPayment: null,
    serviceMap: {
      'research-bot': async () => {
        calledAgents.push('research-bot')
        return 'RAW_RESEARCH_NOTES: X-PAYMENT header carries signed XDR.'
      },
      'summary-bot': async () => {
        calledAgents.push('summary-bot')
        return 'INTERMEDIATE_SUMMARY: Do NOT pick this as the final output.'
      },
      'code-bot': async () => {
        calledAgents.push('code-bot')
        return 'export function paidFetch() { return "FINAL_CODE_IMPLEMENTATION"; }'
      },
    },
  })

  // Exactly the 3 quoted steps ran — no extra unquoted synthesis call was made.
  assert.deepEqual(calledAgents, ['research-bot', 'summary-bot', 'code-bot'])
  assert.equal(result.finalStepId, 'step-2')
  assert.equal(result.finalOutput.available, true)
  assert.equal(result.finalOutput.status, 'completed')
  assert.equal(result.finalOutput.stepId, 'step-2')
  assert.equal(result.finalOutput.agentId, 'code-bot')
  assert.ok(result.finalOutput.output.includes('FINAL_CODE_IMPLEMENTATION'))
  assert.ok(!result.finalOutput.output.includes('INTERMEDIATE_SUMMARY'))

  // Verify dashboard showResult and renderRunDetail select step-2 (code-bot)
  const { sandbox, getElement } = await createDashboardRenderingHarness()
  sandbox.showResult(result)

  const resultOutText = getElement('result-out').textContent
  const finalSectionText = resultOutText.split('AGENT DETAILS')[0]
  assert.equal(getElement('result-tag').textContent, 'Complete')
  assert.ok(
    finalSectionText.includes('FINAL ANSWER (step-2 · 💻 Code Agent)'),
    `Expected final answer header to name step-2, got: ${finalSectionText}`
  )
  assert.ok(
    finalSectionText.includes('FINAL_CODE_IMPLEMENTATION'),
    'Final answer section must render the final code step output'
  )
  assert.ok(
    !finalSectionText.includes('INTERMEDIATE_SUMMARY'),
    'Final answer section must NOT select the intermediate summary-bot output'
  )

  sandbox.renderRunDetail({
    id: 'run_test_code_final',
    status: 'completed',
    task: result.task,
    budget: result.budget,
    quotedTotal: result.quotedTotal,
    settledTotals: result.settledTotals,
    finalStepId: result.finalStepId,
    finalOutput: result.finalOutput,
    results: result.results,
  })
  const detailOutputsHtml = getElement('detail-outputs').innerHTML
  assert.ok(detailOutputsHtml.includes('data-final-status="completed"'))
  assert.ok(detailOutputsHtml.includes('data-final-step-id="step-2"'))
  assert.ok(detailOutputsHtml.includes('FINAL_CODE_IMPLEMENTATION'))
})

await test('Failed final step reports unavailable finalOutput and renders a clear partial-result presentation', async () => {
  const plan = {
    plan: 'Research -> intermediate summary -> final code step that fails',
    subtasks: [
      { stepId: 'step-0', agentId: 'research-bot', input: 'Research x402 headers' },
      { stepId: 'step-1', agentId: 'summary-bot', input: 'Summarize intermediate notes' },
      { stepId: 'step-2', agentId: 'code-bot', input: 'Write final fetch wrapper' },
    ],
    finalStepId: 'step-2',
  }

  const result = await orchestrate('Build an x402 fetch wrapper', 0.1, () => {}, {
    plan,
    x402Fetch: null,
    sendPayment: null,
    serviceMap: {
      'research-bot': async () => 'RAW_RESEARCH_NOTES',
      'summary-bot': async () => 'INTERMEDIATE_SUMMARY_ONLY',
      'code-bot': async () => {
        throw new Error('Upstream code model rate-limited')
      },
    },
  })

  assert.equal(result.finalStepId, 'step-2')
  assert.equal(result.finalOutput.available, false)
  assert.equal(result.finalOutput.status, 'failed')
  assert.equal(result.finalOutput.stepId, 'step-2')
  assert.equal(result.finalOutput.agentId, 'code-bot')
  assert.equal(result.finalOutput.output, null)
  assert.equal(result.finalOutput.partialResultsAvailable, true)
  assert.equal(result.finalOutput.completedStepCount, 2)
  assert.ok(result.finalOutput.reason.includes('Upstream code model rate-limited'))

  const { sandbox, getElement } = await createDashboardRenderingHarness()
  sandbox.showResult(result)

  const resultOutText = getElement('result-out').textContent
  const [finalSectionText, agentDetailsText] = resultOutText.split('AGENT DETAILS')
  assert.equal(getElement('result-tag').textContent, 'Partial')
  assert.ok(
    getElement('result-status-line').textContent.includes('Partial results only'),
    'Status line must indicate partial results when final step fails'
  )
  assert.ok(
    finalSectionText.includes('FINAL ANSWER (UNAVAILABLE — PARTIAL RESULTS BELOW)'),
    `Expected partial-result header, got: ${finalSectionText}`
  )
  assert.ok(
    !finalSectionText.includes('INTERMEDIATE_SUMMARY_ONLY'),
    'Failed final step must not silently promote intermediate summary to FINAL ANSWER'
  )
  assert.ok(
    agentDetailsText.includes('INTERMEDIATE_SUMMARY_ONLY'),
    'Intermediate step output must still be visible in AGENT DETAILS'
  )
  assert.ok(
    agentDetailsText.includes('[FAILED] step-2 [FINAL STEP]'),
    'Failed final step must be labeled in AGENT DETAILS'
  )

  sandbox.renderRunDetail({
    id: 'run_test_failed_final',
    status: 'completed',
    task: result.task,
    budget: result.budget,
    finalStepId: result.finalStepId,
    finalOutput: result.finalOutput,
    results: result.results,
  })
  const detailOutputsHtml = getElement('detail-outputs').innerHTML
  assert.ok(detailOutputsHtml.includes('data-final-status="failed"'))
  assert.ok(detailOutputsHtml.includes('Final Output Unavailable (failed)'))
  assert.ok(detailOutputsHtml.includes('Partial results from 2 completed step(s)'))
})

await test('Skipped final step (budget limit) reports status=skipped with partial results', async () => {
  const plan = {
    plan: 'Research (0.01) -> Summary (0.01) -> Code (0.03, skipped under 0.02 budget)',
    subtasks: [
      { stepId: 'step-0', agentId: 'research-bot', input: 'Research topic' },
      { stepId: 'step-1', agentId: 'summary-bot', input: 'Summarize topic' },
      { stepId: 'step-2', agentId: 'code-bot', input: 'Generate code' },
    ],
    finalStepId: 'step-2',
  }

  const result = await orchestrate('Tight budget task', 0.02, () => {}, {
    plan,
    x402Fetch: null,
    sendPayment: null,
    serviceMap: {
      'research-bot': async () => 'Research output',
      'summary-bot': async () => 'Intermediate summary output',
      'code-bot': async () => 'Should not execute',
    },
  })

  assert.equal(result.finalStepId, 'step-2')
  assert.equal(result.finalOutput.available, false)
  assert.equal(result.finalOutput.status, 'skipped')
  assert.equal(result.finalOutput.stepId, 'step-2')
  assert.equal(result.finalOutput.agentId, 'code-bot')
  assert.equal(result.finalOutput.output, null)
  assert.equal(result.finalOutput.partialResultsAvailable, true)
  assert.equal(result.finalOutput.completedStepCount, 2)
  assert.ok(result.finalOutput.reason.includes('Budget limit'))

  const { sandbox, getElement } = await createDashboardRenderingHarness()
  sandbox.showResult(result)
  assert.equal(getElement('result-tag').textContent, 'Partial')
  assert.ok(
    getElement('result-out').textContent.includes(
      'FINAL ANSWER (UNAVAILABLE — PARTIAL RESULTS BELOW)'
    )
  )
})

await test('Empty plan reports status=empty_plan and renders an incomplete state in the dashboard', async () => {
  const emptyPlan = buildFallbackPlan('Impossible zero-budget task', 0)
  const result = await orchestrate('Impossible zero-budget task', 0, () => {}, {
    plan: emptyPlan,
    x402Fetch: null,
    sendPayment: null,
  })

  assert.equal(result.finalStepId, null)
  assert.equal(result.finalOutput.available, false)
  assert.equal(result.finalOutput.status, 'empty_plan')
  assert.equal(result.finalOutput.stepId, null)
  assert.equal(result.finalOutput.output, null)
  assert.equal(result.finalOutput.partialResultsAvailable, false)
  assert.equal(result.finalOutput.completedStepCount, 0)
  assert.ok(result.finalOutput.reason.includes('no executable steps'))

  const { sandbox, getElement } = await createDashboardRenderingHarness()
  sandbox.showResult(result)
  assert.equal(getElement('result-tag').textContent, 'Incomplete')
  assert.ok(getElement('result-out').textContent.includes('FINAL ANSWER (UNAVAILABLE)'))
  assert.ok(getElement('result-out').textContent.includes('empty_plan'))

  // Also verify resolveFinalOutput directly on empty inputs
  const directEmpty = resolveFinalOutput({ subtasks: [] }, [])
  assert.equal(directEmpty.available, false)
  assert.equal(directEmpty.status, 'empty_plan')
})

await test('Preview, HTTP API, run-history store, and export all preserve explicit finalStepId and finalOutput', async () => {
  const stubPlan = {
    plan: 'Preview + Execute + History + Export pipeline',
    subtasks: [
      { stepId: 'step-0', agentId: 'summary-bot', input: 'Summarize problem statement' },
      { stepId: 'step-1', agentId: 'code-bot', input: 'Deliver final contract code' },
    ],
    finalStepId: 'step-1',
  }

  const preview = await previewOrchestration('Deliver smart contract', 0.1, () => {}, {
    plan: stubPlan,
  })
  assert.equal(preview.finalStepId, 'step-1')
  assert.equal(preview.steps[0].stepId, 'step-0')
  assert.equal(preview.steps[0].isFinalStep, false)
  assert.equal(preview.steps[1].stepId, 'step-1')
  assert.equal(preview.steps[1].isFinalStep, true)

  const app = express()
  app.use(express.json())
  app.use(requestId)

  const store = new InMemoryRunHistoryStore(50)
  await store.init()

  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: (task, budget, broadcastFn, ctx) =>
      orchestrate(task, budget, broadcastFn, {
        ...ctx,
        plan: stubPlan,
        x402Fetch: null,
        sendPayment: null,
        serviceMap: {
          'summary-bot': async () => 'Early summary of requirements',
          'code-bot': async () => 'pub fn final_soroban_contract() {}',
        },
      }),
    broadcast: () => {},
  })
  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  try {
    const orchRes = await fetch(`${baseUrl}/api/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'Deliver smart contract', budget: 0.1 }),
    })
    assert.equal(orchRes.status, 200)
    const orchBody = await orchRes.json()
    assert.equal(orchBody.finalStepId, 'step-1')
    assert.equal(orchBody.finalOutput.available, true)
    assert.equal(orchBody.finalOutput.stepId, 'step-1')
    assert.equal(orchBody.finalOutput.agentId, 'code-bot')
    assert.equal(orchBody.finalOutput.output, 'pub fn final_soroban_contract() {}')

    const runRes = await fetch(`${baseUrl}/api/runs/${orchBody.runId}`)
    assert.equal(runRes.status, 200)
    const runBody = await runRes.json()
    assert.equal(runBody.finalStepId, 'step-1')
    assert.deepEqual(runBody.finalOutput, orchBody.finalOutput)
    assert.deepEqual(runBody.summary.finalOutput, orchBody.finalOutput)

    const exportRes = await fetch(`${baseUrl}/api/runs/${orchBody.runId}/export`)
    assert.equal(exportRes.status, 200)
    const exportBody = await exportRes.json()
    assert.equal(exportBody.finalStepId, 'step-1')
    assert.deepEqual(exportBody.finalOutput, orchBody.finalOutput)

    const { sandbox } = await createDashboardRenderingHarness()
    const clientExport = sandbox.formatRunExport(runBody)
    assert.equal(clientExport.finalStepId, 'step-1')
    assert.deepEqual(clientExport.finalOutput, orchBody.finalOutput)

    const helperExport = buildRunExportPayload(runBody)
    assert.equal(helperExport.finalStepId, 'step-1')
    assert.deepEqual(helperExport.finalOutput, orchBody.finalOutput)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
