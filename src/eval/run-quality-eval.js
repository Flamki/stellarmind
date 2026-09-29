#!/usr/bin/env node
/**
 * Offline agent-output quality runner (Issue #154)
 *
 * Usage:
 *   node src/eval/run-quality-eval.js                          # score eval/fixtures/baseline
 *   node src/eval/run-quality-eval.js --fixtures eval/fixtures/incomplete
 *   node src/eval/run-quality-eval.js --format json --out /tmp/eval
 *   node src/eval/run-quality-eval.js --check-baseline         # exit 1 on drift
 *   node src/eval/run-quality-eval.js --write-baseline         # accept a new baseline
 *
 * Offline by default: outputs are read from a fixtures directory, so the run
 * needs no keys, no wallets and no network. The optional `--live` mode is the
 * only path that spends money and refuses to run without an explicit
 * confirmation of how many cases it may bill (see docs/quality-evals.md).
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { AGENT_MODELS } from '../agents/services.js'
import { config } from '../config.js'
import { loadQualitySet, DEFAULT_QUALITY_SET_PATH } from './quality-checks.js'
import { buildQualityReport, renderQualityMarkdown, diffAgainstBaseline } from './quality-report.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const DEFAULT_FIXTURES = path.join(repoRoot, 'eval', 'fixtures', 'baseline')
const DEFAULT_BASELINE = path.join(repoRoot, 'eval', 'baseline.json')

/** Show a path relative to the working directory, or absolute when it escapes it. */
function displayPath(target) {
  const relative = path.relative(process.cwd(), target)
  return relative === '' || relative.startsWith('..') ? target : relative
}

const LIVE_RUNNERS = {
  research: 'runResearch',
  summary: 'runSummary',
  analysis: 'runAnalysis',
  code: 'runCode',
}

export function parseArgs(argv) {
  const args = {
    fixtures: DEFAULT_FIXTURES,
    setPath: DEFAULT_QUALITY_SET_PATH,
    baselinePath: DEFAULT_BASELINE,
    format: 'md',
    out: null,
    checkBaseline: false,
    writeBaseline: false,
    live: false,
    maxCases: null,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`)
      }
      i += 1
      return value
    }
    switch (arg) {
      case '--fixtures':
        args.fixtures = path.resolve(next())
        break
      case '--set':
        args.setPath = path.resolve(next())
        break
      case '--baseline':
        args.baselinePath = path.resolve(next())
        break
      case '--format':
        args.format = next()
        break
      case '--out':
        args.out = path.resolve(next())
        break
      case '--check-baseline':
        args.checkBaseline = true
        break
      case '--write-baseline':
        args.writeBaseline = true
        break
      case '--live':
        args.live = true
        break
      case '--max-cases':
        args.maxCases = Number.parseInt(next(), 10)
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }

  if (!['md', 'json', 'both'].includes(args.format)) {
    throw new Error(`--format must be md, json or both (got ${args.format})`)
  }
  if (args.maxCases !== null && (!Number.isInteger(args.maxCases) || args.maxCases < 1)) {
    throw new Error('--max-cases must be a positive integer')
  }
  return args
}

/** Read `<fixturesDir>/<caseId>.txt` (or `.md`) for every case. */
export function readFixtureOutputs(set, fixturesDir) {
  const outputs = {}
  const missing = []
  for (const caseDef of set.cases) {
    const candidates = [`${caseDef.id}.txt`, `${caseDef.id}.md`]
    const found = candidates
      .map((name) => path.join(fixturesDir, name))
      .find((candidate) => fs.existsSync(candidate))
    if (!found) {
      missing.push(caseDef.id)
      outputs[caseDef.id] = { text: '', source: null }
      continue
    }
    outputs[caseDef.id] = {
      text: fs.readFileSync(found, 'utf8'),
      source: path.relative(repoRoot, found),
    }
  }
  return { outputs, missing }
}

/** Identifier of the models a report describes, from the single model registry. */
export function currentModelRevision() {
  return Object.keys(AGENT_MODELS)
    .sort()
    .map((key) => `${key}=${AGENT_MODELS[key]}`)
    .join(',')
}

/**
 * Live mode: spend real tokens on the cases. Refuses unless the operator has
 * both a key and stated how many cases may be billed, so a CI run or a curious
 * contributor cannot bill a full set by accident.
 */
async function runLive(set, args, log = console.log) {
  const budgetConfirm = Number.parseInt(process.env.EVAL_LIVE_CONFIRM || '', 10)
  if (!config.anthropicApiKey) {
    throw new Error('--live needs ANTHROPIC_API_KEY; refusing to run without one')
  }
  if (!Number.isInteger(budgetConfirm)) {
    throw new Error(
      '--live needs EVAL_LIVE_CONFIRM=<number of cases you accept being billed for>; ' +
        'set it explicitly to acknowledge the spend'
    )
  }

  const selected = args.maxCases ? set.cases.slice(0, args.maxCases) : set.cases
  if (selected.length > budgetConfirm) {
    throw new Error(
      `refusing to run ${selected.length} live case(s) with EVAL_LIVE_CONFIRM=${budgetConfirm}`
    )
  }

  const services = await import('../agents/services.js')
  const outputs = {}
  for (const caseDef of selected) {
    const runnerName = LIVE_RUNNERS[caseDef.agent]
    if (!runnerName || typeof services[runnerName] !== 'function') {
      throw new Error(`case "${caseDef.id}": no live runner for agent "${caseDef.agent}"`)
    }
    log(`live: ${caseDef.id} via ${caseDef.agent} (${AGENT_MODELS[caseDef.agent]})`)
    const result = await services[runnerName](caseDef.task, {})
    const text =
      typeof result === 'string'
        ? result
        : (result?.content ?? result?.text ?? JSON.stringify(result))
    outputs[caseDef.id] = { text: String(text), source: `live:${AGENT_MODELS[caseDef.agent]}` }
  }
  return outputs
}

export async function runQualityEval(argv = [], { log = console.log } = {}) {
  const args = parseArgs(argv)
  const set = loadQualitySet(args.setPath)

  let outputs
  if (args.live) {
    outputs = await runLive(set, args, log)
  } else {
    const fixtureResult = readFixtureOutputs(set, args.fixtures)
    outputs = fixtureResult.outputs
    if (fixtureResult.missing.length > 0) {
      log(
        `note: no fixture output for ${fixtureResult.missing.join(', ')} — those cases fail ` +
          'every check (this is how a missing capture is made visible)'
      )
    }
  }

  const report = buildQualityReport({ set, outputs, modelRevision: currentModelRevision() })
  const markdown = renderQualityMarkdown(report)

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true })
    fs.writeFileSync(
      path.join(args.out, 'quality-report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    )
    fs.writeFileSync(path.join(args.out, 'quality-report.md'), `${markdown}\n`)
    log(`wrote ${displayPath(args.out)}/quality-report.{json,md}`)
  } else if (args.format === 'json') {
    log(JSON.stringify(report, null, 2))
  } else if (args.format === 'md' || args.format === 'both') {
    log(markdown)
    if (args.format === 'both') log(JSON.stringify(report, null, 2))
  }

  let exitCode = report.summary.allPassed ? 0 : 1

  if (args.writeBaseline) {
    fs.writeFileSync(args.baselinePath, `${JSON.stringify(report, null, 2)}\n`)
    log(`baseline written to ${displayPath(args.baselinePath)}`)
    exitCode = 0
  }

  if (args.checkBaseline) {
    const baseline = fs.existsSync(args.baselinePath)
      ? JSON.parse(fs.readFileSync(args.baselinePath, 'utf8'))
      : null
    const diff = diffAgainstBaseline(report, baseline)
    if (diff.matches) {
      log(`baseline matches ${displayPath(args.baselinePath)}`)
    } else {
      log('baseline drift:')
      for (const difference of diff.differences) log(`  - ${difference}`)
      exitCode = 1
    }
  }

  return { report, markdown, exitCode }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  runQualityEval(process.argv.slice(2))
    .then(({ exitCode }) => {
      process.exitCode = exitCode
    })
    .catch((err) => {
      console.error(`quality eval failed: ${err.message}`)
      process.exitCode = 2
    })
}
