#!/usr/bin/env node
/**
 * Agent quality evaluation CLI (issue #154).
 *
 *   node evals/run.js                  score the offline set, print a summary
 *   node evals/run.js --check          also require the committed baseline to match
 *   node evals/run.js --update         rewrite the baseline (accept an intentional change)
 *   node evals/run.js --out <dir>      write report.json and report.md there
 *   EVAL_LIVE=1 node evals/run.js --live [--cases a,b] [--max-cases N] [--max-output-tokens N]
 *
 * Exit codes: 0 ok, 1 check/suite failure, 2 usage error or live run not enabled.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVALS_DIR, EvalSetError, loadEvalSet } from './lib/load.js'
import { currentRevisions } from './lib/revisions.js'
import { loadReviews } from './lib/reviews.js'
import { buildReport, renderJson, renderMarkdown } from './lib/report.js'
import { defaultRunners, liveBlocker, liveLimits, renderLiveMarkdown, runLive } from './lib/live.js'

export const BASELINE_DIR = path.join(EVALS_DIR, 'baseline')
export const BASELINE_FILES = { json: 'report.json', md: 'report.md' }

/** Offline report for the checked-in set: `{ report, json, markdown }`. */
export function generateOffline(dir = EVALS_DIR) {
  const loaded = loadEvalSet(dir)
  const reviews = loadReviews(
    dir,
    loaded.cases.map((c) => c.id)
  )
  const report = buildReport(loaded, currentRevisions(), reviews)
  return { report, json: renderJson(report), markdown: renderMarkdown(report) }
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n') : null
}

/** Compare generated reports with the committed baseline. Returns a list of problems. */
export function compareWithBaseline(generated, baselineDir = BASELINE_DIR) {
  const problems = []
  for (const [kind, name] of Object.entries(BASELINE_FILES)) {
    const expected = readIfExists(path.join(baselineDir, name))
    const actual = kind === 'json' ? generated.json : generated.markdown
    if (expected === null) problems.push(`baseline/${name} is missing`)
    else if (expected !== actual) problems.push(`baseline/${name} differs from the current report`)
  }
  return problems
}

function writeReports(dir, generated) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, BASELINE_FILES.json), generated.json)
  fs.writeFileSync(path.join(dir, BASELINE_FILES.md), generated.markdown)
}

function parseArgs(argv) {
  const args = { _: [] }
  const valueFlags = new Set(['--out', '--cases', '--max-cases', '--max-output-tokens'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (valueFlags.has(arg)) {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`)
      args[arg.slice(2)] = argv[++i]
    } else if (arg.startsWith('--')) {
      args[arg.slice(2)] = true
    } else {
      args._.push(arg)
    }
  }
  return args
}

function printSummary(report) {
  const { summary } = report
  console.log(`${report.evalSet.name} ${report.evalSet.version} (${report.evalSet.digest})`)
  console.log(
    `  automated: ${summary.automated.passed}/${summary.automated.properties} properties pass on reference outputs`
  )
  console.log(
    `  incomplete outputs rejected as expected: ${summary.negativeFixtures.rejectedAsExpected}/${summary.negativeFixtures.total}`
  )
  console.log(
    `  human judgment: ${summary.humanReview.accepted} accepted, ${summary.humanReview.needsWork} needs work, ${summary.humanReview.stale} stale, ${summary.humanReview.notRecorded} not recorded (not scored here)`
  )
  console.log(`  suite status: ${summary.status}`)
}

async function liveMain(args) {
  const { config } = await import('../src/config.js')
  const blocker = liveBlocker(process.env, Boolean(config.anthropicApiKey))
  if (blocker) {
    console.error(blocker)
    return 2
  }
  const loaded = loadEvalSet()
  const limits = liveLimits(process.env, {
    maxCases: args['max-cases'],
    maxOutputTokens: args['max-output-tokens'],
  })
  const caseIds = typeof args.cases === 'string' ? args.cases.split(',').filter(Boolean) : []
  const report = await runLive(loaded, currentRevisions(), await defaultRunners(), limits, {
    caseIds,
  })

  const outDir = path.resolve(
    typeof args.out === 'string' ? args.out : path.join(EVALS_DIR, 'reports')
  )
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'live-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(outDir, 'live-report.md'), renderLiveMarkdown(report))
  const s = report.summary
  console.log(
    `live: ${s.scored} scored, ${s.notLive} not live, ${s.skipped} skipped, ${s.errors} errors; ` +
      `${report.usage.outputTokens} output tokens used. Reports written to ${outDir}`
  )
  return s.errors > 0 ? 1 : 0
}

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(err.message)
    return 2
  }
  if (args.live) return liveMain(args)

  let generated
  try {
    generated = generateOffline()
  } catch (err) {
    if (err instanceof EvalSetError) {
      console.error(err.message)
      return 1
    }
    throw err
  }
  printSummary(generated.report)

  if (typeof args.out === 'string') writeReports(path.resolve(args.out), generated)
  if (generated.report.summary.status !== 'pass') {
    console.error(
      'The suite is unhealthy: a reference output failed or an incomplete output was not rejected as expected.'
    )
    return 1
  }
  if (args.update) {
    writeReports(BASELINE_DIR, generated)
    console.log(`baseline updated in ${path.relative(process.cwd(), BASELINE_DIR) || BASELINE_DIR}`)
    return 0
  }
  if (args.check) {
    const problems = compareWithBaseline(generated)
    if (problems.length > 0) {
      for (const problem of problems) console.error(`  - ${problem}`)
      console.error(
        'Review the change, then run "npm run eval:accept" and commit the new baseline.'
      )
      return 1
    }
    console.log('baseline matches')
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
