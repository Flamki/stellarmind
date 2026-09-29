/**
 * Tests for the dashboard live-progress reducer (Issue #163).
 *
 * The reducer ships to the browser as a classic script
 * (public/assets/js/run-progress.js), so the test loads that exact file with a
 * `window` stub instead of a copy — the assertions describe what the dashboard
 * actually runs.
 *
 * Covers the issue's acceptance criteria:
 *  - two steps that use the same agent are counted as two steps
 *  - events belonging to another run never move the selected run
 *
 * Run: node tests/run-progress.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const reducerPath = path.join(here, '..', 'public', 'assets', 'js', 'run-progress.js')
const source = fs.readFileSync(reducerPath, 'utf8')

// The file is a classic script talking to `window`; give it one.
const windowStub = {}

new Function('window', 'module', source)(windowStub, undefined)
const RunProgress = windowStub.RunProgress

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

console.log('\ndashboard live progress reducer (issue #163)')

assert.ok(RunProgress, 'public/assets/js/run-progress.js must expose window.RunProgress')

const step = (agentId, agent, stepId, type = 'agent_call') => ({
  type,
  agentId,
  agent,
  stepId,
  runId: 'run_A',
})

await test('two calls to the same agent count as two steps', () => {
  const run = RunProgress.createRunProgress('task', 5)
  const first = RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's2'))
  const second = RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's3'))

  assert.strictEqual(first.stepStarted, true)
  assert.strictEqual(second.stepStarted, true, 'the second call is a step of its own')
  assert.strictEqual(run.steps.size, 2, 'two steps are tracked, not one agent')
  assert.notStrictEqual(first.stepKey, second.stepKey)
})

await test('a repeated event for the same step does not count twice', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's2'))
  const again = RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's2'))

  assert.strictEqual(again.stepStarted, false)
  assert.strictEqual(run.steps.size, 1)
})

await test('a response completes the step its call started', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's2'))
  const done = RunProgress.reduceLiveEvent(
    run,
    step('research-bot', 'Research Agent', 's2', 'agent_response')
  )

  assert.strictEqual(done.stepCompleted, true)
  assert.strictEqual(run.completed, 1, 'one step completed')
  assert.strictEqual(run.steps.size, 1, 'still the same step')
  assert.strictEqual(run.steps.get('step:s2').state, 'completed')
})

await test('two steps on one agent complete as two steps', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's2'))
  RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's3'))
  RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's2', 'agent_response'))
  RunProgress.reduceLiveEvent(run, step('research-bot', 'Research Agent', 's3', 'agent_response'))

  assert.strictEqual(run.steps.size, 2)
  assert.strictEqual(run.completed, 2)
})

await test('spend accumulates once per completed step', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, step('a-bot', 'A', 's2'))
  RunProgress.reduceLiveEvent(run, { ...step('a-bot', 'A', 's2', 'agent_response'), cost: '0.01' })
  RunProgress.reduceLiveEvent(run, { ...step('a-bot', 'A', 's2', 'agent_response'), cost: '0.01' })

  assert.strictEqual(run.spent, 0.01, 'a duplicate response does not double-charge')
})

await test('the dashboard adopts the run it started and ignores other runs', () => {
  const run = RunProgress.createRunProgress('task', 5)
  const mine = RunProgress.reduceLiveEvent(run, { ...step('a-bot', 'A', 's1'), runId: 'run_A' })
  assert.strictEqual(mine.accepted, true)
  assert.strictEqual(run.runId, 'run_A', 'the first identified event claims the run')

  const theirs = RunProgress.reduceLiveEvent(run, {
    ...step('a-bot', 'A', 's1'),
    runId: 'run_B',
    cost: '9',
    type: 'agent_response',
  })
  assert.strictEqual(theirs.accepted, false)
  assert.strictEqual(theirs.ignored, true)
  assert.strictEqual(run.ignoredEvents, 1)
  assert.strictEqual(run.completed, 0, 'a foreign run cannot complete a step here')
  assert.strictEqual(run.spent, 0, 'a foreign run cannot spend here')
})

await test('a foreign run cannot overwrite progress already recorded', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, { ...step('a-bot', 'A', 's1'), runId: 'run_A' })
  RunProgress.reduceLiveEvent(run, { type: 'orchestrator_plan', subtaskCount: 3, runId: 'run_A' })
  RunProgress.reduceLiveEvent(run, { type: 'orchestrator_plan', subtaskCount: 99, runId: 'run_B' })

  assert.strictEqual(run.planned, 3, 'the plan of another run is not applied')
})

await test('an event with no run identity is ignored once a run is selected', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, { ...step('a-bot', 'A', 's1'), runId: 'run_A' })

  const anonymous = RunProgress.reduceLiveEvent(run, {
    type: 'agent_call',
    agentId: 'premium-bot',
    agent: 'Premium Agent',
    stepId: 's7',
  })
  assert.strictEqual(anonymous.accepted, false, 'unidentified events cannot move a selected run')
  assert.strictEqual(run.steps.size, 1)
})

await test('without step ids the same agent is still two steps', () => {
  // Older servers sent no step identity at all: every event must still be its
  // own step, which is exactly what the agent-keyed sets got wrong.
  const run = RunProgress.createRunProgress('task', 5)
  const first = RunProgress.reduceLiveEvent(run, { type: 'agent_call', agentId: 'a-bot' })
  const second = RunProgress.reduceLiveEvent(run, { type: 'agent_call', agentId: 'a-bot' })

  assert.strictEqual(first.stepStarted, true)
  assert.strictEqual(second.stepStarted, true)
  assert.strictEqual(run.steps.size, 2)
})

await test('the plan sets the step budget and completion stops the run', () => {
  const run = RunProgress.createRunProgress('task', 5)
  RunProgress.reduceLiveEvent(run, { type: 'orchestrator_plan', subtaskCount: 3 })
  assert.strictEqual(run.planned, 3)
  assert.strictEqual(run.running, true)

  RunProgress.reduceLiveEvent(run, { type: 'orchestrator_complete' })
  assert.strictEqual(run.running, false)
})

await test('an unusable event never throws', () => {
  const run = RunProgress.createRunProgress('task', 5)
  assert.strictEqual(RunProgress.reduceLiveEvent(run, null).accepted, false)
  assert.strictEqual(RunProgress.reduceLiveEvent(null, { type: 'agent_call' }).accepted, false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exitCode = 1
}
