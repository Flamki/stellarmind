/**
 * Reviewable quality report (Issue #154)
 *
 * Turns a set + captured outputs into a report that a reviewer can diff:
 * which cases ran, which structural properties passed, what the bound revision
 * of the prompts and models was, and what is explicitly left to human
 * judgement.
 *
 * The report is deterministic by construction — no timestamps, no clock, no
 * environment reads, stable key order — so running the offline suite twice
 * produces byte-identical output and a changed report always means a changed
 * result rather than a changed run.
 */

import { evaluateCase, revisionsOf } from './quality-checks.js'

export const QUALITY_REPORT_SCHEMA_VERSION = 1

const HUMAN_JUDGMENT_NOTE =
  'Automated checks below decide only structure and stated constraints. ' +
  'Usefulness, correctness and tone are not scored here and stay a human decision.'

/**
 * @param {object} params
 * @param {object} params.set               loaded quality set
 * @param {Record<string, {text: string, source?: string}>} params.outputs per-case outputs
 * @param {string|null} [params.modelRevision] identifier of the models the outputs came from
 */
export function buildQualityReport({ set, outputs, modelRevision = null }) {
  const { setRevision, promptRevisions } = revisionsOf(set)

  const cases = set.cases.map((caseDef) => {
    const output = outputs[caseDef.id] || { text: '', source: null }
    const checks = evaluateCase(caseDef, output.text)
    const passed = checks.filter((check) => check.passed).length
    const failed = checks.length - passed

    return {
      id: caseDef.id,
      agent: caseDef.agent,
      phase: caseDef.phase,
      task: caseDef.task,
      promptRevision: promptRevisions[caseDef.id],
      outputSource: output.source || null,
      outputPresent: output.text.trim() !== '',
      automated: { checks: checks.length, passed, failed, allPassed: failed === 0 },
      checks,
      humanJudgment: {
        required: (caseDef.humanReview || []).length > 0,
        questions: [...(caseDef.humanReview || [])],
      },
    }
  })

  const properties = cases.reduce((total, entry) => total + entry.automated.checks, 0)
  const passed = cases.reduce((total, entry) => total + entry.automated.passed, 0)

  return {
    schemaVersion: QUALITY_REPORT_SCHEMA_VERSION,
    offline: true,
    setSchemaVersion: set.schemaVersion,
    setRevision,
    modelRevision,
    promptRevisions,
    summary: {
      cases: cases.length,
      casesPassed: cases.filter((entry) => entry.automated.allPassed).length,
      properties,
      passed,
      failed: properties - passed,
      allPassed: properties === passed,
    },
    humanJudgment: {
      note: HUMAN_JUDGMENT_NOTE,
      cases: cases.filter((entry) => entry.humanJudgment.required).map((entry) => entry.id),
    },
    cases,
  }
}

function statusMark(passed) {
  return passed ? 'pass' : 'FAIL'
}

export function renderQualityMarkdown(report) {
  const lines = []
  const { summary } = report

  lines.push('# Agent output quality report (offline)')
  lines.push('')
  lines.push(
    `Set revision \`${report.setRevision}\` · schema v${report.setSchemaVersion} · ` +
      `model revision: ${report.modelRevision || 'not bound (offline fixtures)'}`
  )
  lines.push('')
  lines.push(
    `${summary.passed}/${summary.properties} automated checks passed across ` +
      `${summary.cases} case(s); ${summary.casesPassed} case(s) fully clean.`
  )
  lines.push('')
  lines.push(`> ${report.humanJudgment.note}`)
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push('| Case | Agent | Checks | Result |')
  lines.push('| --- | --- | --- | --- |')
  for (const entry of report.cases) {
    lines.push(
      `| \`${entry.id}\` | ${entry.agent} | ${entry.automated.passed}/${entry.automated.checks} | ` +
        `${statusMark(entry.automated.allPassed)} |`
    )
  }
  lines.push('')

  lines.push('## Cases')
  for (const entry of report.cases) {
    lines.push('')
    lines.push(`### \`${entry.id}\` — ${entry.agent} (${entry.phase})`)
    lines.push('')
    lines.push(`- prompt revision: \`${entry.promptRevision}\``)
    if (entry.outputSource) lines.push(`- output: \`${entry.outputSource}\``)
    if (!entry.outputPresent) lines.push('- output: **empty** — every check fails by definition')
    lines.push('')
    lines.push('| Property | Kind | Result | Observation |')
    lines.push('| --- | --- | --- | --- |')
    for (const check of entry.checks) {
      lines.push(
        `| \`${check.id}\` | ${check.kind} | ${statusMark(check.passed)} | ${check.reason} |`
      )
    }
    if (entry.humanJudgment.required) {
      lines.push('')
      lines.push('Left to human judgement:')
      for (const question of entry.humanJudgment.questions) {
        lines.push(`- ${question}`)
      }
    }
  }
  lines.push('')

  return `${lines.join('\n')}`
}

/**
 * Compare a fresh report with a committed baseline. Only the fields a quality
 * change would move are compared, so reordering YAML/JSON keys or adding a new
 * case is visible without the run metadata causing noise.
 */
export function diffAgainstBaseline(report, baseline) {
  const differences = []
  if (!baseline) {
    return { matches: false, differences: ['no baseline to compare against'] }
  }
  if (baseline.setRevision !== report.setRevision) {
    differences.push(`set revision changed: ${baseline.setRevision} -> ${report.setRevision}`)
  }
  if ((baseline.modelRevision || null) !== (report.modelRevision || null)) {
    differences.push(
      `model revision changed: ${baseline.modelRevision || 'none'} -> ${report.modelRevision || 'none'}`
    )
  }
  const baselineCases = new Map((baseline.cases || []).map((entry) => [entry.id, entry]))
  for (const entry of report.cases) {
    const previous = baselineCases.get(entry.id)
    if (!previous) {
      differences.push(`case added: ${entry.id}`)
      continue
    }
    const previousChecks = new Map((previous.checks || []).map((check) => [check.id, check]))
    for (const check of entry.checks) {
      const before = previousChecks.get(check.id)
      if (!before) {
        differences.push(`property added: ${entry.id}/${check.id}`)
      } else if (before.passed !== check.passed) {
        differences.push(
          `result changed: ${entry.id}/${check.id} ${before.passed ? 'pass' : 'FAIL'} -> ` +
            `${check.passed ? 'pass' : 'FAIL'}`
        )
      }
    }
  }
  for (const previous of baseline.cases || []) {
    if (!report.cases.some((entry) => entry.id === previous.id)) {
      differences.push(`case removed: ${previous.id}`)
    }
  }
  return { matches: differences.length === 0, differences }
}
