/**
 * Offline agent-output quality checks (Issue #154)
 *
 * Loads the versioned quality set in `eval/quality-set.json` and evaluates a
 * captured output against each case's structural success properties.
 *
 * Everything here is deliberately offline and deterministic: no keys, no
 * wallets, no network, no clock. The checks judge *structure and constraints* —
 * the part a machine can decide the same way twice. Judgement about usefulness
 * stays a human question and is carried in the report, not silently scored.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const QUALITY_SET_SCHEMA_VERSION = 1

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
export const DEFAULT_QUALITY_SET_PATH = path.join(repoRoot, 'eval', 'quality-set.json')

/** Check kinds the runner understands; anything else is a set authoring error. */
export const CHECK_KINDS = new Set([
  'section-headings',
  'contains-all',
  'contains-any',
  'excludes-all',
  'regex-all',
  'regex-any',
  'word-count',
  'bullet-count',
  'bullet-word-count',
  'json-shape',
  'code-fence-count',
  'code-fence-max-lines',
])

export class QualitySetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QualitySetError'
    this.code = 'INVALID_QUALITY_SET'
  }
}

/** Stable stringify: object keys sorted, so revisions and reports are stable. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

export function hashValue(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Revision of the set as a whole and of each case. A prompt edit, a new
 * property or a changed term moves these hashes, which is how a report can be
 * tied to the exact revision it describes.
 */
export function revisionsOf(set) {
  const perCase = {}
  for (const caseDef of set.cases) {
    perCase[caseDef.id] = hashValue({
      task: caseDef.task,
      agent: caseDef.agent,
      phase: caseDef.phase,
      successProperties: caseDef.successProperties,
    })
  }
  return { setRevision: hashValue(set.cases), promptRevisions: perCase }
}

function assertString(value, label, caseId) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QualitySetError(`case "${caseId}": ${label} must be a non-empty string`)
  }
}

function assertTermList(property, caseId) {
  if (!Array.isArray(property.terms) || property.terms.length === 0) {
    throw new QualitySetError(
      `case "${caseId}" property "${property.id}": ${property.kind} needs a non-empty "terms" array`
    )
  }
  for (const term of property.terms) {
    if (typeof term !== 'string' || term === '') {
      throw new QualitySetError(
        `case "${caseId}" property "${property.id}": every term must be a non-empty string`
      )
    }
  }
}

function assertPatternList(property, caseId) {
  if (!Array.isArray(property.patterns) || property.patterns.length === 0) {
    throw new QualitySetError(
      `case "${caseId}" property "${property.id}": ${property.kind} needs a non-empty "patterns" array`
    )
  }
  for (const pattern of property.patterns) {
    try {
      new RegExp(pattern)
    } catch {
      throw new QualitySetError(
        `case "${caseId}" property "${property.id}": "${pattern}" is not a valid regular expression`
      )
    }
  }
}

function validateProperty(property, caseId) {
  if (!property || typeof property !== 'object') {
    throw new QualitySetError(`case "${caseId}": every success property must be an object`)
  }
  assertString(property.id, 'property id', caseId)
  if (!CHECK_KINDS.has(property.kind)) {
    throw new QualitySetError(
      `case "${caseId}" property "${property.id}": unknown check kind "${property.kind}"`
    )
  }
  assertString(property.description, `property "${property.id}" description`, caseId)

  switch (property.kind) {
    case 'section-headings':
      if (!Array.isArray(property.headings) || property.headings.length === 0) {
        throw new QualitySetError(
          `case "${caseId}" property "${property.id}": section-headings needs "headings"`
        )
      }
      break
    case 'contains-all':
    case 'contains-any':
    case 'excludes-all':
      assertTermList(property, caseId)
      break
    case 'regex-all':
    case 'regex-any':
      assertPatternList(property, caseId)
      break
    case 'word-count':
      if (!Number.isFinite(property.min) && !Number.isFinite(property.max)) {
        throw new QualitySetError(
          `case "${caseId}" property "${property.id}": word-count needs "min" and/or "max"`
        )
      }
      break
    case 'bullet-count':
    case 'code-fence-count':
      if (!Number.isInteger(property.count) || property.count < 0) {
        throw new QualitySetError(
          `case "${caseId}" property "${property.id}": ${property.kind} needs an integer "count"`
        )
      }
      break
    case 'bullet-word-count':
    case 'code-fence-max-lines':
      if (!Number.isInteger(property.max) || property.max <= 0) {
        throw new QualitySetError(
          `case "${caseId}" property "${property.id}": ${property.kind} needs a positive "max"`
        )
      }
      break
    case 'json-shape':
      if (!Array.isArray(property.required) || property.required.length === 0) {
        throw new QualitySetError(
          `case "${caseId}" property "${property.id}": json-shape needs "required" keys`
        )
      }
      break
    default:
      break
  }

  if (property.kind === 'contains-any' && property.min !== undefined) {
    if (!Number.isInteger(property.min) || property.min < 1) {
      throw new QualitySetError(
        `case "${caseId}" property "${property.id}": "min" must be a positive integer`
      )
    }
  }
}

/**
 * Validate a parsed set. Returns it unchanged when valid; throws with a message
 * naming the case and property otherwise. Called on load so a malformed set can
 * never be scored as "everything failed".
 */
export function validateQualitySet(set) {
  if (!set || typeof set !== 'object') throw new QualitySetError('quality set must be an object')
  if (set.schemaVersion !== QUALITY_SET_SCHEMA_VERSION) {
    throw new QualitySetError(
      `unsupported schemaVersion ${set.schemaVersion} (expected ${QUALITY_SET_SCHEMA_VERSION})`
    )
  }
  if (!Array.isArray(set.cases) || set.cases.length === 0) {
    throw new QualitySetError('quality set must contain at least one case')
  }

  const seen = new Set()
  for (const caseDef of set.cases) {
    assertString(caseDef.id, 'id', '<unknown>')
    if (seen.has(caseDef.id)) throw new QualitySetError(`duplicate case id "${caseDef.id}"`)
    seen.add(caseDef.id)
    assertString(caseDef.agent, 'agent', caseDef.id)
    assertString(caseDef.phase, 'phase', caseDef.id)
    assertString(caseDef.task, 'task', caseDef.id)
    if (!Array.isArray(caseDef.successProperties) || caseDef.successProperties.length === 0) {
      throw new QualitySetError(`case "${caseDef.id}": needs at least one success property`)
    }
    const propertyIds = new Set()
    for (const property of caseDef.successProperties) {
      validateProperty(property, caseDef.id)
      if (propertyIds.has(property.id)) {
        throw new QualitySetError(`case "${caseDef.id}": duplicate property id "${property.id}"`)
      }
      propertyIds.add(property.id)
    }
    if (caseDef.humanReview !== undefined) {
      if (!Array.isArray(caseDef.humanReview) || caseDef.humanReview.length === 0) {
        throw new QualitySetError(
          `case "${caseDef.id}": "humanReview" must be a non-empty list of questions when present`
        )
      }
      for (const question of caseDef.humanReview) {
        assertString(question, 'humanReview question', caseDef.id)
      }
    }
  }
  return set
}

export function loadQualitySet(setPath = DEFAULT_QUALITY_SET_PATH) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(setPath, 'utf8'))
  } catch (err) {
    throw new QualitySetError(`cannot read quality set at ${setPath}: ${err.message}`)
  }
  return validateQualitySet(parsed)
}

// ─── Text helpers (deterministic, no natural-language guesswork) ─────────────

export function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function bullets(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^([-*•]|\d+[.)])\s+\S/.test(line))
}

export function codeFences(text) {
  const fences = []
  const lines = text.split('\n')
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      if (open) {
        fences.push({ startLine: open.startLine, endLine: i, body: lines.slice(open.at + 1, i) })
        open = null
      } else {
        open = { startLine: i, at: i }
      }
    }
  }
  return fences
}

export function headings(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\*\*|\*\*:?$/g, '')
        .trim()
    )
}

function caseInsensitiveIncludes(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

// ─── Checks ─────────────────────────────────────────────────────────────────

/**
 * Evaluate one property against one output. Returns
 * `{ id, kind, passed, expected, actual, reason }` — the shape the report keeps,
 * including for passes, so a reviewer can see what "pass" meant.
 */
export function checkProperty(property, output) {
  const text = typeof output === 'string' ? output : ''
  const result = {
    id: property.id,
    kind: property.kind,
    description: property.description,
    passed: false,
    expected: null,
    actual: null,
    reason: '',
  }

  // An empty capture must never pass an exclusion ("no banned terms found" in an
  // empty document would be a false pass), so it fails every property outright.
  if (text.trim() === '') {
    result.reason = 'output is empty — nothing to check'
    return result
  }

  switch (property.kind) {
    case 'section-headings': {
      const present = headings(text)
      const missing = property.headings.filter(
        (heading) => !present.some((h) => h.toLowerCase() === heading.toLowerCase())
      )
      result.expected = property.headings
      result.actual = present
      result.passed = missing.length === 0
      result.reason = result.passed
        ? 'all requested sections present'
        : `missing section(s): ${missing.join(', ')}`
      break
    }
    case 'contains-all': {
      const missing = property.terms.filter((term) => !caseInsensitiveIncludes(text, term))
      result.expected = property.terms
      result.actual = property.terms.filter((term) => caseInsensitiveIncludes(text, term))
      result.passed = missing.length === 0
      result.reason = result.passed
        ? 'all required terms present'
        : `missing: ${missing.join(', ')}`
      break
    }
    case 'contains-any': {
      const found = property.terms.filter((term) => caseInsensitiveIncludes(text, term))
      const min = property.min ?? 1
      result.expected = { terms: property.terms, min }
      result.actual = found
      result.passed = found.length >= min
      result.reason = result.passed
        ? `${found.length} of the expected terms present (needed ${min})`
        : `only ${found.length} of the expected terms present (needed ${min})`
      break
    }
    case 'excludes-all': {
      const found = property.terms.filter((term) => caseInsensitiveIncludes(text, term))
      result.expected = { terms: property.terms, none: true }
      result.actual = found
      result.passed = found.length === 0
      result.reason = result.passed
        ? 'no disallowed terms present'
        : `contains disallowed: ${found.join(', ')}`
      break
    }
    case 'regex-all': {
      const missing = property.patterns.filter((pattern) => !new RegExp(pattern).test(text))
      result.expected = property.patterns
      result.actual = property.patterns.filter((pattern) => new RegExp(pattern).test(text))
      result.passed = missing.length === 0
      result.reason = result.passed
        ? 'all patterns matched'
        : `patterns not matched: ${missing.join(', ')}`
      break
    }
    case 'regex-any': {
      const matched = property.patterns.filter((pattern) => new RegExp(pattern).test(text))
      const min = property.min ?? 1
      result.expected = { patterns: property.patterns, min }
      result.actual = matched
      result.passed = matched.length >= min
      result.reason = result.passed
        ? `${matched.length} pattern(s) matched (needed ${min})`
        : `${matched.length} pattern(s) matched (needed ${min})`
      break
    }
    case 'word-count': {
      const count = wordCount(text)
      const minOk = property.min === undefined || count >= property.min
      const maxOk = property.max === undefined || count <= property.max
      result.expected = { min: property.min ?? null, max: property.max ?? null }
      result.actual = count
      result.passed = minOk && maxOk
      result.reason = result.passed
        ? `${count} words within bounds`
        : `${count} words outside bounds (${property.min ?? '-'}..${property.max ?? '-'})`
      break
    }
    case 'bullet-count': {
      const count = bullets(text).length
      result.expected = property.count
      result.actual = count
      result.passed = count === property.count
      result.reason = result.passed
        ? `${count} bullets as requested`
        : `expected ${property.count} bullets, found ${count}`
      break
    }
    case 'bullet-word-count': {
      const tooLong = bullets(text).filter((line) => wordCount(line) > property.max)
      result.expected = { max: property.max }
      result.actual = tooLong.map((line) => wordCount(line))
      result.passed = tooLong.length === 0
      result.reason = result.passed
        ? 'every bullet within the word budget'
        : `${tooLong.length} bullet(s) exceed ${property.max} words`
      break
    }
    case 'json-shape': {
      let parsed = null
      let parseError = null
      try {
        parsed = JSON.parse(text.trim())
      } catch (err) {
        parseError = err.message
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result.expected = property.required
        result.actual = null
        result.reason = parseError ? `not valid JSON: ${parseError}` : 'not a JSON object'
        break
      }
      const missing = property.required.filter((key) => !(key in parsed))
      result.expected = property.required
      result.actual = Object.keys(parsed).sort()
      result.passed = missing.length === 0
      result.reason = result.passed
        ? 'all required keys present'
        : `missing keys: ${missing.join(', ')}`
      break
    }
    case 'code-fence-count': {
      const fences = codeFences(text)
      result.expected = property.count
      result.actual = fences.length
      result.passed = fences.length === property.count
      result.reason = result.passed
        ? `${fences.length} code block(s) as requested`
        : `expected ${property.count} code block(s), found ${fences.length}`
      break
    }
    case 'code-fence-max-lines': {
      const fences = codeFences(text)
      const longest = fences.reduce((max, fence) => Math.max(max, fence.body.length), 0)
      result.expected = { max: property.max, blocks: fences.length }
      result.actual = longest
      result.passed = fences.length > 0 && longest <= property.max
      result.reason =
        fences.length === 0
          ? 'no code block to measure'
          : longest <= property.max
            ? `longest block is ${longest} lines`
            : `longest block is ${longest} lines, over ${property.max}`
      break
    }
    default:
      throw new QualitySetError(`unhandled check kind "${property.kind}"`)
  }

  return result
}

/** Evaluate every property of one case against one captured output. */
export function evaluateCase(caseDef, output) {
  return caseDef.successProperties.map((property) => checkProperty(property, output))
}
