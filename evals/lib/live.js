/**
 * Optional live evaluation (issue #154). Never part of `npm test`.
 *
 * Live runs call the real agents once per case and score the output with the
 * same structural properties as the offline suite. They are opt-in and
 * cost-controlled:
 *   - they need EVAL_LIVE=1 and a configured Anthropic key;
 *   - at most `maxCases` cases run (default 4);
 *   - before each call the worst-case output tokens for that agent are
 *     reserved against `maxOutputTokens` (default 2400), so the cap cannot be
 *     exceeded even if every answer runs to its limit;
 *   - the first provider error stops the run instead of retrying through the
 *     remaining cases.
 * A demo/fallback answer is never scored as a live result.
 */
import { scoreText } from './report.js'

export const DEFAULT_MAX_CASES = 4
export const DEFAULT_MAX_OUTPUT_TOKENS = 2400

/** Mirrors the `max_tokens` each agent passes in services.js. */
export const WORST_CASE_OUTPUT_TOKENS = Object.freeze({
  'research-bot': 512,
  'summary-bot': 256,
  'analyst-bot': 800,
  'code-bot': 600,
})

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** @returns {{ maxCases: number, maxOutputTokens: number }} */
export function liveLimits(env = process.env, overrides = {}) {
  return {
    maxCases: positiveInt(overrides.maxCases ?? env.EVAL_LIVE_MAX_CASES, DEFAULT_MAX_CASES),
    maxOutputTokens: positiveInt(
      overrides.maxOutputTokens ?? env.EVAL_LIVE_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS
    ),
  }
}

/** Why live evaluation may not start, or null when it may. */
export function liveBlocker(env, hasApiKey) {
  if (env.EVAL_LIVE !== '1') {
    return 'Live evaluation is opt-in: set EVAL_LIVE=1 (it makes paid model calls).'
  }
  if (!hasApiKey) return 'Live evaluation needs ANTHROPIC_API_KEY.'
  return null
}

/** Runners that call the real agent functions; loaded lazily so offline runs never touch them. */
export async function defaultRunners() {
  const services = await import('../../src/agents/services.js')
  return {
    'research-bot': services.runResearch,
    'summary-bot': services.runSummary,
    'analyst-bot': services.runAnalysis,
    'code-bot': services.runCode,
  }
}

function pickProvenance(provenance = {}) {
  const { source, provider, model, requestedModel, promptRevision, promptDigest, modelFallback } =
    provenance
  return {
    source: source ?? null,
    provider: provider ?? null,
    model: model ?? null,
    requestedModel: requestedModel ?? null,
    promptRevision: promptRevision ?? null,
    promptDigest: promptDigest ?? null,
    modelFallback: modelFallback ?? null,
  }
}

/**
 * @param {{ set: object, cases: object[], digest: string }} loaded
 * @param {object} revisions from currentRevisions()
 * @param {Record<string, Function>} runners agentId -> (task, options) => { text, provenance }
 * @param {{ maxCases: number, maxOutputTokens: number }} limits
 * @param {{ caseIds?: string[], now?: () => Date }} [options]
 */
export async function runLive(loaded, revisions, runners, limits, options = {}) {
  const now = options.now || (() => new Date())
  const wanted = options.caseIds?.length ? new Set(options.caseIds) : null
  const results = []
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 }
  let reserved = 0
  let ran = 0
  let aborted = false

  for (const testCase of loaded.cases) {
    if (wanted && !wanted.has(testCase.id)) continue
    const base = { caseId: testCase.id, agent: testCase.agent }
    const humanReview = { status: 'pending', questions: testCase.humanReview }
    const skip = (reason) => results.push({ ...base, status: 'skipped', reason, humanReview })

    if (testCase.phase === 'plan') {
      skip('the planner cannot be run on its own; planning cases are offline-only')
      continue
    }
    if (aborted) {
      skip('stopped after an earlier provider error')
      continue
    }
    if (ran >= limits.maxCases) {
      skip(`case limit reached (${limits.maxCases})`)
      continue
    }
    const worst = WORST_CASE_OUTPUT_TOKENS[testCase.agent] ?? Infinity
    if (reserved + worst > limits.maxOutputTokens) {
      skip(`output token cap would be exceeded (${limits.maxOutputTokens})`)
      continue
    }
    const run = runners[testCase.agent]
    if (typeof run !== 'function') {
      skip(`no runner for ${testCase.agent}`)
      continue
    }

    reserved += worst
    ran += 1
    try {
      const outcome = await run(testCase.task, {
        onUsage: (entry) => {
          if (!entry || entry.unavailable) return
          usage.calls += 1
          usage.inputTokens += entry.inputTokens || 0
          usage.outputTokens += entry.outputTokens || 0
        },
      })
      const provenance = pickProvenance(outcome?.provenance)
      if (provenance.source !== 'live') {
        results.push({
          ...base,
          status: 'not-live',
          reason: 'the agent returned a demo or fallback answer, which is never scored as live',
          provenance,
          humanReview,
        })
        continue
      }
      const scored = scoreText(testCase, outcome.text)
      results.push({
        ...base,
        status: 'scored',
        reason: null,
        provenance,
        promptRevisionMatchesCurrent:
          provenance.promptRevision === revisions[testCase.agent].promptRevision,
        automated: {
          passed: scored.passed,
          total: scored.total,
          failed: scored.properties
            .filter((p) => !p.pass)
            .map((p) => ({ id: p.id, detail: p.detail })),
        },
        output: outcome.text,
        humanReview,
      })
    } catch (err) {
      aborted = true
      results.push({
        ...base,
        status: 'error',
        reason: String(err?.message || err).slice(0, 160),
        humanReview,
      })
    }
  }

  const scoredResults = results.filter((r) => r.status === 'scored')
  return {
    reportVersion: 1,
    mode: 'live',
    generatedAt: now().toISOString(),
    note: 'One live sample per case. Not deterministic and never compared to the offline baseline.',
    evalSet: { name: loaded.set.evalSet, version: loaded.set.version, digest: loaded.digest },
    limits: { ...limits, reservedOutputTokens: reserved },
    usage,
    summary: {
      attempted: ran,
      scored: scoredResults.length,
      allPropertiesPassed: scoredResults.filter((r) => r.automated.passed === r.automated.total)
        .length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      notLive: results.filter((r) => r.status === 'not-live').length,
      errors: results.filter((r) => r.status === 'error').length,
    },
    results,
  }
}

export function renderLiveMarkdown(report) {
  const lines = [
    '# Live agent evaluation (not deterministic)',
    '',
    `Generated at ${report.generatedAt}. ${report.note}`,
    '',
    `- Eval set: ${report.evalSet.name} ${report.evalSet.version} (\`${report.evalSet.digest}\`)`,
    `- Limits: ${report.limits.maxCases} cases, ${report.limits.maxOutputTokens} output tokens (reserved ${report.limits.reservedOutputTokens})`,
    `- Provider usage: ${report.usage.calls} calls, ${report.usage.inputTokens} input and ${report.usage.outputTokens} output tokens`,
    '',
    '## Automated structural checks (machine-scored)',
    '',
  ]
  for (const r of report.results) {
    if (r.status === 'scored') {
      lines.push(
        `- ${r.caseId}: ${r.automated.passed}/${r.automated.total} properties pass` +
          ` (model \`${r.provenance.model}\`, prompt revision \`${r.provenance.promptRevision}\`` +
          `${r.promptRevisionMatchesCurrent ? '' : ', differs from current code'})`
      )
      for (const failure of r.automated.failed)
        lines.push(`  - fails ${failure.id}: ${failure.detail}`)
    } else {
      lines.push(`- ${r.caseId}: ${r.status} - ${r.reason}`)
    }
  }
  lines.push(
    '',
    '## Human judgment (not scored by this tool)',
    '',
    'Read each `output` in the JSON report and answer the questions below; record decisions in',
    '`evals/reviews.v1.json`.',
    ''
  )
  for (const r of report.results.filter((x) => x.status === 'scored')) {
    lines.push(`- ${r.caseId}`)
    for (const question of r.humanReview.questions) lines.push(`  - [ ] ${question}`)
  }
  return `${lines.join('\n')}\n`
}
