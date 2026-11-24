/**
 * Loads and validates the versioned evaluation set (issue #154).
 *
 * Validation is strict on purpose: a case that does not name a task, an agent
 * or phase, and concrete success properties is rejected, so the set cannot
 * drift into vague entries. All problems are reported together.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS } from '../../src/agents/registry.js'
import { CHECK_TYPES, normalizeText } from './checks.js'

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLANNER_ID = 'orchestrator'

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PROPERTY_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

export class EvalSetError extends Error {
  constructor(problems) {
    super(`Invalid evaluation set:\n  - ${problems.join('\n  - ')}`)
    this.name = 'EvalSetError'
    this.problems = problems
  }
}

/** Locale-independent ordering so digests and reports never depend on the machine. */
function byCode(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function readNormalized(file) {
  return normalizeText(fs.readFileSync(file, 'utf8'))
}

function listFixtureFiles(fixturesDir, caseId) {
  const dir = path.join(fixturesDir, caseId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort()
}

function validate(set, fixturesDir) {
  const problems = []
  const agentIds = new Set(AGENTS.map((agent) => agent.id))

  if (typeof set.evalSet !== 'string' || !set.evalSet) problems.push('"evalSet" name is required')
  if (!VERSION_PATTERN.test(set.version || '')) problems.push('"version" must look like 1.0.0')
  if (!Array.isArray(set.cases) || set.cases.length === 0) {
    problems.push('"cases" must be a non-empty array')
    return problems
  }

  const seen = new Set()
  for (const [index, testCase] of set.cases.entries()) {
    const where = `case #${index + 1} (${testCase?.id ?? 'no id'})`
    if (!ID_PATTERN.test(testCase?.id || '')) problems.push(`${where}: id must be kebab-case`)
    if (seen.has(testCase.id)) problems.push(`${where}: duplicate id`)
    seen.add(testCase.id)

    const isPlanner = testCase.agent === PLANNER_ID
    if (!isPlanner && !agentIds.has(testCase.agent)) {
      problems.push(`${where}: agent "${testCase.agent}" is not in the registry or "${PLANNER_ID}"`)
    }
    const expectedPhase = isPlanner ? 'plan' : 'execute'
    if (testCase.phase !== expectedPhase) {
      problems.push(`${where}: phase must be "${expectedPhase}" for agent "${testCase.agent}"`)
    }
    if (typeof testCase.task !== 'string' || testCase.task.trim() === '') {
      problems.push(`${where}: task is required`)
    }
    if (isPlanner) {
      const budget = testCase.context?.budget
      if (typeof budget !== 'number' || !(budget > 0)) {
        problems.push(`${where}: plan cases need context.budget > 0`)
      }
    }

    const properties = testCase.properties
    const propertyIds = new Set()
    if (!Array.isArray(properties) || properties.length === 0) {
      problems.push(`${where}: at least one success property is required`)
    } else {
      for (const property of properties) {
        const label = `${where} property "${property?.id}"`
        if (!PROPERTY_ID_PATTERN.test(property?.id || ''))
          problems.push(`${label}: id must be snake_case`)
        if (propertyIds.has(property.id)) problems.push(`${label}: duplicate property id`)
        propertyIds.add(property.id)
        if (typeof property.description !== 'string' || property.description.trim() === '') {
          problems.push(`${label}: description is required`)
        }
        if (!CHECK_TYPES.includes(property.check)) {
          problems.push(`${label}: unknown check "${property.check}"`)
        }
      }
    }

    if (
      !Array.isArray(testCase.humanReview) ||
      testCase.humanReview.length === 0 ||
      testCase.humanReview.some((q) => typeof q !== 'string' || q.trim() === '')
    ) {
      problems.push(`${where}: humanReview needs at least one question`)
    }

    const referenced = new Set()
    const fixtures = testCase.fixtures || {}
    const requireFile = (file, label) => {
      referenced.add(file)
      if (typeof file !== 'string' || !fs.existsSync(path.join(fixturesDir, testCase.id, file))) {
        problems.push(`${where}: ${label} fixture "${file}" does not exist`)
      }
    }
    requireFile(fixtures.pass, 'pass')
    if (!Array.isArray(fixtures.negative) || fixtures.negative.length === 0) {
      problems.push(`${where}: at least one negative (incomplete) fixture is required`)
    } else {
      for (const negative of fixtures.negative) {
        requireFile(negative.file, 'negative')
        if (typeof negative.note !== 'string' || negative.note.trim() === '') {
          problems.push(`${where}: negative fixture "${negative.file}" needs a note`)
        }
        if (!Array.isArray(negative.expectFail) || negative.expectFail.length === 0) {
          problems.push(`${where}: negative fixture "${negative.file}" needs expectFail`)
        } else {
          for (const id of negative.expectFail) {
            if (!propertyIds.has(id)) {
              problems.push(`${where}: expectFail "${id}" is not a property of this case`)
            }
          }
        }
      }
    }
    for (const file of listFixtureFiles(fixturesDir, testCase.id)) {
      if (!referenced.has(file)) problems.push(`${where}: fixture file "${file}" is not referenced`)
    }
  }

  const known = new Set(set.cases.map((c) => c.id))
  const fixtureDirs = fs.existsSync(fixturesDir) ? fs.readdirSync(fixturesDir).sort() : []
  for (const dir of fixtureDirs) {
    if (!known.has(dir)) problems.push(`fixtures/${dir} does not belong to any case`)
  }
  return problems
}

/** Digest of the case file plus every fixture, independent of line endings. */
function contentDigest(casesText, set, fixturesDir) {
  const hash = crypto.createHash('sha256')
  hash.update('cases\0').update(casesText)
  for (const testCase of [...set.cases].sort(byCode)) {
    for (const file of listFixtureFiles(fixturesDir, testCase.id)) {
      hash
        .update(`\0${testCase.id}/${file}\0`)
        .update(readNormalized(path.join(fixturesDir, testCase.id, file)))
    }
  }
  return `sha256:${hash.digest('hex').slice(0, 16)}`
}

/**
 * @param {string} [dir] evals directory (overridable for tests)
 * @returns {{ set: object, cases: object[], digest: string }}
 */
export function loadEvalSet(dir = EVALS_DIR) {
  const casesText = readNormalized(path.join(dir, 'cases.v1.json'))
  const set = JSON.parse(casesText)
  const fixturesDir = path.join(dir, 'fixtures')

  const problems = validate(set, fixturesDir)
  if (problems.length > 0) throw new EvalSetError(problems)

  const cases = set.cases.map((testCase) => ({
    ...testCase,
    fixtureTexts: {
      pass: readNormalized(path.join(fixturesDir, testCase.id, testCase.fixtures.pass)),
      negative: testCase.fixtures.negative.map((negative) =>
        readNormalized(path.join(fixturesDir, testCase.id, negative.file))
      ),
    },
  }))
  return { set, cases, digest: contentDigest(casesText, set, fixturesDir) }
}
