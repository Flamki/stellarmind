/**
 * Unit tests for structured step and run outcomes (Issue #134).
 *
 * Covers:
 *  - Each step has an executionStatus ('succeeded' | 'failed' | 'skipped') independent of paymentStatus.
 *  - Payments that already occurred when execution fails are preserved.
 *  - Failed outputs do not become context for downstream steps unless explicitly permitted.
 *  - Run summaries and persisted history distinguish 'completed', 'partial', and 'failed' outcomes.
 *  - The UI never presents an all-failed run as successful completion.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {
  classifyStepExecution,
  classifyStepPayment,
  summarizeRunOutcomes,
} from '../src/agents/budget.js'
import { orchestrate } from '../src/agents/orchestrator.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'

console.log('=== Issue #134: Structured Step & Run Outcomes Tests ===')

// 1. Pure step and run outcome classification
{
  assert.deepEqual(classifyStepExecution({ output: 'Normal findings' }), {
    executionStatus: 'succeeded',
    executionError: null,
  })
  assert.deepEqual(classifyStepExecution({ output: 'Error: Upstream timeout' }), {
    executionStatus: 'failed',
    executionError: 'Upstream timeout',
  })
  assert.deepEqual(classifyStepExecution({ skipped: true, reason: 'Budget limit' }), {
    executionStatus: 'skipped',
    executionError: null,
  })

  // Step where payment settled before/during execution failure
  assert.equal(
    classifyStepPayment({
      executionStatus: 'failed',
      paymentSuccess: true,
      settlement: { success: true, amount: '0.01', asset: 'USDC' },
    }),
    'settled'
  )
  assert.equal(
    classifyStepPayment({
      executionStatus: 'succeeded',
      paymentReconciliationRequired: true,
    }),
    'pending_reconciliation'
  )

  assert.equal(
    summarizeRunOutcomes([{ executionStatus: 'succeeded' }, { executionStatus: 'succeeded' }])
      .outcome,
    'completed'
  )
  assert.equal(
    summarizeRunOutcomes([
      { executionStatus: 'succeeded' },
      { executionStatus: 'failed', error: 'boom' },
    ]).outcome,
    'partial'
  )
  assert.equal(
    summarizeRunOutcomes([{ executionStatus: 'succeeded' }, { skipped: true }]).outcome,
    'partial'
  )
  assert.equal(
    summarizeRunOutcomes([{ executionStatus: 'failed', error: 'boom' }, { skipped: true }]).outcome,
    'failed'
  )
  console.log('✓ Step executionStatus, paymentStatus, and run outcome classifiers verified')
}

// 2. Failed step outputs do not pollute downstream context unless policy explicitly permits it
{
  const downstreamInputsDefault = []
  const partialRun = await orchestrate(
    'Context isolation test',
    0.04, // Enough for research ($0.01) + summary ($0.01) + research ($0.01), skips analyst ($0.05)
    () => {},
    {
      x402Fetch: null,
      sendPayment: async () => ({ success: true, txHash: 'tx-ok' }),
      plan: {
        plan: 'Good step -> failed step -> summary step -> skipped step',
        subtasks: [
          { stepId: 'step-0', agentId: 'research-bot', input: 'good research' },
          { stepId: 'step-1', agentId: 'research-bot', input: 'bad research' },
          { stepId: 'step-2', agentId: 'summary-bot', input: 'summarize findings' },
          { stepId: 'step-3', agentId: 'analyst-bot', input: 'over budget analysis' },
        ],
      },
      serviceMap: {
        'research-bot': async (input) => {
          if (input.includes('bad research')) {
            throw new Error('Provider crashed mid-step')
          }
          return 'VERIFIED_FACT_123'
        },
        'summary-bot': async (input) => {
          downstreamInputsDefault.push(input)
          return 'CLEAN_SUMMARY'
        },
      },
    }
  )

  assert.equal(partialRun.outcome, 'partial')
  assert.equal(partialRun.stepOutcomes.succeededCount, 2)
  assert.equal(partialRun.stepOutcomes.failedCount, 1)
  assert.equal(partialRun.stepOutcomes.skippedCount, 1)

  assert.equal(partialRun.results[0].executionStatus, 'succeeded')
  assert.equal(partialRun.results[0].paymentStatus, 'settled')

  assert.equal(partialRun.results[1].executionStatus, 'failed')
  assert.equal(partialRun.results[1].executionError, 'Provider crashed mid-step')
  assert.equal(partialRun.results[1].paymentStatus, 'unpaid')

  assert.equal(partialRun.results[2].executionStatus, 'succeeded')
  assert.equal(partialRun.results[2].paymentStatus, 'settled')

  assert.equal(partialRun.results[3].executionStatus, 'skipped')
  assert.equal(partialRun.results[3].paymentStatus, 'unpaid')

  // Summary step received VERIFIED_FACT_123 and NOT "Error: Provider crashed mid-step"
  assert.ok(downstreamInputsDefault[0].includes('VERIFIED_FACT_123'))
  assert.equal(
    downstreamInputsDefault[0].includes('Provider crashed mid-step'),
    false,
    'Failed step output must not pollute downstream context by default'
  )

  // Now verify that when allowFailedContext: true is explicitly passed, failed output is included
  const downstreamInputsPermitted = []
  await orchestrate('Permitted failed context test', 1, () => {}, {
    x402Fetch: null,
    allowFailedContext: true,
    plan: {
      plan: 'Failed step -> summary step with explicit policy',
      subtasks: [
        { stepId: 'step-0', agentId: 'research-bot', input: 'bad research' },
        { stepId: 'step-1', agentId: 'summary-bot', input: 'inspect error' },
      ],
    },
    serviceMap: {
      'research-bot': async () => {
        throw new Error('Explicitly permitted error string')
      },
      'summary-bot': async (input) => {
        downstreamInputsPermitted.push(input)
        return 'Inspected failure'
      },
    },
  })
  assert.ok(downstreamInputsPermitted[0].includes('Explicitly permitted error string'))
  console.log(
    '✓ Failed step outputs excluded from downstream context by default and included only when policy permits'
  )
}

// 3. Preserve payment that already occurred when execution fails + all-failed run outcome
{
  const paidThenFailedRun = await orchestrate(
    'Paid x402 call whose execution payload failed',
    1,
    () => {},
    {
      // Simulate x402 settling on-chain (200 with payment-response header) while agent body returns Error:
      x402Fetch: async () =>
        new Response(JSON.stringify({ result: 'Error: Agent runtime exception after payment' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'payment-response': Buffer.from(
              JSON.stringify({ success: true, transaction: 'tx-paid-before-fail' }),
              'utf8'
            ).toString('base64'),
          },
        }),
      plan: {
        plan: 'Single paid step that fails execution',
        subtasks: [{ stepId: 'step-0', agentId: 'research-bot', input: 'topic' }],
      },
    }
  )

  assert.equal(paidThenFailedRun.outcome, 'failed')
  assert.equal(paidThenFailedRun.results[0].executionStatus, 'failed')
  assert.equal(paidThenFailedRun.results[0].executionError, 'Agent runtime exception after payment')
  // Payment that already occurred is preserved!
  assert.equal(paidThenFailedRun.results[0].paymentStatus, 'settled')
  assert.equal(paidThenFailedRun.results[0].txHash, 'tx-paid-before-fail')
  assert.equal(paidThenFailedRun.settledTotals.length, 1)
  assert.equal(paidThenFailedRun.settledTotals[0].amount, '0.01')

  const store = new InMemoryRunHistoryStore(10)
  const created = await store.createRun({ task: paidThenFailedRun.task, budget: 1 })
  await store.completeRun(created.id, paidThenFailedRun)
  const persisted = await store.getRun(created.id)

  assert.equal(persisted.outcome, 'failed')
  assert.equal(persisted.summary.outcome, 'failed')
  assert.equal(persisted.outputAvailable, false)
  assert.equal(persisted.txProofs.length, 1)
  assert.equal(persisted.txProofs[0].txHash, 'tx-paid-before-fail')

  console.log('✓ Settled payment is preserved when step execution fails; run outcome is failed')
}

// 4. UI rendering never presents an all-failed run as Complete and labels partial/failed runs accurately
{
  const renderingSource = await fs.readFile(
    new URL('../public/assets/js/rendering.js', import.meta.url),
    'utf8'
  )

  const elements = new Map()
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: '',
        innerHTML: '',
        className: '',
        style: { display: 'block', width: '0%' },
        children: [],
        classList: {
          classes: new Set(),
          add(c) {
            this.classes.add(c)
          },
          remove(c) {
            this.classes.delete(c)
          },
        },
        prepend(child) {
          this.children.unshift(child)
        },
        removeChild() {
          this.children.pop()
        },
      })
    }
    return elements.get(id)
  }

  const sandbox = {
    document: {
      getElementById: getElement,
      createElement: () => ({ className: '', textContent: '', innerHTML: '' }),
    },
    activeRun: {
      running: true,
      startedAt: Date.now() - 1000,
      spent: 0,
      budget: 1,
      completed: 0,
      planned: 1,
    },
    stopRunHeartbeat: () => {},
    escapeHtml: (s) => String(s ?? ''),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Date,
    Number,
    Math,
    Array,
    String,
    JSON,
  }

  vm.createContext(sandbox)
  vm.runInContext(renderingSource, sandbox)

  // Test A: All-failed run in showResult()
  sandbox.showResult({
    outcome: 'failed',
    quotedTotal: '0.0100',
    settledTotals: [{ asset: 'USDC', amount: '0.01' }],
    results: [
      {
        agentId: 'research-bot',
        agentName: 'Research Agent',
        cost: '0.01',
        currency: 'USDC',
        executionStatus: 'failed',
        executionError: 'Model timeout',
        output: 'Error: Model timeout',
        settledAmount: '0.01',
        settledAsset: 'USDC',
      },
    ],
    payments: [],
    agentsUsed: 1,
    txCount: 1,
  })

  assert.equal(getElement('result-tag').textContent, 'Failed')
  assert.equal(getElement('result-tag').className, 'tag red')
  assert.ok(getElement('result-status-line').textContent.includes('Execution failed'))
  assert.ok(getElement('result-out').textContent.includes('[FAILED] Research Agent'))

  // Test B: Partial run in showResult()
  sandbox.showResult({
    outcome: 'partial',
    quotedTotal: '0.0200',
    settledTotals: [{ asset: 'USDC', amount: '0.01' }],
    results: [
      {
        agentId: 'research-bot',
        agentName: 'Research Agent',
        cost: '0.01',
        currency: 'USDC',
        executionStatus: 'succeeded',
        output: 'Healthy finding',
      },
      {
        agentId: 'summary-bot',
        skipped: true,
        executionStatus: 'skipped',
        reason: 'Budget limit',
      },
    ],
    payments: [],
    agentsUsed: 1,
    agentsSkipped: 1,
  })

  assert.equal(getElement('result-tag').textContent, 'Partial')
  assert.equal(getElement('result-tag').className, 'tag amber')
  assert.ok(getElement('result-status-line').textContent.includes('Partial completion'))

  // Test C: renderRunDetail on a completed run whose step outcome is 'failed'
  sandbox.renderRunDetail({
    id: 'run-failed-steps',
    status: 'completed',
    outcome: 'failed',
    summary: { outcome: 'failed', quotedTotal: '0.01', settledSummary: '0.01 USDC', budget: 1 },
    txProofs: [{ method: 'x402', txHash: 'tx-paid-before-fail', amount: '0.01', asset: 'USDC' }],
    results: [{ agentId: 'research-bot', executionStatus: 'failed', error: 'Boom' }],
  })
  assert.equal(getElement('detail-status').textContent, 'failed')
  assert.equal(getElement('detail-status').className, 'history-status status-failed')

  console.log(
    '✓ UI rendering distinguishes Completed, Partial, and Failed runs and never marks all-failed runs as Complete'
  )
}

console.log('=== All Issue #134 tests passed ===')
