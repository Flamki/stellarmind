/**
 * Focused unit tests for the plan validator (Issue #145).
 *
 * Covers (per acceptance criteria):
 *  - only known agents, bounded string inputs, and supported plan shapes are accepted
 *  - every accepted step receives a stable, unique step ID
 *  - malformed / oversized plans are rejected with a visible reason
 *  - repeated agents in an otherwise-valid plan are still accepted
 *  - the bounded fallback plan builder produces the same guarantees
 *
 * Dependency-free — imports the SAME functions orchestrator.js uses, so a
 * regression in the real validator fails this suite.
 *
 * Run: node tests/plan-validator.test.js
 */

import assert from 'node:assert'
import {
  validatePlan,
  buildFallbackPlan,
  MAX_SUBTASKS,
  MAX_INPUT_LENGTH,
} from '../src/agents/plan-validator.js'

// ─── Tiny test harness (collect-all, fail-fast exit) ─────────────
const failures = []
let passed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

console.log('validatePlan (shape, agents, bounds)')

test('accepts a well-formed valid plan and assigns stable step IDs', () => {
  const result = validatePlan({
    plan: 'do the thing',
    subtasks: [
      { agentId: 'research-bot', input: 'find X' },
      { agentId: 'summary-bot', input: 'summarize X' },
    ],
  })
  assert.strictEqual(result.valid, true)
  assert.strictEqual(result.plan.subtasks.length, 2)
  assert.strictEqual(result.plan.subtasks[0].stepId, 'step-0')
  assert.strictEqual(result.plan.subtasks[1].stepId, 'step-1')
})

test('drops a model-supplied cost field entirely', () => {
  const result = validatePlan({
    plan: 'x',
    subtasks: [{ agentId: 'research-bot', input: 'find X', cost: '999999' }],
  })
  assert.strictEqual(result.valid, true)
  assert.strictEqual('cost' in result.plan.subtasks[0], false)
})

test('rejects a non-object plan', () => {
  assert.strictEqual(validatePlan(null).valid, false)
  assert.strictEqual(validatePlan('a string').valid, false)
  assert.strictEqual(validatePlan([]).valid, false)
})

test('rejects a plan with non-array subtasks', () => {
  const result = validatePlan({ plan: 'x', subtasks: 'not-an-array' })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtasks_not_array')
})

test('rejects a plan with an object (not array) subtasks field', () => {
  const result = validatePlan({ plan: 'x', subtasks: { agentId: 'research-bot' } })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtasks_not_array')
})

test('rejects an empty subtasks array', () => {
  const result = validatePlan({ plan: 'x', subtasks: [] })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtasks_empty')
})

test('rejects a plan with more subtasks than MAX_SUBTASKS', () => {
  const subtasks = Array.from({ length: MAX_SUBTASKS + 1 }, () => ({
    agentId: 'research-bot',
    input: 'x',
  }))
  const result = validatePlan({ plan: 'x', subtasks })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'too_many_subtasks')
})

test('rejects a subtask missing agentId', () => {
  const result = validatePlan({ plan: 'x', subtasks: [{ input: 'find X' }] })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtask_0_unknown_agent')
})

test('rejects a subtask missing input', () => {
  const result = validatePlan({ plan: 'x', subtasks: [{ agentId: 'research-bot' }] })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtask_0_invalid_input')
})

test('rejects a subtask with an unknown agentId', () => {
  const result = validatePlan({
    plan: 'x',
    subtasks: [{ agentId: 'totally-fake-bot', input: 'find X' }],
  })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtask_0_unknown_agent')
})

test('rejects a subtask with an oversized input string', () => {
  const result = validatePlan({
    plan: 'x',
    subtasks: [{ agentId: 'research-bot', input: 'x'.repeat(MAX_INPUT_LENGTH + 1) }],
  })
  assert.strictEqual(result.valid, false)
  assert.strictEqual(result.reason, 'subtask_0_input_too_long')
})

test('accepts repeated agents with distinct step IDs', () => {
  const result = validatePlan({
    plan: 'x',
    subtasks: [
      { agentId: 'research-bot', input: 'first pass' },
      { agentId: 'research-bot', input: 'second pass' },
    ],
  })
  assert.strictEqual(result.valid, true)
  assert.strictEqual(result.plan.subtasks[0].agentId, 'research-bot')
  assert.strictEqual(result.plan.subtasks[1].agentId, 'research-bot')
  assert.notStrictEqual(result.plan.subtasks[0].stepId, result.plan.subtasks[1].stepId)
})

console.log('buildFallbackPlan (bounded, budget-aware fallback)')

test('a generous budget produces a fully validated fallback plan with step IDs', () => {
  const plan = buildFallbackPlan('do the thing', 1)
  assert.ok(plan.subtasks.length > 0)
  plan.subtasks.forEach((s, i) => {
    assert.strictEqual(s.stepId, `step-${i}`)
    assert.ok(['research-bot', 'summary-bot', 'analyst-bot', 'code-bot'].includes(s.agentId))
  })
})

test('a zero budget produces an empty, still-valid fallback plan', () => {
  const plan = buildFallbackPlan('do the thing', 0)
  assert.strictEqual(plan.subtasks.length, 0)
})

test('fallback plan never carries a cost field (pricing resolves from the registry only)', () => {
  const plan = buildFallbackPlan('do the thing', 1)
  for (const s of plan.subtasks) {
    assert.strictEqual('cost' in s, false)
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
