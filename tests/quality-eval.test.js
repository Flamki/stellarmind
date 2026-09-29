/**
 * Tests for the offline agent-output quality suite (Issue #154).
 *
 * Covers the acceptance criteria that can be asserted rather than described:
 *  - every case defines a task, an agent/phase and concrete success properties
 *  - the structural checks run without keys, wallets or network access
 *  - reports identify the prompt/model revision and separate automated checks
 *    from human judgement
 *  - deliberately incomplete captures fail, so the checks can actually fail
 *  - the offline suite is deterministic: two runs produce identical reports
 *  - the committed baseline matches the committed fixtures (regression gate)
 *
 * Run: node tests/quality-eval.test.js
 */

import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  CHECK_KINDS,
  QUALITY_SET_SCHEMA_VERSION,
  QualitySetError,
  checkProperty,
  loadQualitySet,
  revisionsOf,
  validateQualitySet,
} from '../src/eval/quality-checks.js'
import {
  buildQualityReport,
  renderQualityMarkdown,
  diffAgainstBaseline,
} from '../src/eval/quality-report.js'
import {
  parseArgs,
  readFixtureOutputs,
  currentModelRevision,
} from '../src/eval/run-quality-eval.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const runnerPath = path.join(repoRoot, 'src', 'eval', 'run-quality-eval.js')
const baselineDir = path.join(repoRoot, 'eval', 'fixtures', 'baseline')
const incompleteDir = path.join(repoRoot, 'eval', 'fixtures', 'incomplete')
const baselineReportPath = path.join(repoRoot, 'eval', 'baseline.json')

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

/** Environment with every credential removed, to prove the offline path needs none. */
function credentialFreeEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/(ANTHROPIC|SECRET|API_KEY|TOKEN)/i.test(key)) delete env[key]
  }
  env.EVAL_LIVE_CONFIRM = ''
  return env
}

function runCli(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [runnerPath, ...args], {
      cwd: repoRoot,
      env: credentialFreeEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      ...options,
    })
    return { status: 0, stdout }
  } catch (err) {
    return { status: err.status ?? 1, stdout: `${err.stdout || ''}${err.stderr || ''}` }
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

console.log('\noffline agent-output quality suite (issue #154)')

// ─── The set itself ──────────────────────────────────────────

await test('the shipped quality set satisfies its own schema', () => {
  const set = loadQualitySet()
  assert.strictEqual(set.schemaVersion, QUALITY_SET_SCHEMA_VERSION)
  assert.ok(set.cases.length >= 4, 'the set covers the agents the platform routes')
  for (const caseDef of set.cases) {
    assert.ok(caseDef.task.length > 20, `${caseDef.id}: task is a real prompt`)
    assert.ok(caseDef.agent && caseDef.phase, `${caseDef.id}: names an agent and a phase`)
    for (const property of caseDef.successProperties) {
      assert.ok(CHECK_KINDS.has(property.kind), `${caseDef.id}: kind ${property.kind} is supported`)
      assert.ok(property.description, `${caseDef.id}/${property.id}: says what passing means`)
    }
  }
  const agents = set.cases.map((caseDef) => caseDef.agent)
  for (const agent of ['research', 'summary', 'analysis', 'code']) {
    assert.ok(agents.includes(agent), `the set covers the ${agent} agent`)
  }
})

await test('a malformed set is rejected instead of scoring everything as failed', () => {
  const base = { schemaVersion: 1, cases: [] }
  const validCase = {
    id: 'c1',
    agent: 'research',
    phase: 'research',
    task: 'Summarise something long enough to look like a prompt.',
    successProperties: [{ id: 'p1', kind: 'contains-all', terms: ['ok'], description: 'says ok' }],
  }

  assert.throws(
    () => validateQualitySet({ ...base, schemaVersion: 99, cases: [validCase] }),
    QualitySetError
  )
  assert.throws(() => validateQualitySet(base), /at least one case/)

  const unknownKind = structuredClone(validCase)
  unknownKind.successProperties[0].kind = 'vibes'
  assert.throws(() => validateQualitySet({ ...base, cases: [unknownKind] }), /unknown check kind/)

  const noTerms = structuredClone(validCase)
  noTerms.successProperties[0].terms = []
  assert.throws(() => validateQualitySet({ ...base, cases: [noTerms] }), /non-empty "terms"/)

  const noDescription = structuredClone(validCase)
  delete noDescription.successProperties[0].description
  assert.throws(() => validateQualitySet({ ...base, cases: [noDescription] }), /description/)

  const duplicateCaseIds = { ...base, cases: [validCase, structuredClone(validCase)] }
  assert.throws(() => validateQualitySet(duplicateCaseIds), /duplicate case id/)

  const duplicatePropertyIds = structuredClone(validCase)
  duplicatePropertyIds.successProperties.push(structuredClone(validCase.successProperties[0]))
  assert.throws(
    () => validateQualitySet({ ...base, cases: [duplicatePropertyIds] }),
    /duplicate property id/
  )

  const badPattern = structuredClone(validCase)
  badPattern.successProperties[0] = {
    id: 'p1',
    kind: 'regex-all',
    patterns: ['['],
    description: 'broken regex',
  }
  assert.throws(() => validateQualitySet({ ...base, cases: [badPattern] }), /not a valid regular/)

  const emptyReview = structuredClone(validCase)
  emptyReview.humanReview = []
  assert.throws(() => validateQualitySet({ ...base, cases: [emptyReview] }), /humanReview/)
})

// ─── Individual checks ───────────────────────────────────────

await test('json-shape accepts an object with the required keys and rejects the rest', () => {
  const property = {
    id: 'shape',
    kind: 'json-shape',
    required: ['summary', 'risks'],
    description: 'structured answer',
  }
  assert.strictEqual(checkProperty(property, '{"summary":"s","risks":[]}').passed, true)
  assert.strictEqual(checkProperty(property, '{"summary":"s"}').passed, false)
  assert.strictEqual(checkProperty(property, 'not json at all').passed, false)
  assert.strictEqual(checkProperty(property, '["summary","risks"]').passed, false)
  assert.match(checkProperty(property, '{"summary":"s"}').reason, /missing keys: risks/)
})

await test('word, bullet and code-block checks count what they claim to count', () => {
  const text = [
    'Header',
    '- one two three',
    '- four five',
    '```js',
    'const a = 1',
    'const b = 2',
    '```',
  ].join('\n')

  assert.strictEqual(
    checkProperty({ id: 'w', kind: 'word-count', min: 1, max: 20, description: 'w' }, text).passed,
    true
  )
  assert.strictEqual(
    checkProperty({ id: 'w', kind: 'word-count', min: 99, description: 'w' }, text).passed,
    false
  )
  assert.strictEqual(
    checkProperty({ id: 'b', kind: 'bullet-count', count: 2, description: 'b' }, text).passed,
    true
  )
  assert.strictEqual(
    checkProperty({ id: 'b', kind: 'bullet-count', count: 3, description: 'b' }, text).passed,
    false
  )
  assert.strictEqual(
    checkProperty({ id: 'bw', kind: 'bullet-word-count', max: 4, description: 'bw' }, text).passed,
    true
  )
  assert.strictEqual(
    checkProperty({ id: 'bw', kind: 'bullet-word-count', max: 1, description: 'bw' }, text).passed,
    false
  )
  assert.strictEqual(
    checkProperty({ id: 'f', kind: 'code-fence-count', count: 1, description: 'f' }, text).passed,
    true
  )
  assert.strictEqual(
    checkProperty({ id: 'f', kind: 'code-fence-max-lines', max: 5, description: 'f' }, text).passed,
    true
  )
  assert.strictEqual(
    checkProperty({ id: 'f', kind: 'code-fence-max-lines', max: 1, description: 'f' }, text).passed,
    false
  )
})

// ─── Baseline fixtures ───────────────────────────────────────

await test('the baseline captures pass every automated check', () => {
  const set = loadQualitySet()
  const { outputs, missing } = readFixtureOutputs(set, baselineDir)
  assert.deepStrictEqual(missing, [], 'every case has a baseline capture')

  const report = buildQualityReport({ set, outputs, modelRevision: currentModelRevision() })
  const failed = report.cases.flatMap((entry) =>
    entry.checks.filter((check) => !check.passed).map((check) => `${entry.id}/${check.id}`)
  )
  assert.deepStrictEqual(failed, [], `unexpected failures: ${failed.join(', ')}`)
  assert.strictEqual(report.summary.properties, 17)
  assert.strictEqual(report.summary.allPassed, true)
})

await test('the committed baseline report matches the committed fixtures', () => {
  const set = loadQualitySet()
  const { outputs } = readFixtureOutputs(set, baselineDir)
  const report = buildQualityReport({ set, outputs, modelRevision: currentModelRevision() })
  const baseline = JSON.parse(fs.readFileSync(baselineReportPath, 'utf8'))

  const diff = diffAgainstBaseline(report, baseline)
  assert.strictEqual(diff.matches, true, diff.differences.join('; '))
  assert.deepStrictEqual(
    Object.keys(baseline.promptRevisions).sort(),
    set.cases.map((caseDef) => caseDef.id).sort(),
    'the baseline records a prompt revision per case'
  )
})

// ─── Incomplete fixtures must fail ───────────────────────────

await test('the deliberately incomplete captures fail, with a reason per check', () => {
  const set = loadQualitySet()
  const { outputs } = readFixtureOutputs(set, incompleteDir)
  const report = buildQualityReport({ set, outputs, modelRevision: currentModelRevision() })

  assert.strictEqual(report.summary.allPassed, false, 'incomplete outputs cannot pass')

  const failedByCase = Object.fromEntries(
    report.cases.map((entry) => [
      entry.id,
      entry.checks
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .sort(),
    ])
  )
  assert.deepStrictEqual(failedByCase['research-oss-licence-tradeoffs'], [
    'length-bounded',
    'licence-terms',
    'sections-present',
  ])
  assert.deepStrictEqual(failedByCase['summary-release-notes-for-stakeholders'], [
    'bullets-are-short',
    'exactly-five-bullets',
    'highlights-heading',
    'no-internal-jargon',
  ])
  assert.deepStrictEqual(failedByCase['analysis-cloud-cost-drivers'], [
    'quantified',
    'risk-called-out',
  ])
  assert.deepStrictEqual(failedByCase['code-retry-with-backoff'], [
    'async-function',
    'no-placeholders',
    'one-code-block',
  ])

  for (const entry of report.cases) {
    for (const check of entry.checks) {
      if (!check.passed)
        assert.ok(check.reason.length > 0, `${entry.id}/${check.id} explains itself`)
    }
  }
})

await test('the CLI exits non-zero on the incomplete captures and zero on the baseline', () => {
  const good = runCli([])
  assert.strictEqual(good.status, 0, good.stdout)

  const bad = runCli(['--fixtures', incompleteDir])
  assert.strictEqual(bad.status, 1, 'a failing capture must fail the run')
  assert.match(bad.stdout, /Automated checks below decide only structure/)
})

// ─── Offline + deterministic ─────────────────────────────────

await test('the offline run needs no credentials and refuses live mode without confirmation', () => {
  const offline = runCli(['--format', 'json'])
  assert.strictEqual(offline.status, 0, 'the suite runs with every credential removed')
  const report = JSON.parse(offline.stdout)
  assert.strictEqual(report.offline, true)

  const live = runCli(['--live'])
  assert.strictEqual(live.status, 2, 'live mode must fail fast without a key and a confirmation')
  assert.match(live.stdout, /ANTHROPIC_API_KEY|EVAL_LIVE_CONFIRM/)
})

await test('two runs produce byte-identical reports', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-eval-a-'))
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-eval-b-'))

  assert.strictEqual(runCli(['--out', first]).status, 0)
  assert.strictEqual(runCli(['--out', second]).status, 0)

  assert.strictEqual(
    sha256(path.join(first, 'quality-report.json')),
    sha256(path.join(second, 'quality-report.json'))
  )
  assert.strictEqual(
    sha256(path.join(first, 'quality-report.md')),
    sha256(path.join(second, 'quality-report.md'))
  )

  const set = loadQualitySet()
  const { outputs } = readFixtureOutputs(set, baselineDir)
  assert.deepStrictEqual(
    buildQualityReport({ set, outputs, modelRevision: currentModelRevision() }),
    buildQualityReport({ set, outputs, modelRevision: currentModelRevision() }),
    'the in-process report builder is deterministic too'
  )
})

await test('an empty capture fails every check rather than passing quietly', () => {
  const set = loadQualitySet()
  const outputs = Object.fromEntries(set.cases.map((caseDef) => [caseDef.id, { text: '' }]))
  const report = buildQualityReport({ set, outputs })

  assert.strictEqual(report.summary.passed, 0)
  assert.strictEqual(report.summary.failed, report.summary.properties)
  for (const entry of report.cases) assert.strictEqual(entry.outputPresent, false)
})

// ─── Report contents ─────────────────────────────────────────

await test('the report identifies revisions and separates automated from human judgement', () => {
  const set = loadQualitySet()
  const { outputs } = readFixtureOutputs(set, baselineDir)
  const report = buildQualityReport({ set, outputs, modelRevision: 'model-rev-test' })
  const { setRevision, promptRevisions } = revisionsOf(set)

  assert.strictEqual(report.setRevision, setRevision)
  assert.strictEqual(report.modelRevision, 'model-rev-test')
  assert.deepStrictEqual(report.promptRevisions, promptRevisions)
  assert.match(report.humanJudgment.note, /human decision/)
  assert.ok(report.humanJudgment.cases.length > 0, 'cases with review questions are listed')
  assert.ok(
    report.cases.every((entry) => entry.automated.checks > 0),
    'every case carries automated checks'
  )
  assert.ok(
    report.cases.every((entry) => entry.humanJudgment.questions.length > 0),
    'every case carries its human questions'
  )

  const markdown = renderQualityMarkdown(report)
  assert.match(markdown, /# Agent output quality report \(offline\)/)
  assert.match(markdown, new RegExp(setRevision))
  assert.match(markdown, /Left to human judgement/)
})

await test('a prompt edit moves the revision, so a report cannot silently describe an old set', () => {
  const set = loadQualitySet()
  const before = revisionsOf(set).setRevision
  const edited = structuredClone(set)
  edited.cases[0].task = `${edited.cases[0].task} Be brief.`

  assert.notStrictEqual(revisionsOf(edited).setRevision, before)
  assert.notStrictEqual(
    revisionsOf(edited).promptRevisions[edited.cases[0].id],
    revisionsOf(set).promptRevisions[set.cases[0].id]
  )
})

// ─── Baseline drift detection ────────────────────────────────

await test('baseline drift is reported per case and property', () => {
  const set = loadQualitySet()
  const { outputs } = readFixtureOutputs(set, baselineDir)
  const report = buildQualityReport({ set, outputs, modelRevision: currentModelRevision() })

  const drifted = structuredClone(report)
  drifted.cases[0].checks[0].passed = false
  const diff = diffAgainstBaseline(drifted, report)
  assert.strictEqual(diff.matches, false)
  assert.match(diff.differences.join('; '), /result changed: .*\/.* pass -> FAIL/)

  const removedCase = structuredClone(report)
  removedCase.cases.pop()
  assert.match(diffAgainstBaseline(removedCase, report).differences.join('; '), /case removed:/)

  assert.strictEqual(diffAgainstBaseline(report, null).matches, false, 'no baseline is drift')
})

await test('--check-baseline passes on the committed fixture set', () => {
  const result = runCli(['--check-baseline'])
  assert.strictEqual(result.status, 0, result.stdout)
  assert.match(result.stdout, /baseline matches/)
})

// ─── CLI argument handling ───────────────────────────────────

await test('the runner rejects unusable arguments', () => {
  assert.throws(() => parseArgs(['--format', 'yaml']), /--format must be/)
  assert.throws(() => parseArgs(['--max-cases', '0']), /--max-cases/)
  assert.throws(() => parseArgs(['--fixtures']), /requires a value/)
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)

  const args = parseArgs(['--fixtures', 'eval/fixtures/incomplete', '--format', 'json'])
  assert.strictEqual(args.format, 'json')
  assert.ok(args.fixtures.endsWith(path.join('eval', 'fixtures', 'incomplete')))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exitCode = 1
}
