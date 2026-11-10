/**
 * Tests for Dashboard Progress Tracking by Run and Step ID (issue #163).
 *
 * Covers:
 *  - Two calls to the same agent count as two separate steps.
 *  - Events for another run do not change the current progress or spend display.
 *  - Duplicate events do not increment progress or spend twice.
 *  - Failed and skipped steps produce accurate terminal counts and labels.
 *  - Orchestrator propagates runId and stepId across all emitted execution events.
 *
 * Run: node tests/dashboard-step-progress.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { orchestrate } from '../src/agents/orchestrator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

async function withDashboardModules(fn) {
  const renderingPath = path.join(__dirname, '..', 'public', 'assets', 'js', 'rendering.js')
  const orchestrationPath = path.join(__dirname, '..', 'public', 'assets', 'js', 'orchestration.js')

  const renderingSource = await fs.readFile(renderingPath, 'utf8')
  const orchestrationSource = await fs.readFile(orchestrationPath, 'utf8')

  const combinedSource = `${renderingSource}\n\n${orchestrationSource}\n
export function getActiveRun() { return activeRun }
export {
  startLiveRun,
  setActiveRunId,
  trackLiveEvent,
  stopRunHeartbeat,
  getRunProgressInfo,
  renderLiveChips,
  showResult,
  formatAssetTotals,
  formatSettlementLabel,
}
`

  const tempPath = path.join(
    __dirname,
    `.dashboard-step-progress-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  )
  await fs.writeFile(tempPath, combinedSource, 'utf8')

  const elements = new Map()
  const makeElement = (id) => ({
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    style: {},
    children: [],
    get lastChild() {
      return this.children[this.children.length - 1] || null
    },
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
    get lastChild() {
      return this.children[this.children.length - 1] || null
    },
    removeChild(child) {
      const idx = this.children.indexOf(child)
      if (idx >= 0) this.children.splice(idx, 1)
      else this.children.pop()
    },
    focus() {},
  })

  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement: (tag) => makeElement(tag),
  }
  globalThis.escapeHtml = (value) => String(value ?? '')
  globalThis.addFeed = () => {}
  globalThis.loadWallets = () => {}

  let mod = null
  try {
    mod = await import(pathToFileURL(tempPath).href)
    await fn(mod, elements)
  } finally {
    if (mod?.stopRunHeartbeat) mod.stopRunHeartbeat()
    await fs.unlink(tempPath).catch(() => {})
    delete globalThis.document
    delete globalThis.escapeHtml
    delete globalThis.addFeed
    delete globalThis.loadWallets
  }
}

console.log('--- Running Dashboard Step & Run Progress Tests (#163) ---')

await test('two calls to the same agent count as two separate steps and accumulate spend', async () => {
  await withDashboardModules(async (dash, elements) => {
    dash.startLiveRun('Two-pass research task', 0.1, 'run_repeat_1')

    dash.trackLiveEvent({
      type: 'orchestrator_plan',
      runId: 'run_repeat_1',
      plan: 'Research twice',
      subtaskCount: 2,
    })

    // First call to research-bot (step-0)
    dash.trackLiveEvent({
      type: 'agent_call',
      runId: 'run_repeat_1',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: '🔬 Research Agent',
      cost: '0.01',
    })
    dash.trackLiveEvent({
      type: 'agent_response',
      runId: 'run_repeat_1',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: '🔬 Research Agent',
      cost: '0.01',
      resultPreview: 'First pass findings',
    })

    let run = dash.getActiveRun()
    assert.strictEqual(run.completed, 1)
    assert.strictEqual(run.terminal, 1)
    assert.strictEqual(Number(run.spent.toFixed(4)), 0.01)
    assert.match(elements.get('progress-label').textContent, /1\/2 steps complete/)

    // Second call to the SAME agent research-bot (step-1)
    dash.trackLiveEvent({
      type: 'agent_call',
      runId: 'run_repeat_1',
      stepId: 'step-1',
      agentId: 'research-bot',
      agent: '🔬 Research Agent',
      cost: '0.01',
    })
    dash.trackLiveEvent({
      type: 'agent_response',
      runId: 'run_repeat_1',
      stepId: 'step-1',
      agentId: 'research-bot',
      agent: '🔬 Research Agent',
      cost: '0.01',
      resultPreview: 'Second pass findings',
    })

    dash.trackLiveEvent({
      type: 'orchestrator_complete',
      runId: 'run_repeat_1',
    })

    run = dash.getActiveRun()
    assert.strictEqual(run.startedSteps.size, 2)
    assert.strictEqual(run.completedSteps.size, 2)
    assert.strictEqual(run.completed, 2)
    assert.strictEqual(run.terminal, 2)
    assert.strictEqual(Number(run.spent.toFixed(4)), 0.02)
    assert.strictEqual(elements.get('progress-percent').textContent, '100%')
    assert.strictEqual(elements.get('progress-label').textContent, 'Completed · 2/2 steps complete')
    assert.match(elements.get('result-chips').innerHTML, /Progress:.*2\/2/)
    assert.match(elements.get('result-chips').innerHTML, /0\.02 \/ 0\.10 USDC/)
  })
})

await test('events for another run do not change the current progress or spend display', async () => {
  await withDashboardModules(async (dash, elements) => {
    // Start active run without preset runId; first event for this task binds runId
    dash.startLiveRun('Primary task', 0.1)

    dash.trackLiveEvent({
      type: 'orchestrator_start',
      runId: 'run_active_100',
      task: 'Primary task',
    })
    dash.trackLiveEvent({
      type: 'orchestrator_plan',
      runId: 'run_active_100',
      subtaskCount: 3,
      plan: '3-step active plan',
    })
    dash.trackLiveEvent({
      type: 'agent_call',
      runId: 'run_active_100',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
    })
    dash.trackLiveEvent({
      type: 'agent_response',
      runId: 'run_active_100',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
      resultPreview: 'Active step 0 output',
    })

    // Interleaved events from another run (`run_foreign_999`) must be ignored
    const foreignEvents = [
      {
        type: 'orchestrator_start',
        runId: 'run_foreign_999',
        task: 'Foreign task',
      },
      {
        type: 'orchestrator_plan',
        runId: 'run_foreign_999',
        subtaskCount: 6,
      },
      {
        type: 'agent_call',
        runId: 'run_foreign_999',
        stepId: 'step-0',
        agentId: 'analyst-bot',
        agent: 'Analysis Agent',
        cost: '0.05',
      },
      {
        type: 'agent_response',
        runId: 'run_foreign_999',
        stepId: 'step-1',
        agentId: 'analyst-bot',
        agent: 'Analysis Agent',
        cost: '0.05',
        resultPreview: 'Foreign output',
      },
      {
        type: 'budget_limit',
        runId: 'run_foreign_999',
        stepId: 'step-2',
        agentId: 'code-bot',
        agent: 'Code Agent',
        cost: '0.03',
      },
      {
        type: 'orchestrator_complete',
        runId: 'run_foreign_999',
      },
    ]

    for (const ev of foreignEvents) {
      const accepted = dash.trackLiveEvent(ev)
      assert.strictEqual(accepted, false, `Foreign event ${ev.type} should be rejected`)
    }

    const run = dash.getActiveRun()
    assert.strictEqual(run.runId, 'run_active_100')
    assert.strictEqual(run.running, true, 'Foreign orchestrator_complete must not stop active run')
    assert.strictEqual(run.planned, 3, 'Foreign plan must not overwrite planned count')
    assert.strictEqual(run.completed, 1, 'Foreign response must not increment completed count')
    assert.strictEqual(run.skipped, 0, 'Foreign skip must not increment skipped count')
    assert.strictEqual(Number(run.spent.toFixed(4)), 0.01, 'Foreign spend must not alter spent')
    assert.strictEqual(elements.get('progress-label').textContent, 'Running · 1/3 steps complete')
    assert.match(elements.get('result-chips').innerHTML, /0\.01 \/ 0\.10 USDC/)
  })
})

await test('duplicate events for the same step do not increment progress or spend twice', async () => {
  await withDashboardModules(async (dash, elements) => {
    dash.startLiveRun('Deduplication test', 0.1, 'run_dedup_1')

    dash.trackLiveEvent({
      type: 'orchestrator_plan',
      runId: 'run_dedup_1',
      subtaskCount: 3,
    })

    const callEv = {
      type: 'agent_call',
      runId: 'run_dedup_1',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
    }
    assert.strictEqual(dash.trackLiveEvent(callEv), true)
    assert.strictEqual(dash.trackLiveEvent(callEv), false, 'Duplicate agent_call must be ignored')

    const responseEv = {
      type: 'agent_response',
      runId: 'run_dedup_1',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
      resultPreview: 'Done',
    }
    assert.strictEqual(dash.trackLiveEvent(responseEv), true)
    assert.strictEqual(
      dash.trackLiveEvent(responseEv),
      false,
      'Duplicate agent_response must be ignored'
    )

    const skipEv = {
      type: 'budget_limit',
      runId: 'run_dedup_1',
      stepId: 'step-1',
      agentId: 'analyst-bot',
      agent: 'Analysis Agent',
      cost: '0.05',
      remaining: '0.0100',
    }
    assert.strictEqual(dash.trackLiveEvent(skipEv), true)
    assert.strictEqual(dash.trackLiveEvent(skipEv), false, 'Duplicate budget_limit must be ignored')

    const failEv = {
      type: 'agent_failed',
      runId: 'run_dedup_1',
      stepId: 'step-2',
      agentId: 'code-bot',
      agent: 'Code Agent',
      error: 'Agent timeout',
    }
    assert.strictEqual(dash.trackLiveEvent(failEv), true)
    assert.strictEqual(dash.trackLiveEvent(failEv), false, 'Duplicate agent_failed must be ignored')

    const run = dash.getActiveRun()
    assert.strictEqual(run.completed, 1)
    assert.strictEqual(run.skipped, 1)
    assert.strictEqual(run.failed, 1)
    assert.strictEqual(run.terminal, 3)
    assert.strictEqual(Number(run.spent.toFixed(4)), 0.01)
    assert.match(
      elements.get('progress-label').textContent,
      /Running · 3\/3 steps \(1 completed, 1 failed, 1 skipped\)/
    )
  })
})

await test('failed and skipped steps produce accurate terminal counts and labels', async () => {
  await withDashboardModules(async (dash, elements) => {
    dash.startLiveRun('Mixed terminal states', 0.05, 'run_mixed_term')

    dash.trackLiveEvent({
      type: 'orchestrator_plan',
      runId: 'run_mixed_term',
      subtaskCount: 4,
    })

    // Step 0: completed
    dash.trackLiveEvent({
      type: 'agent_response',
      runId: 'run_mixed_term',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
      status: 'completed',
      resultPreview: 'Research OK',
    })

    // Step 1: completed (same agent as step-0)
    dash.trackLiveEvent({
      type: 'agent_response',
      runId: 'run_mixed_term',
      stepId: 'step-1',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
      status: 'completed',
      resultPreview: 'Deep dive OK',
    })

    // Step 2: failed via agent_response with status: 'failed'
    dash.trackLiveEvent({
      type: 'agent_response',
      runId: 'run_mixed_term',
      stepId: 'step-2',
      agentId: 'summary-bot',
      agent: 'Summary Agent',
      cost: '0.01',
      status: 'failed',
      outcome: 'failed',
      failed: true,
      error: 'Upstream model timeout',
      resultPreview: 'Error: Upstream model timeout',
    })

    // Step 3: skipped via budget_limit
    dash.trackLiveEvent({
      type: 'budget_limit',
      runId: 'run_mixed_term',
      stepId: 'step-3',
      agentId: 'analyst-bot',
      agent: 'Analysis Agent',
      cost: '0.05',
      remaining: '0.0200',
    })

    dash.trackLiveEvent({
      type: 'orchestrator_complete',
      runId: 'run_mixed_term',
    })

    const run = dash.getActiveRun()
    const info = dash.getRunProgressInfo(run)

    assert.strictEqual(info.planned, 4)
    assert.strictEqual(info.completed, 2)
    assert.strictEqual(info.failed, 1)
    assert.strictEqual(info.skipped, 1)
    assert.strictEqual(info.terminal, 4)
    assert.strictEqual(info.percent, 100)
    assert.strictEqual(info.status, 'Partial')
    assert.strictEqual(info.label, 'Completed · 4/4 steps (2 completed, 1 failed, 1 skipped)')

    assert.strictEqual(
      elements.get('progress-label').textContent,
      'Completed · 4/4 steps (2 completed, 1 failed, 1 skipped)'
    )
    assert.strictEqual(elements.get('progress-percent').textContent, '100%')

    const liveChips = elements.get('result-chips').innerHTML
    assert.match(liveChips, /Status:.*Partial/)
    assert.match(liveChips, /Progress:.*4\/4/)
    assert.match(liveChips, /Completed:.*2/)
    assert.match(liveChips, /Failed:.*1/)
    assert.match(liveChips, /Skipped:.*1/)

    // Also verify showResult preserves terminal counts and renders [FAILED] and [SKIPPED] details
    dash.showResult({
      runId: 'run_mixed_term',
      quotedTotal: '0.0300',
      totalSpent: '0.0300',
      settledTotals: [{ asset: 'USDC', amount: '0.02' }],
      agentsUsed: 3,
      agentsSkipped: 1,
      agentsFailed: 1,
      txCount: 2,
      paymentProtocol: 'x402',
      elapsed: '45ms',
      budgetExhausted: false,
      results: [
        {
          stepId: 'step-0',
          agentId: 'research-bot',
          agentName: 'Research Agent',
          cost: '0.01',
          currency: 'USDC',
          settledAmount: '0.01',
          settledAsset: 'USDC',
          output: 'Research pass 1',
        },
        {
          stepId: 'step-1',
          agentId: 'research-bot',
          agentName: 'Research Agent',
          cost: '0.01',
          currency: 'USDC',
          settledAmount: '0.01',
          settledAsset: 'USDC',
          output: 'Research pass 2',
        },
        {
          stepId: 'step-2',
          agentId: 'summary-bot',
          agentName: 'Summary Agent',
          cost: '0.01',
          currency: 'USDC',
          status: 'failed',
          failed: true,
          error: 'Upstream model timeout',
          output: 'Error: Upstream model timeout',
        },
        {
          stepId: 'step-3',
          agentId: 'analyst-bot',
          skipped: true,
          reason: 'Budget limit (0.0200 USDC remaining, need 0.05)',
        },
      ],
      payments: [],
    })

    assert.strictEqual(
      elements.get('progress-label').textContent,
      'Completed · 4/4 steps (2 completed, 1 failed, 1 skipped)'
    )
    const outText = elements.get('result-out').textContent
    assert.match(outText, /\[FAILED\] Summary Agent: Upstream model timeout/)
    assert.match(outText, /\[SKIPPED\] analyst-bot: Budget limit/)
    assert.match(elements.get('result-chips').innerHTML, /Failed:.*1/)
    assert.match(elements.get('result-chips').innerHTML, /Skipped:.*1/)
  })
})

await test('orchestrate propagates runId and unique stepIds across events and drives live progress', async () => {
  await withDashboardModules(async (dash, elements) => {
    const runId = 'run_orch_e2e_42'
    dash.startLiveRun('End-to-end step tracking', 0.04, runId)

    const emittedEvents = []
    let researchCallCount = 0

    const result = await orchestrate(
      'End-to-end step tracking',
      0.04,
      (ev) => {
        emittedEvents.push(ev)
        dash.trackLiveEvent(ev)
      },
      {
        runId,
        x402Fetch: null,
        sendPayment: undefined,
        plan: {
          plan: 'Two research steps, one failing summary step, one skipped analyst step',
          subtasks: [
            { agentId: 'research-bot', input: 'First query' },
            { agentId: 'research-bot', input: 'Second query' },
            { agentId: 'summary-bot', input: 'Summarize' },
            { agentId: 'analyst-bot', input: 'Deep analysis' },
          ],
        },
        serviceMap: {
          'research-bot': async (input) => {
            researchCallCount += 1
            return `Research #${researchCallCount}: ${input}`
          },
          'summary-bot': async () => {
            throw new Error('Model service down')
          },
          'analyst-bot': async () => 'Should be skipped by budget',
        },
      }
    )

    // Verify all emitted events carry runId
    for (const ev of emittedEvents) {
      assert.strictEqual(ev.runId, runId, `Event ${ev.type} must carry runId`)
    }

    // Verify step events carry distinct stepIds: step-0, step-1, step-2, step-3
    const callEvents = emittedEvents.filter((e) => e.type === 'agent_call')
    assert.deepStrictEqual(
      callEvents.map((e) => [e.stepId, e.agentId]),
      [
        ['step-0', 'research-bot'],
        ['step-1', 'research-bot'],
        ['step-2', 'summary-bot'],
      ]
    )

    const responseEvents = emittedEvents.filter((e) => e.type === 'agent_response')
    assert.deepStrictEqual(
      responseEvents.map((e) => [e.stepId, e.agentId, e.outcome]),
      [
        ['step-0', 'research-bot', 'completed'],
        ['step-1', 'research-bot', 'completed'],
        ['step-2', 'summary-bot', 'failed'],
      ]
    )

    const skipEvents = emittedEvents.filter((e) => e.type === 'budget_limit')
    assert.strictEqual(skipEvents.length, 1)
    assert.strictEqual(skipEvents[0].stepId, 'step-3')
    assert.strictEqual(skipEvents[0].agentId, 'analyst-bot')

    const run = dash.getActiveRun()
    assert.strictEqual(run.planned, 4)
    assert.strictEqual(run.completed, 2)
    assert.strictEqual(run.failed, 1)
    assert.strictEqual(run.skipped, 1)
    assert.strictEqual(run.terminal, 4)
    assert.strictEqual(Number(run.spent.toFixed(4)), 0.02)
    assert.strictEqual(
      elements.get('progress-label').textContent,
      'Completed · 4/4 steps (2 completed, 1 failed, 1 skipped)'
    )
    assert.strictEqual(result.agentsFailed, 1)
    assert.strictEqual(result.agentsSkipped, 1)
  })
})

console.log(`\nResults: ${passed} passed, ${failures.length} failed.`)
if (failures.length > 0) {
  process.exit(1)
}
