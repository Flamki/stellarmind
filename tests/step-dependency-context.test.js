/**
 * Unit tests for explicit step dependency context assembly (Issue #147).
 *
 * Covers:
 *  - A step can reference multiple earlier step IDs (branching two-research -> one-summary fixture).
 *  - Unknown, forward, duplicate, self, or cyclic references are rejected before execution.
 *  - Context assembly is deterministic and signals any omitted/truncated content.
 *  - A failed dependency follows an explicit skip or continue policy.
 */

import assert from 'node:assert/strict'
import {
  validatePlan,
  assembleStepContext,
  MAX_CONTEXT_CHARS,
} from '../src/agents/plan-validator.js'
import { orchestrate } from '../src/agents/orchestrator.js'

console.log('=== Issue #147: Step Dependency Context Assembly Tests ===')

// 1. Validate plan rejects unknown, forward, duplicate, self, and cyclic dependency references
{
  const unknownRef = validatePlan({
    plan: 'unknown dependency test',
    subtasks: [{ agentId: 'research-bot', input: 'research A', dependsOn: ['step-99'] }],
  })
  assert.equal(unknownRef.valid, false)
  assert.equal(unknownRef.reason, 'subtask_0_unknown_dependency')

  const selfRef = validatePlan({
    plan: 'self dependency test',
    subtasks: [{ agentId: 'research-bot', input: 'research A', dependsOn: ['step-0'] }],
  })
  assert.equal(selfRef.valid, false)
  assert.equal(selfRef.reason, 'subtask_0_cyclic_dependency')

  const cycleRef = validatePlan({
    plan: 'two-node cycle test',
    subtasks: [
      { agentId: 'research-bot', input: 'research A', dependsOn: ['step-1'] },
      { agentId: 'summary-bot', input: 'summarize', dependsOn: ['step-0'] },
    ],
  })
  assert.equal(cycleRef.valid, false)
  assert.equal(cycleRef.reason, 'cyclic_dependency')

  const forwardRef = validatePlan({
    plan: 'forward dependency test',
    subtasks: [
      { agentId: 'summary-bot', input: 'summarize', dependsOn: ['step-1'] },
      { agentId: 'research-bot', input: 'research A', dependsOn: [] },
    ],
  })
  assert.equal(forwardRef.valid, false)
  assert.equal(forwardRef.reason, 'subtask_0_forward_dependency')

  const duplicateRef = validatePlan({
    plan: 'duplicate dependency test',
    subtasks: [
      { agentId: 'research-bot', input: 'research A', dependsOn: [] },
      { agentId: 'summary-bot', input: 'summarize', dependsOn: ['step-0', 'step-0'] },
    ],
  })
  assert.equal(duplicateRef.valid, false)
  assert.equal(duplicateRef.reason, 'subtask_1_duplicate_dependency')

  // Also verify orchestrate rejects an invalid plan before calling any service or payment
  let serviceCalled = false
  await assert.rejects(
    () =>
      orchestrate('invalid plan run', 1, () => {}, {
        plan: {
          plan: 'bad forward ref',
          subtasks: [
            { agentId: 'summary-bot', input: 'sum', dependsOn: ['step-1'] },
            { agentId: 'research-bot', input: 'res', dependsOn: [] },
          ],
        },
        serviceMap: {
          'summary-bot': async () => {
            serviceCalled = true
            return 'summary'
          },
          'research-bot': async () => {
            serviceCalled = true
            return 'research'
          },
        },
      }),
    (err) => err.code === 'INVALID_PLAN' && err.reason === 'subtask_0_forward_dependency'
  )
  assert.equal(serviceCalled, false, 'No agent service may run when dependency validation fails')
  console.log(
    '✓ Unknown, forward, duplicate, self, and cyclic dependency references rejected before execution'
  )
}

// 2. Branching fixture: two independent research steps feed one summary step
{
  const serviceInputs = []
  const events = []

  const run = await orchestrate(
    'Compare Soroban smart contracts and Stellar classic assets',
    1,
    (evt) => events.push(evt),
    {
      x402Fetch: null,
      sendPayment: async () => ({ success: true, txHash: 'tx-branch' }),
      plan: {
        plan: 'Two parallel research tracks merged into one summary',
        subtasks: [
          {
            stepId: 'step-0',
            agentId: 'research-bot',
            input: 'Research Soroban smart contract capabilities',
            dependsOn: [],
          },
          {
            stepId: 'step-1',
            agentId: 'research-bot',
            input: 'Research Stellar classic asset issuance',
            dependsOn: [],
          },
          {
            stepId: 'step-2',
            agentId: 'summary-bot',
            input: 'Synthesize Soroban and classic asset findings',
            dependsOn: ['step-0', 'step-1'],
          },
        ],
      },
      serviceMap: {
        'research-bot': async (input) => {
          serviceInputs.push({ agentId: 'research-bot', input })
          if (input.includes('Soroban')) return 'FINDING_ALPHA: Soroban uses WASM.'
          return 'FINDING_BETA: Classic assets use trustlines.'
        },
        'summary-bot': async (input) => {
          serviceInputs.push({ agentId: 'summary-bot', input })
          return 'MERGED_SUMMARY: Both WASM and trustlines are supported.'
        },
      },
    }
  )

  assert.equal(run.results.length, 3)
  assert.equal(serviceInputs.length, 3)

  // Neither research step received prior context because dependsOn: []
  assert.equal(serviceInputs[0].input, 'Research Soroban smart contract capabilities')
  assert.equal(serviceInputs[1].input, 'Research Stellar classic asset issuance')

  // Summary step received BOTH step-0 and step-1 outputs in declared order
  const summaryInput = serviceInputs[2].input
  const alphaIdx = summaryInput.indexOf(
    '[step-0 (research-bot)]:\nFINDING_ALPHA: Soroban uses WASM.'
  )
  const betaIdx = summaryInput.indexOf(
    '[step-1 (research-bot)]:\nFINDING_BETA: Classic assets use trustlines.'
  )
  assert.ok(alphaIdx >= 0, 'Summary input must include step-0 output')
  assert.ok(betaIdx > alphaIdx, 'Summary input must include step-1 output after step-0')

  const summaryResult = run.results[2]
  assert.deepEqual(summaryResult.dependsOn, ['step-0', 'step-1'])
  assert.deepEqual(summaryResult.contextMeta.sourceStepIds, ['step-0', 'step-1'])
  assert.equal(summaryResult.contextMeta.truncated, false)
  assert.equal(summaryResult.contextMeta.omittedChars, 0)
  console.log('✓ Branching fixture merges two research outputs into one summary deterministically')
}

// 3. Oversized context is deterministically truncated within MAX_CONTEXT_CHARS and signals omitted content
{
  const events = []
  const longA = 'A'.repeat(2200)
  const longB = 'B'.repeat(2200)
  let capturedSummaryInput = ''

  const run = await orchestrate('Oversized context test', 1, (evt) => events.push(evt), {
    x402Fetch: null,
    sendPayment: async () => ({ success: true, txHash: 'tx-trunc' }),
    plan: {
      plan: 'Oversized branching context',
      subtasks: [
        { stepId: 'step-0', agentId: 'research-bot', input: 'part A', dependsOn: [] },
        { stepId: 'step-1', agentId: 'research-bot', input: 'part B', dependsOn: [] },
        {
          stepId: 'step-2',
          agentId: 'summary-bot',
          input: 'combine A and B',
          dependsOn: ['step-0', 'step-1'],
        },
      ],
    },
    serviceMap: {
      'research-bot': async (input) => (input.includes('part A') ? longA : longB),
      'summary-bot': async (input) => {
        capturedSummaryInput = input
        return 'truncated summary complete'
      },
    },
  })

  const summaryStep = run.results[2]
  assert.equal(summaryStep.contextMeta.truncated, true)
  assert.equal(summaryStep.contextMeta.maxChars, MAX_CONTEXT_CHARS)
  assert.ok(summaryStep.contextMeta.includedChars <= MAX_CONTEXT_CHARS)
  assert.ok(summaryStep.contextMeta.omittedChars > 1400)
  assert.deepEqual(summaryStep.contextMeta.truncatedStepIds, ['step-0', 'step-1'])

  // Fair allocation ensures BOTH step-0 and step-1 headers and partial content appear
  assert.ok(capturedSummaryInput.includes('[step-0 (research-bot)]:\nAAAA'))
  assert.ok(capturedSummaryInput.includes('[step-1 (research-bot)]:\nBBBB'))

  const truncEvents = events.filter((e) => e.type === 'step_context_truncated')
  assert.equal(truncEvents.length, 1)
  assert.equal(truncEvents[0].stepId, 'step-2')
  console.log(
    '✓ Oversized multi-dependency context is truncated deterministically and signals omittedChars'
  )
}

// 4. Failed dependency propagation: explicit 'skip' vs 'continue' policies
{
  // Policy 'skip' (default for explicit dependsOn): dependent step is skipped without payment or service call
  let summaryCalledOnSkip = false
  let paymentCountOnSkip = 0
  const skipEvents = []

  const skipRun = await orchestrate(
    'Dependency failure skip policy test',
    1,
    (evt) => skipEvents.push(evt),
    {
      x402Fetch: null,
      sendPayment: async () => {
        paymentCountOnSkip += 1
        return { success: true, txHash: `tx-${paymentCountOnSkip}` }
      },
      plan: {
        plan: 'Skip on failed dependency',
        subtasks: [
          { stepId: 'step-0', agentId: 'research-bot', input: 'failing research', dependsOn: [] },
          {
            stepId: 'step-1',
            agentId: 'summary-bot',
            input: 'summarize research',
            dependsOn: ['step-0'],
            onDependencyFailure: 'skip',
          },
        ],
      },
      serviceMap: {
        'research-bot': async () => {
          throw new Error('Upstream provider failed')
        },
        'summary-bot': async () => {
          summaryCalledOnSkip = true
          return 'should not run'
        },
      },
    }
  )

  assert.equal(
    summaryCalledOnSkip,
    false,
    'Dependent step must not run when onDependencyFailure is skip'
  )
  assert.equal(skipRun.results[0].status, 'failed')
  assert.equal(skipRun.results[1].skipped, true)
  assert.equal(skipRun.results[1].reason, 'dependency_failed')
  assert.deepEqual(skipRun.results[1].failedDependencies, ['step-0'])
  assert.ok(skipEvents.some((e) => e.type === 'step_skipped_dependency_failure'))

  // Policy 'continue': dependent step executes with remaining healthy dependencies and records failedStepIds
  let continueSummaryInput = ''
  const continueRun = await orchestrate('Dependency failure continue policy test', 1, () => {}, {
    x402Fetch: null,
    sendPayment: async () => ({ success: true, txHash: 'tx-cont' }),
    plan: {
      plan: 'Continue on partial dependency failure',
      subtasks: [
        { stepId: 'step-0', agentId: 'research-bot', input: 'failing branch', dependsOn: [] },
        { stepId: 'step-1', agentId: 'research-bot', input: 'healthy branch', dependsOn: [] },
        {
          stepId: 'step-2',
          agentId: 'summary-bot',
          input: 'summarize available branches',
          dependsOn: ['step-0', 'step-1'],
          onDependencyFailure: 'continue',
        },
      ],
    },
    serviceMap: {
      'research-bot': async (input) => {
        if (input.includes('failing')) throw new Error('Branch 0 failed')
        return 'HEALTHY_BRANCH_OUTPUT'
      },
      'summary-bot': async (input) => {
        continueSummaryInput = input
        return 'SUMMARY_WITH_HEALTHY_BRANCH'
      },
    },
  })

  assert.equal(continueRun.results[2].output, 'SUMMARY_WITH_HEALTHY_BRANCH')
  assert.deepEqual(continueRun.results[2].contextMeta.sourceStepIds, ['step-1'])
  assert.deepEqual(continueRun.results[2].contextMeta.failedStepIds, ['step-0'])
  assert.ok(continueSummaryInput.includes('HEALTHY_BRANCH_OUTPUT'))

  // Also verify missing dependency in assembleStepContext is treated as failed/missing
  const missingAssembly = assembleStepContext(
    {
      stepId: 'step-1',
      agentId: 'summary-bot',
      input: 'sum',
      dependsOn: ['step-0'],
      explicitDependsOn: true,
      onDependencyFailure: 'skip',
    },
    new Map()
  )
  assert.equal(missingAssembly.shouldSkip, true)
  assert.deepEqual(missingAssembly.contextMeta.failedStepIds, ['step-0'])
  console.log('✓ Failed or missing dependencies follow explicit skip and continue policies')
}

console.log('=== All Issue #147 tests passed ===')
