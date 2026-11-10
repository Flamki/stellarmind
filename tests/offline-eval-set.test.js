/**
 * Tests for Issue #154:
 * Add a versioned offline evaluation set for agent output quality
 *
 * Run: node tests/offline-eval-set.test.js
 */

import assert from 'node:assert/strict'
import { AGENT_PROMPT_REVISIONS, getAgentRevisionMetadata } from '../src/agents/services.js'
import {
  DELIBERATELY_INCOMPLETE_FIXTURES,
  EVALUATION_BASELINE_SUMMARY,
  EVALUATION_SCHEMA_VERSION,
  EVALUATION_SUITE_VERSION,
  OFFLINE_EVALUATION_SET,
  PLANNING_MODEL,
  PLANNING_PROMPT_REVISION,
  evaluateOutputQualityCase,
  formatQualityEvaluationReport,
  getEvaluationRevisionManifest,
  getPlanningRevisionMetadata,
  runLiveQualityEvaluation,
  runOfflineQualityEvaluation,
} from '../src/agents/orchestrator.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.stack || err.message}`)
    failed++
  }
}

console.log('\n── Versioned Offline Agent Output Quality Evaluation Tests (#154) ──\n')

await test('1. Every evaluation case defines task, phase/agentId, prompt/model revision, expectedProperties, and humanReviewCriteria', () => {
  assert.equal(EVALUATION_SUITE_VERSION, '1.0.0')
  assert.equal(OFFLINE_EVALUATION_SET.length, 6)

  const phasesCovered = new Set()
  const agentsCovered = new Set()

  for (const evalCase of OFFLINE_EVALUATION_SET) {
    assert.equal(typeof evalCase.id, 'string')
    assert.ok(evalCase.id.length > 0)
    assert.equal(typeof evalCase.task, 'string')
    assert.ok(evalCase.task.length > 20)
    assert.ok(evalCase.phase === 'planning' || evalCase.phase === 'agent')
    assert.equal(typeof evalCase.agentId, 'string')
    assert.equal(typeof evalCase.promptRevision, 'string')
    assert.equal(typeof evalCase.modelRevision, 'string')
    assert.equal(typeof evalCase.expectedProperties, 'object')
    assert.ok(Object.keys(evalCase.expectedProperties).length >= 4)
    assert.ok(Array.isArray(evalCase.humanReviewCriteria))
    assert.ok(evalCase.humanReviewCriteria.length >= 2)
    assert.equal(typeof evalCase.baselineFixtureOutput, 'string')

    phasesCovered.add(evalCase.phase)
    agentsCovered.add(evalCase.agentId)
  }

  assert.deepEqual([...phasesCovered].sort(), ['agent', 'planning'])
  assert.deepEqual([...agentsCovered].sort(), [
    'analyst-bot',
    'code-bot',
    'orchestrator-planner',
    'research-bot',
    'summary-bot',
  ])

  const planningMeta = getPlanningRevisionMetadata()
  assert.equal(planningMeta.promptRevision, PLANNING_PROMPT_REVISION)
  assert.equal(planningMeta.modelRevision, PLANNING_MODEL)

  for (const agentId of ['research-bot', 'summary-bot', 'analyst-bot', 'code-bot']) {
    const meta = getAgentRevisionMetadata(agentId)
    assert.ok(meta)
    assert.equal(meta.promptRevision, AGENT_PROMPT_REVISIONS[agentId])
  }
})

await test('2. Offline structural evaluation runs without keys, wallets, or network access and matches baseline', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    throw new Error(`Network access is forbidden during offline quality evaluation: ${url}`)
  }

  try {
    const report = runOfflineQualityEvaluation()
    assert.equal(report.schemaVersion, EVALUATION_SCHEMA_VERSION)
    assert.equal(report.suiteVersion, EVALUATION_SUITE_VERSION)
    assert.equal(report.executionMode, 'offline-fixture')
    assert.equal(report.networkAccessRequired, false)
    assert.equal(report.apiKeysRequired, false)
    assert.equal(report.walletsRequired, false)

    assert.equal(report.summary.totalCases, EVALUATION_BASELINE_SUMMARY.totalCases)
    assert.equal(report.summary.passedCases, EVALUATION_BASELINE_SUMMARY.passedCases)
    assert.equal(report.summary.failedCases, 0)
    assert.equal(
      report.summary.totalAutomatedChecks,
      EVALUATION_BASELINE_SUMMARY.totalAutomatedChecks
    )
    assert.equal(
      report.summary.passedAutomatedChecks,
      EVALUATION_BASELINE_SUMMARY.passedAutomatedChecks
    )
    assert.equal(report.summary.score, 100)
    assert.equal(report.summary.allPassed, true)
    assert.equal(report.baselineComparison.matchesBaseline, true)
    assert.equal(report.baselineComparison.regressed, false)
    assert.equal(report.baselineComparison.status, 'matches_baseline')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('3. Reports identify prompt/model revisions and distinguish automated checks from human judgment', () => {
  const manifest = getEvaluationRevisionManifest()
  assert.equal(manifest.suiteVersion, '1.0.0')
  assert.equal(manifest.revisionDigest.startsWith('rev-'), true)

  const report = runOfflineQualityEvaluation()
  assert.deepEqual(report.revisions, manifest)
  assert.equal(report.summary.humanReviewStatus, 'pending_human_review')

  for (const caseResult of report.cases) {
    assert.equal(caseResult.automatedEvaluation.verificationType, 'automated_structural')
    assert.equal(caseResult.automatedEvaluation.passed, true)
    assert.equal(caseResult.humanEvaluation.verificationType, 'human_judgment_required')
    assert.equal(caseResult.humanEvaluation.status, 'pending_human_review')
    assert.equal(caseResult.humanEvaluation.automatedCannotVerify, true)
    assert.ok(caseResult.humanEvaluation.criteria.length >= 2)
  }

  const markdown = formatQualityEvaluationReport(report)
  assert.ok(markdown.includes('# StellarMind Agent Output Quality Evaluation Report'))
  assert.ok(markdown.includes('## Prompt & Model Revisions'))
  assert.ok(markdown.includes('## Automated Checks vs. Human Judgment'))
  assert.ok(markdown.includes('Human Judgment Criteria (Manual Review Required)'))
  assert.ok(markdown.includes(manifest.revisionDigest))
})

await test('4. Deliberately incomplete fixture outputs fail structural checks and flag baseline regression', () => {
  const failingReport = runOfflineQualityEvaluation({
    fixtureOutputs: DELIBERATELY_INCOMPLETE_FIXTURES,
  })

  assert.equal(failingReport.summary.allPassed, false)
  assert.equal(failingReport.summary.passedCases, 0)
  assert.equal(failingReport.summary.failedCases, OFFLINE_EVALUATION_SET.length)
  assert.ok(failingReport.summary.failedAutomatedChecks >= 10)
  assert.equal(failingReport.baselineComparison.regressed, true)
  assert.equal(failingReport.baselineComparison.status, 'regression_detected')

  // Verify specific failure modes per case
  const byId = Object.fromEntries(failingReport.cases.map((c) => [c.id, c]))

  // eval-planning-01: exceeds 0.08 budget (0.05 + 0.05 = 0.10) and misses required agents/terms
  const p1Checks = Object.fromEntries(
    byId['eval-planning-01'].automatedEvaluation.checks.map((c) => [c.name, c])
  )
  assert.equal(p1Checks.plan_within_budget_ceiling.passed, false)
  assert.equal(p1Checks.required_agents_selected.passed, false)

  // eval-planning-02: picks forbidden analyst-bot (0.05 USDC > 0.02 USDC cap)
  const p2Checks = Object.fromEntries(
    byId['eval-planning-02'].automatedEvaluation.checks.map((c) => [c.name, c])
  )
  assert.equal(p2Checks.plan_within_budget_ceiling.passed, false)
  assert.equal(p2Checks.forbidden_agents_excluded.passed, false)

  // eval-research-01: missing bullets and Sources: attribution
  const r1Checks = Object.fromEntries(
    byId['eval-research-01'].automatedEvaluation.checks.map((c) => [c.name, c])
  )
  assert.equal(r1Checks.min_bullet_points.passed, false)
  assert.equal(r1Checks.source_attribution.passed, false)

  // eval-summary-01: too short and missing Key Takeaway section
  const s1Checks = Object.fromEntries(
    byId['eval-summary-01'].automatedEvaluation.checks.map((c) => [c.name, c])
  )
  assert.equal(s1Checks.min_length.passed, false)
  assert.equal(s1Checks.required_sections.passed, false)

  // eval-analysis-01: missing Risks and Opportunities sections
  const a1Checks = Object.fromEntries(
    byId['eval-analysis-01'].automatedEvaluation.checks.map((c) => [c.name, c])
  )
  assert.equal(a1Checks.required_sections.passed, false)
  assert.equal(a1Checks.min_bullet_points.passed, false)

  // eval-code-01: missing fenced code block and required SDK tokens
  const c1Checks = Object.fromEntries(
    byId['eval-code-01'].automatedEvaluation.checks.map((c) => [c.name, c])
  )
  assert.equal(c1Checks.fenced_code_block.passed, false)
  assert.equal(c1Checks.required_code_tokens.passed, false)
  assert.equal(c1Checks.balanced_code_delimiters.passed, false)

  // Also verify unbalanced code block detection on code-bot
  const unbalancedCase = evaluateOutputQualityCase(
    OFFLINE_EVALUATION_SET.find((c) => c.id === 'eval-code-01'),
    '```javascript\nasync function broken( { TransactionBuilder(); Operation.payment(); Networks.TESTNET\n```\nExplanation text outside the code block for testing.'
  )
  const unbalancedCheck = unbalancedCase.automatedEvaluation.checks.find(
    (c) => c.name === 'balanced_code_delimiters'
  )
  assert.equal(unbalancedCheck.passed, false)
})

await test('5. Running the offline evaluation suite twice produces deterministic JSON and Markdown reports', () => {
  const reportRun1 = runOfflineQualityEvaluation()
  const reportRun2 = runOfflineQualityEvaluation()

  assert.deepEqual(reportRun1, reportRun2)
  assert.equal(JSON.stringify(reportRun1), JSON.stringify(reportRun2))

  const markdownRun1 = formatQualityEvaluationReport(reportRun1)
  const markdownRun2 = formatQualityEvaluationReport(reportRun2)
  assert.equal(markdownRun1, markdownRun2)
})

await test('6. Live model evaluation is disabled by default and enforces explicit cost caps when opted in', async () => {
  await assert.rejects(
    () => runLiveQualityEvaluation(),
    (err) => err.code === 'LIVE_EVAL_DISABLED'
  )

  await assert.rejects(
    () =>
      runLiveQualityEvaluation({
        allowLiveModelCalls: true,
        maxTotalTokens: 100,
        generateOutput: async (evalCase) => ({
          text: evalCase.baselineFixtureOutput,
          tokens: 60,
          estimatedUsd: 0.001,
        }),
      }),
    (err) => err.code === 'LIVE_EVAL_COST_CAP_EXCEEDED'
  )

  const controlledLiveReport = await runLiveQualityEvaluation({
    allowLiveModelCalls: true,
    maxCases: 2,
    maxTotalTokens: 500,
    maxEstimatedUsd: 0.02,
    generateOutput: async (evalCase) => ({
      text: evalCase.baselineFixtureOutput,
      tokens: 120,
      estimatedUsd: 0.002,
    }),
  })
  assert.equal(controlledLiveReport.executionMode, 'live-model')
  assert.equal(controlledLiveReport.summary.totalCases, 2)
  assert.equal(controlledLiveReport.summary.passedCases, 2)
  assert.equal(controlledLiveReport.costControls.totalTokensUsed, 240)
  assert.equal(controlledLiveReport.costControls.totalEstimatedUsd, 0.004)
})

console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
