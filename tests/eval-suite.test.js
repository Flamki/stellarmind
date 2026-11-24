/**
 * Offline agent quality evaluation suite tests (issue #154).
 *
 * Proves, with no key, wallet or network:
 *  - every case defines a task, agent/phase and concrete success properties
 *  - the structural checks pass on reference outputs and FAIL on deliberately
 *    incomplete ones, for exactly the expected reasons
 *  - the report is deterministic (two independent processes, a CRLF checkout
 *    and a different working directory all give identical bytes)
 *  - the report names the model and prompt revision, and a prompt change
 *    breaks the committed baseline until it is accepted
 *  - automated checks and human judgment are reported separately
 *  - live evaluation is opt-in and cost-capped
 *
 * Run: node tests/eval-suite.test.js
 */
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CHECK_TYPES, runProperty } from '../evals/lib/checks.js'
import { EVALS_DIR, EvalSetError, loadEvalSet } from '../evals/lib/load.js'
import { currentRevisions } from '../evals/lib/revisions.js'
import { loadReviews, reviewStatus } from '../evals/lib/reviews.js'
import { buildReport, renderMarkdown } from '../evals/lib/report.js'
import {
  DEFAULT_MAX_CASES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  liveBlocker,
  liveLimits,
  runLive,
} from '../evals/lib/live.js'
import { BASELINE_DIR, compareWithBaseline, generateOffline, main } from '../evals/run.js'
import { AGENT_MODELS, PROMPT_TEMPLATES } from '../src/agents/services.js'
import { promptDigest } from '../src/agents/provenance.js'

const execFileAsync = promisify(execFile)
const RUN_JS = path.join(EVALS_DIR, 'run.js')

// ─── Tiny test harness (async-capable, collect-all, fail-fast exit) ──
const queue = []
function test(name, fn) {
  queue.push({ name, fn })
}
function section(title) {
  queue.push({ title })
}

function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-suite-'))
  fs.cpSync(EVALS_DIR, dir, { recursive: true })
  return dir
}

function editCases(dir, mutate) {
  const file = path.join(dir, 'cases.v1.json')
  const set = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(set)
  fs.writeFileSync(file, JSON.stringify(set, null, 2))
}

function loadProblems(dir) {
  try {
    loadEvalSet(dir)
  } catch (err) {
    assert.ok(err instanceof EvalSetError, `expected EvalSetError, got ${err}`)
    return err.problems.join('\n')
  }
  assert.fail('expected the evaluation set to be rejected')
}

function check(check, args, text, ctx = { input: '', context: { budget: 0.05 } }) {
  return runProperty({ id: 'p', check, args }, text, ctx)
}

const PLAN_OK = JSON.stringify({
  plan: 'x',
  subtasks: [
    { agentId: 'research-bot', input: 'find serverless facts', cost: '9.99' },
    { agentId: 'summary-bot', input: 'summarize them' },
  ],
})

// ═════════════════════════════════════════════════════════════════
section('Evaluation set structure')

test('every case defines a task, agent/phase and concrete success properties', () => {
  const { cases } = loadEvalSet()
  assert.ok(cases.length >= 10, 'a small curated set of at least 10 cases')
  for (const c of cases) {
    assert.ok(c.task.length > 0 && c.agent && c.phase, c.id)
    assert.ok(c.properties.length >= 5, `${c.id} should have concrete properties`)
    assert.ok(
      c.properties.every((p) => p.description && CHECK_TYPES.includes(p.check)),
      c.id
    )
    assert.ok(c.humanReview.length >= 1, `${c.id} lists human-judgment questions`)
  }
})

test('the set covers summarization, analysis, planning and code assistance', () => {
  const { cases } = loadEvalSet()
  const agents = new Set(cases.map((c) => c.agent))
  for (const id of ['research-bot', 'summary-bot', 'analyst-bot', 'code-bot', 'orchestrator']) {
    assert.ok(agents.has(id), `missing agent ${id}`)
  }
  assert.ok(cases.some((c) => c.phase === 'plan') && cases.some((c) => c.phase === 'execute'))
})

test('the loader rejects incomplete case definitions', () => {
  const cases = [
    ['no task', (c) => (c.task = ''), 'task is required'],
    ['no properties', (c) => (c.properties = []), 'at least one success property'],
    ['unknown check', (c) => (c.properties[0].check = 'vibes'), 'unknown check "vibes"'],
    ['unknown agent', (c) => (c.agent = 'ghost-bot'), 'is not in the registry'],
    ['wrong phase', (c) => (c.phase = 'plan'), 'phase must be "execute"'],
    ['no human questions', (c) => (c.humanReview = []), 'humanReview needs at least one question'],
    [
      'no negatives',
      (c) => (c.fixtures.negative = []),
      'negative (incomplete) fixture is required',
    ],
    ['bad expectFail', (c) => (c.fixtures.negative[0].expectFail = ['nope']), 'is not a property'],
    ['missing fixture', (c) => (c.fixtures.pass = 'gone.txt'), 'does not exist'],
  ]
  for (const [label, mutate, expected] of cases) {
    const dir = tempCopy()
    editCases(dir, (set) => mutate(set.cases[0]))
    assert.ok(loadProblems(dir).includes(expected), `${label}: ${expected}`)
  }
})

test('the loader rejects duplicate ids and orphaned fixture files', () => {
  let dir = tempCopy()
  editCases(dir, (set) => (set.cases[1].id = set.cases[0].id))
  assert.ok(loadProblems(dir).includes('duplicate id'))

  dir = tempCopy()
  fs.writeFileSync(path.join(dir, 'fixtures', 'research-http-402', 'stray.txt'), 'x')
  assert.ok(loadProblems(dir).includes('"stray.txt" is not referenced'))
})

// ═════════════════════════════════════════════════════════════════
section('Structural checks')

test('sentence and word counts ignore list markers, code and decimals', () => {
  assert.strictEqual(check('sentence_count', { min: 3, max: 3 }, 'One. Two. Three.').pass, true)
  assert.strictEqual(
    check('sentence_count', { min: 2, max: 2 }, 'Costs 4.5 dollars. Fine.').pass,
    true
  )
  assert.strictEqual(
    check('sentence_count', { min: 2, max: 2 }, '- Alpha beta.\n- Gamma delta.').pass,
    true
  )
  assert.strictEqual(
    check('sentence_count', { min: 1, max: 1 }, 'Hi there.\n```js\nx. Y. Z.\n```').pass,
    true
  )
  assert.strictEqual(check('word_count', { min: 3, max: 3 }, 'one two three').pass, true)
  assert.strictEqual(check('word_count', { min: 4 }, 'one two three').pass, false)
})

test('headings and bullet counts follow the prompt format', () => {
  const text =
    '**Key Findings**\n- a\n- b\n\n2. **Risks** (2-3 potential concerns)\n- c\n\n## Opportunities\n- d\n- e\n- f'
  const headings = { required: ['Key Findings', 'Risks', 'Opportunities'] }
  assert.strictEqual(check('headings', headings, text).pass, true)
  assert.strictEqual(check('headings', headings, 'Key Findings\nRisks and more').pass, false)
  assert.strictEqual(
    check('section_bullets', { heading: 'Key Findings', min: 2, max: 2 }, text).pass,
    true
  )
  assert.strictEqual(
    check('section_bullets', { heading: 'Risks', min: 1, max: 1 }, text).pass,
    true
  )
  assert.strictEqual(
    check('section_bullets', { heading: 'Opportunities', min: 3, max: 3 }, text).pass,
    true
  )
  assert.strictEqual(check('section_bullets', { heading: 'Missing', min: 1 }, text).pass, false)
})

test('code checks parse JavaScript without running it and reject broken blocks', () => {
  const ok = '```js\nfunction f() { return 1 }\n```'
  assert.strictEqual(check('js_syntax', {}, ok).pass, true)
  assert.strictEqual(check('js_syntax', {}, '```javascript\nconst a = 1\n```').pass, true)
  assert.strictEqual(check('js_syntax', {}, '```js\nfunction f( {\n```').pass, false)
  assert.strictEqual(check('js_syntax', {}, 'no code here').pass, false)
  // Parsing must never execute the code.
  globalThis.__evalSideEffect = false
  check('js_syntax', {}, '```js\nglobalThis.__evalSideEffect = true\n```')
  assert.strictEqual(globalThis.__evalSideEffect, false)
  // An unterminated fence is not a block (a truncated answer).
  assert.strictEqual(check('code_block', { language: 'js' }, '```js\nfunction f() {').pass, false)
  assert.strictEqual(
    check('code_block', { language: 'js', maxLines: 1 }, '```js\na\nb\n```').pass,
    false
  )
})

test('the incomplete-output checks catch truncation, emptiness and placeholders', () => {
  assert.strictEqual(check('ends_cleanly', {}, 'A complete sentence.').pass, true)
  assert.strictEqual(check('ends_cleanly', {}, 'A sentence that stops mid').pass, false)
  assert.strictEqual(check('not_empty', {}, '  \n ').pass, false)
  assert.strictEqual(check('not_contains', { terms: ['todo'] }, 'TODO: finish').pass, false)
  assert.strictEqual(
    check('max_word_ratio_of_input', { max: 0.5 }, 'a b c', { input: 'a b c d e f g h' }).pass,
    true
  )
  assert.strictEqual(
    check('max_word_ratio_of_input', { max: 0.5 }, 'a b c d e f', { input: 'a b c d e f g h' })
      .pass,
    false
  )
})

test('plan checks use the orchestrator parser and validator', () => {
  const ctx = { input: 't', context: { budget: 0.05 } }
  assert.strictEqual(check('plan_valid', {}, PLAN_OK, ctx).pass, true)
  assert.strictEqual(check('plan_valid', {}, `\`\`\`json\n${PLAN_OK}\n\`\`\``, ctx).pass, true)
  const truncated = check('plan_valid', {}, PLAN_OK.slice(0, 40), ctx)
  assert.strictEqual(truncated.pass, false)
  assert.ok(truncated.detail.includes('PLAN_INVALID_JSON'))
  const unknown = PLAN_OK.replace('summary-bot', 'ghost-bot')
  assert.ok(check('plan_valid', {}, unknown, ctx).detail.includes('unknown_agent'))
  assert.ok(
    check('plan_valid', {}, '{"plan":"x","subtasks":[]}', ctx).detail.includes('subtasks_empty')
  )
})

test('plan checks cover agents, order, budget and a model-supplied cost is ignored', () => {
  const ctx = { input: 't', context: { budget: 0.05 } }
  const agents = {
    include: ['research-bot', 'summary-bot'],
    order: ['research-bot', 'summary-bot'],
  }
  assert.strictEqual(check('plan_agents', agents, PLAN_OK, ctx).pass, true)
  assert.strictEqual(
    check('plan_agents', { order: ['summary-bot', 'research-bot'] }, PLAN_OK, ctx).pass,
    false
  )
  assert.strictEqual(check('plan_agents', { exclude: ['summary-bot'] }, PLAN_OK, ctx).pass, false)
  // The plan claims a cost of 9.99, but only registry prices count.
  assert.strictEqual(check('plan_within_budget', {}, PLAN_OK, ctx).pass, true)
  assert.strictEqual(
    check('plan_within_budget', {}, PLAN_OK, { ...ctx, context: { budget: 0.01 } }).pass,
    false
  )
  assert.strictEqual(
    check('plan_input_mentions', { terms: ['serverless'] }, PLAN_OK, ctx).pass,
    true
  )
  assert.strictEqual(check('plan_subtasks', { min: 3 }, PLAN_OK, ctx).pass, false)
})

test('line endings do not change any verdict', () => {
  const text = '**Key Findings**\n- a\n- b\n- c\n'
  const args = { heading: 'Key Findings', min: 3, max: 3 }
  assert.deepStrictEqual(
    check('section_bullets', args, text),
    check('section_bullets', args, text.replace(/\n/g, '\r\n'))
  )
})

// ═════════════════════════════════════════════════════════════════
section('Reference and deliberately incomplete outputs')

test('every reference output passes all of its properties', () => {
  const { report } = generateOffline()
  for (const c of report.cases) {
    const failed = c.automated.properties.filter((p) => !p.pass)
    assert.deepStrictEqual(failed, [], `${c.id} reference output should pass`)
  }
  assert.strictEqual(report.summary.status, 'pass')
})

test('every deliberately incomplete output fails, for exactly the expected reasons', () => {
  const { report } = generateOffline()
  let total = 0
  for (const c of report.cases) {
    assert.ok(c.negativeFixtures.length >= 1, `${c.id} needs an incomplete fixture`)
    for (const n of c.negativeFixtures) {
      total += 1
      assert.ok(n.actualFailures.length >= 1, `${c.id}/${n.file} must fail at least one check`)
      assert.deepStrictEqual(
        [...n.actualFailures].sort(),
        [...n.expectedFailures].sort(),
        `${c.id}/${n.file}`
      )
      assert.strictEqual(n.rejectedAsExpected, true)
    }
  }
  assert.ok(total >= 20)
})

test('an incomplete output that stops failing is reported as an unhealthy suite', () => {
  const loaded = loadEvalSet()
  const tampered = {
    ...loaded,
    cases: loaded.cases.map((c, i) =>
      i === 0
        ? {
            ...c,
            fixtureTexts: {
              ...c.fixtureTexts,
              negative: [c.fixtureTexts.pass, c.fixtureTexts.negative[1]],
            },
          }
        : c
    ),
  }
  const report = buildReport(tampered, currentRevisions(), [])
  assert.strictEqual(report.cases[0].negativeFixtures[0].rejectedAsExpected, false)
  assert.strictEqual(report.summary.status, 'fail')
  assert.ok(renderMarkdown(report).includes('DOES NOT MATCH EXPECTATION'))
})

test('a broken reference output fails the specific property it breaks', () => {
  const loaded = loadEvalSet()
  const index = loaded.cases.findIndex((c) => c.id === 'analysis-api-rate-limits')
  const broken = loaded.cases[index].fixtureTexts.pass.replace('**Opportunities**', '**Upsides**')
  const cases = loaded.cases.map((c, i) =>
    i === index ? { ...c, fixtureTexts: { ...c.fixtureTexts, pass: broken } } : c
  )
  const report = buildReport({ ...loaded, cases }, currentRevisions(), [])
  const failed = report.cases[index].automated.properties.filter((p) => !p.pass).map((p) => p.id)
  assert.deepStrictEqual(failed, ['has_required_sections', 'opportunities_2_to_3'])
  assert.strictEqual(report.summary.status, 'fail')
})

// ═════════════════════════════════════════════════════════════════
section('Deterministic, offline reports')

test('two independent processes, from different directories, write identical reports', async () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir() }
  const outs = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'eval-out-')))
  await Promise.all(
    outs.map((out, i) =>
      execFileAsync(process.execPath, [RUN_JS, '--out', out], {
        env,
        cwd: i === 0 ? os.tmpdir() : EVALS_DIR,
      })
    )
  )
  for (const name of ['report.json', 'report.md']) {
    const first = fs.readFileSync(path.join(outs[0], name))
    assert.ok(
      first.equals(fs.readFileSync(path.join(outs[1], name))),
      `${name} differs between runs`
    )
    // A Windows checkout may hold the baseline with CRLF; the content is what must match.
    const baseline = fs.readFileSync(path.join(BASELINE_DIR, name), 'utf8').replace(/\r\n/g, '\n')
    assert.strictEqual(first.toString('utf8'), baseline, `${name} differs from the baseline`)
  }
})

test('the report does not depend on the checkout line endings', () => {
  const dir = tempCopy()
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(json|txt)$/.test(entry.name)) {
        fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(/\r?\n/g, '\r\n'))
      }
    }
  }
  walk(dir)
  const crlf = generateOffline(dir)
  const lf = generateOffline()
  assert.strictEqual(crlf.json, lf.json)
  assert.strictEqual(crlf.markdown, lf.markdown)
  assert.ok(!lf.json.includes('\r') && !lf.markdown.includes('\r'))
})

test('the report contains no timestamps or machine-specific paths', () => {
  const { json, markdown } = generateOffline()
  for (const text of [json, markdown]) {
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text), 'no ISO timestamps')
    assert.ok(!text.includes(os.homedir()) && !text.includes(EVALS_DIR), 'no absolute paths')
  }
})

test('scoring needs no network, key or wallet', () => {
  const originalConnect = net.Socket.prototype.connect
  const originalFetch = globalThis.fetch
  net.Socket.prototype.connect = () => {
    throw new Error('network access attempted')
  }
  globalThis.fetch = () => {
    throw new Error('fetch attempted')
  }
  try {
    assert.strictEqual(generateOffline().report.summary.status, 'pass')
  } finally {
    net.Socket.prototype.connect = originalConnect
    globalThis.fetch = originalFetch
  }
})

// ═════════════════════════════════════════════════════════════════
section('Baseline and revisions')

test('the committed baseline matches the current report', () => {
  assert.deepStrictEqual(compareWithBaseline(generateOffline()), [])
})

test('a missing or edited baseline is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-baseline-'))
  assert.strictEqual(compareWithBaseline(generateOffline(), dir).length, 2)
  fs.cpSync(BASELINE_DIR, dir, { recursive: true })
  assert.deepStrictEqual(compareWithBaseline(generateOffline(), dir), [])
  fs.appendFileSync(path.join(dir, 'report.md'), 'edited\n')
  assert.deepStrictEqual(compareWithBaseline(generateOffline(), dir), [
    'baseline/report.md differs from the current report',
  ])
})

test('the report names the model and prompt revision of every agent', () => {
  const { report } = generateOffline()
  assert.strictEqual(report.revisions['research-bot'].model, AGENT_MODELS.research)
  assert.strictEqual(
    report.revisions['research-bot'].promptRevision,
    promptDigest(PROMPT_TEMPLATES.research)
  )
  assert.strictEqual(report.revisions['analyst-bot'].model, AGENT_MODELS.analysisPrimary)
  assert.strictEqual(report.revisions['analyst-bot'].fallbackModel, AGENT_MODELS.analysisFallback)
  assert.strictEqual(report.revisions['orchestrator'].promptRevision, null)
  assert.ok(report.revisions['orchestrator'].note)
  const first = report.cases.find((c) => c.agent === 'code-bot')
  assert.strictEqual(first.revision.promptRevision, promptDigest(PROMPT_TEMPLATES.code))
  assert.ok(generateOffline().markdown.includes(promptDigest(PROMPT_TEMPLATES.code)))
})

test('a prompt change changes the revision and breaks the baseline until accepted', () => {
  const original = PROMPT_TEMPLATES.summary
  try {
    PROMPT_TEMPLATES.summary = `${original} Use plain words.`
    const changed = generateOffline()
    assert.notStrictEqual(
      changed.report.revisions['summary-bot'].promptRevision,
      promptDigest(original)
    )
    const problems = compareWithBaseline(changed)
    assert.deepStrictEqual(problems.sort(), [
      'baseline/report.json differs from the current report',
      'baseline/report.md differs from the current report',
    ])
  } finally {
    PROMPT_TEMPLATES.summary = original
  }
  assert.deepStrictEqual(compareWithBaseline(generateOffline()), [])
})

test('the accept workflow: update writes the baseline, check passes, an edit fails until re-accepted', async () => {
  // A throwaway project root so the real baseline is never touched.
  const repoRoot = path.resolve(EVALS_DIR, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-project-'))
  fs.cpSync(EVALS_DIR, path.join(root, 'evals'), { recursive: true })
  fs.rmSync(path.join(root, 'evals', 'baseline'), { recursive: true, force: true })
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'))
  for (const name of ['src', 'node_modules']) {
    fs.symlinkSync(path.join(repoRoot, name), path.join(root, name), 'junction')
  }
  const run = (...args) =>
    execFileAsync(process.execPath, [path.join(root, 'evals', 'run.js'), ...args], {
      env: { PATH: process.env.PATH },
    })

  await assert.rejects(
    run('--check'),
    (err) => err.code === 1 && err.stderr.includes('baseline/report.json is missing')
  )

  const updated = await run('--update')
  assert.ok(updated.stdout.includes('baseline updated'))
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'evals', 'baseline')).sort(), [
    'report.json',
    'report.md',
  ])
  assert.ok((await run('--check')).stdout.includes('baseline matches'))

  // A harmless rewording changes the content digest: it must be reviewed and accepted.
  const fixture = path.join(root, 'evals', 'fixtures', 'research-http-402', 'pass.txt')
  fs.writeFileSync(
    fixture,
    fs.readFileSync(fixture, 'utf8').replace('about 5 seconds', 'about 4 seconds')
  )
  await assert.rejects(
    run('--check'),
    (err) => err.code === 1 && err.stderr.includes('npm run eval:accept')
  )
  await run('--update')
  assert.ok((await run('--check')).stdout.includes('baseline matches'))

  // An edit that breaks a reference output is an unhealthy suite and cannot be accepted.
  fs.appendFileSync(fixture, 'It also works for subscriptions.\n')
  await assert.rejects(
    run('--update'),
    (err) => err.code === 1 && err.stderr.includes('The suite is unhealthy')
  )
})

// ═════════════════════════════════════════════════════════════════
section('Automated checks vs human judgment')

test('the report keeps machine-scored checks and human judgment in separate sections', () => {
  const { markdown, report } = generateOffline()
  const automated = markdown.indexOf('## Automated structural checks (machine-scored)')
  const human = markdown.indexOf('## Human judgment (not scored by this tool)')
  assert.ok(automated !== -1 && human > automated)
  assert.ok(markdown.includes('nothing about whether an answer is true or useful'))
  assert.strictEqual(report.summary.humanReview.notRecorded, report.summary.cases)
  assert.ok(
    report.cases.every(
      (c) => c.humanReview.status === 'not recorded' && c.humanReview.questions.length > 0
    )
  )
  // Human judgment never feeds the automated score.
  const reviewed = buildReport(loadEvalSet(), currentRevisions(), [
    {
      caseId: 'research-http-402',
      reviewer: 'a',
      reviewedAt: '2026-01-01',
      evalSetVersion: '1.0.0',
      promptRevision: currentRevisions()['research-bot'].promptRevision,
      verdict: 'needs-work',
    },
  ])
  assert.strictEqual(reviewed.summary.automated.passed, report.summary.automated.passed)
  assert.strictEqual(reviewed.summary.status, 'pass')
})

test('a review is current only for the eval set version and prompt revision it judged', () => {
  const version = { evalSetVersion: '1.0.0', promptRevision: 'sha256:aaa' }
  const review = {
    caseId: 'c',
    evalSetVersion: '1.0.0',
    promptRevision: 'sha256:aaa',
    verdict: 'accept',
  }
  assert.strictEqual(reviewStatus('c', version, []).status, 'not recorded')
  assert.strictEqual(reviewStatus('c', version, [review]).status, 'accept')
  assert.strictEqual(
    reviewStatus('c', version, [{ ...review, verdict: 'needs-work' }]).status,
    'needs-work'
  )
  assert.strictEqual(
    reviewStatus('c', { ...version, promptRevision: 'sha256:bbb' }, [review]).status,
    'stale'
  )
  assert.strictEqual(
    reviewStatus('c', { ...version, evalSetVersion: '2.0.0' }, [review]).status,
    'stale'
  )
  // The latest review of a case wins.
  assert.strictEqual(
    reviewStatus('c', version, [{ ...review, verdict: 'needs-work' }, review]).status,
    'accept'
  )
})

test('review records are validated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-reviews-'))
  const write = (reviews) =>
    fs.writeFileSync(path.join(dir, 'reviews.v1.json'), JSON.stringify({ reviews }))
  write([{ caseId: 'ghost', reviewer: '', reviewedAt: 'yesterday', verdict: 'maybe' }])
  assert.throws(
    () => loadReviews(dir, ['real']),
    /unknown caseId[\s\S]*reviewer is required[\s\S]*YYYY-MM-DD[\s\S]*verdict/
  )
  write([
    {
      caseId: 'real',
      reviewer: 'r',
      reviewedAt: '2026-01-01',
      evalSetVersion: '1.0.0',
      promptRevision: null,
      verdict: 'accept',
    },
  ])
  assert.strictEqual(loadReviews(dir, ['real']).length, 1)
  assert.deepStrictEqual(
    loadReviews(
      EVALS_DIR,
      loadEvalSet().cases.map((c) => c.id)
    ),
    []
  )
})

// ═════════════════════════════════════════════════════════════════
section('Optional live evaluation (opt-in and cost-controlled)')

function fakeRunners(log, overrides = {}) {
  const make = (agent) => async () => {
    log.push(agent)
    return {
      text: 'x',
      provenance: {
        source: 'live',
        provider: 'anthropic',
        model: 'm',
        requestedModel: 'm',
        promptRevision: 'sha256:fake',
      },
    }
  }
  return {
    'research-bot': make('research-bot'),
    'summary-bot': make('summary-bot'),
    'analyst-bot': make('analyst-bot'),
    'code-bot': make('code-bot'),
    ...overrides,
  }
}

test('live evaluation needs an explicit opt-in and a key', () => {
  assert.ok(liveBlocker({}, true).includes('EVAL_LIVE=1'))
  assert.ok(liveBlocker({ EVAL_LIVE: 'true' }, true).includes('EVAL_LIVE=1'))
  assert.ok(liveBlocker({ EVAL_LIVE: '1' }, false).includes('ANTHROPIC_API_KEY'))
  assert.strictEqual(liveBlocker({ EVAL_LIVE: '1' }, true), null)
})

test('the live CLI refuses to start without the opt-in and the offline run never calls a model', async () => {
  const saved = { flag: process.env.EVAL_LIVE, key: process.env.ANTHROPIC_API_KEY }
  delete process.env.EVAL_LIVE
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(String(message))
  try {
    assert.strictEqual(await main(['--live']), 2)
    assert.ok(errors.join('\n').includes('EVAL_LIVE=1'))
  } finally {
    console.error = originalError
    if (saved.flag !== undefined) process.env.EVAL_LIVE = saved.flag
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key
  }
})

test('limits default to a small run and can be overridden', () => {
  assert.deepStrictEqual(liveLimits({}), {
    maxCases: DEFAULT_MAX_CASES,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  })
  assert.deepStrictEqual(
    liveLimits({ EVAL_LIVE_MAX_CASES: '2', EVAL_LIVE_MAX_OUTPUT_TOKENS: '900' }),
    { maxCases: 2, maxOutputTokens: 900 }
  )
  assert.deepStrictEqual(liveLimits({ EVAL_LIVE_MAX_CASES: 'abc' }, { maxCases: '3' }).maxCases, 3)
  assert.strictEqual(liveLimits({ EVAL_LIVE_MAX_CASES: '-5' }).maxCases, DEFAULT_MAX_CASES)
})

test('live runs stop at the case limit and never run planning cases', async () => {
  const log = []
  const report = await runLive(loadEvalSet(), currentRevisions(), fakeRunners(log), {
    maxCases: 3,
    maxOutputTokens: 100000,
  })
  assert.strictEqual(log.length, 3)
  assert.strictEqual(report.summary.attempted, 3)
  const planning = report.results.filter((r) => r.agent === 'orchestrator')
  assert.ok(planning.length === 3 && planning.every((r) => r.status === 'skipped'))
  assert.ok(report.results.some((r) => r.reason?.includes('case limit reached')))
})

test('live runs reserve worst-case output tokens so the cap cannot be exceeded', async () => {
  const log = []
  // research (512) + research (512) fit in 1100; the summary (256) would reach 1280.
  const report = await runLive(loadEvalSet(), currentRevisions(), fakeRunners(log), {
    maxCases: 99,
    maxOutputTokens: 1100,
  })
  assert.deepStrictEqual(log, ['research-bot', 'research-bot'])
  assert.ok(report.limits.reservedOutputTokens <= 1100)
  assert.ok(report.results.some((r) => r.reason?.includes('output token cap would be exceeded')))
})

test('a demo or fallback answer is never scored as a live result', async () => {
  const demo = async () => ({
    text: 'canned',
    provenance: { source: 'demo', reason: 'no_api_key', model: null },
  })
  const report = await runLive(
    loadEvalSet(),
    currentRevisions(),
    fakeRunners([], { 'research-bot': demo }),
    { maxCases: 1, maxOutputTokens: 5000 },
    { caseIds: ['research-http-402'] }
  )
  assert.strictEqual(report.results[0].status, 'not-live')
  assert.strictEqual(report.results[0].automated, undefined)
  assert.strictEqual(report.summary.scored, 0)
})

test('a live result records provenance, scores it, and flags a prompt revision mismatch', async () => {
  const report = await runLive(
    loadEvalSet(),
    currentRevisions(),
    fakeRunners([]),
    { maxCases: 1, maxOutputTokens: 5000 },
    { caseIds: ['research-http-402'], now: () => new Date('2026-01-02T03:04:05Z') }
  )
  const [result] = report.results
  assert.strictEqual(result.status, 'scored')
  assert.strictEqual(result.provenance.promptRevision, 'sha256:fake')
  assert.strictEqual(result.promptRevisionMatchesCurrent, false)
  assert.ok(result.automated.failed.length > 0 && result.output === 'x')
  assert.strictEqual(result.humanReview.status, 'pending')
  assert.strictEqual(report.generatedAt, '2026-01-02T03:04:05.000Z')
  assert.ok(report.note.includes('never compared to the offline baseline'))
})

test('the first provider error stops the live run instead of retrying through the cases', async () => {
  const log = []
  const failing = async () => {
    log.push('boom')
    throw new Error('401 invalid x-api-key')
  }
  const report = await runLive(
    loadEvalSet(),
    currentRevisions(),
    fakeRunners(log, { 'research-bot': failing }),
    { maxCases: 99, maxOutputTokens: 100000 }
  )
  assert.deepStrictEqual(log, ['boom'])
  assert.strictEqual(report.summary.errors, 1)
  assert.ok(report.results.some((r) => r.reason === 'stopped after an earlier provider error'))
})

test('provider usage is accumulated from the agents', async () => {
  const withUsage = async (_task, options) => {
    options.onUsage({ inputTokens: 10, outputTokens: 20, unavailable: false })
    options.onUsage({ unavailable: true })
    return { text: 'x', provenance: { source: 'live', model: 'm' } }
  }
  const report = await runLive(
    loadEvalSet(),
    currentRevisions(),
    fakeRunners([], { 'research-bot': withUsage }),
    { maxCases: 1, maxOutputTokens: 5000 },
    { caseIds: ['research-http-402'] }
  )
  assert.deepStrictEqual(report.usage, { calls: 1, inputTokens: 10, outputTokens: 20 })
})

// ─── Runner ─────────────────────────────────────────────────────
const failures = []
let passed = 0
for (const item of queue) {
  if (item.title) {
    console.log(item.title)
    continue
  }
  try {
    await item.fn()
    passed += 1
    console.log(`  ✓ ${item.name}`)
  } catch (err) {
    failures.push({ name: item.name, err })
    console.error(`  ✗ ${item.name}\n      ${String(err.message).replace(/\n/g, '\n      ')}`)
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
// Importing the services keeps handles open in some environments; exit explicitly.
process.exit(0)
