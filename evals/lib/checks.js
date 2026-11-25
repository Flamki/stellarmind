/**
 * Offline structural checks for the agent quality evaluation set (issue #154).
 *
 * Every check is a pure function of (text, args, context). It never calls the
 * network, never reads the clock and never executes model-produced code, so the
 * same input always yields the same verdict. Checks measure *structure* (does
 * the output have the sections, counts, figures and shape the prompt asked
 * for?). They cannot tell whether the content is true or useful - that stays
 * with human review (see docs/evaluation.md).
 */
import vm from 'node:vm'
import { parsePlanResponse } from '../../src/agents/orchestrator.js'
import { validatePlan } from '../../src/agents/plan-validator.js'
import { estimateCost } from '../../src/agents/registry.js'
import { AssetAmount } from '../../src/agents/amount.js'

/** Normalize line endings so results do not depend on the checkout (CRLF vs LF). */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
}

const FENCE = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g

/** Fenced code blocks as `{ lang, code }`. An unterminated fence is not a block. */
export function codeBlocks(text) {
  const blocks = []
  for (const match of normalizeText(text).matchAll(FENCE)) {
    blocks.push({ lang: match[1].toLowerCase(), code: match[2] })
  }
  return blocks
}

/** The text with fenced code blocks removed (prose only). */
function prose(text) {
  return normalizeText(text).replace(FENCE, ' ')
}

export function wordCount(text) {
  return (prose(text).match(/[A-Za-z0-9$%][\w'’.,$%-]*/g) || []).length
}

/**
 * Heuristic sentence splitter: a sentence ends at . ! or ? followed by
 * whitespace and a capital letter, digit or opening mark. List markers and
 * heading syntax are stripped first. Abbreviations such as "e.g." can fool it,
 * so fixtures and prompts avoid them; it is a structure check, not NLP.
 */
export function sentenceCount(text) {
  const flat = prose(text)
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^#+\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return 0
  return flat.split(/(?<=[.!?])["')\]]*\s+(?=["'(\[*]?[A-Z0-9])/).filter((s) => s.trim()).length
}

function headingKey(line) {
  return line
    .replace(/^\s*#+\s*/, '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/\*/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase()
}

function isHeadingLine(line, heading) {
  const key = headingKey(line)
  return key === heading.toLowerCase() || key.startsWith(`${heading.toLowerCase()} (`)
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+\S/

/** Lines belonging to `heading` (until the next bold/markdown heading). */
function sectionLines(text, heading) {
  const lines = prose(text).split('\n')
  const start = lines.findIndex((line) => isHeadingLine(line, heading))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    const looksLikeHeading =
      /^\s*#+\s+\S/.test(line) ||
      /^\s*(?:\d+[.)]\s*)?\*\*[^*]+\*\*(?:\s*\([^)]*\))?\s*:?\s*$/.test(line)
    if (looksLikeHeading) break
    body.push(line)
  }
  return body
}

function result(pass, detail) {
  return { pass: Boolean(pass), detail }
}

function inRange(value, { min = -Infinity, max = Infinity }) {
  return value >= min && value <= max
}

function rangeLabel({ min, max }) {
  if (min !== undefined && max !== undefined) return `${min}-${max}`
  if (min !== undefined) return `>=${min}`
  if (max !== undefined) return `<=${max}`
  return 'any'
}

function termsMissing(text, terms, caseSensitive) {
  const haystack = caseSensitive ? text : text.toLowerCase()
  return terms.filter((term) => !haystack.includes(caseSensitive ? term : term.toLowerCase()))
}

/** Parse + validate a planner response exactly the way the orchestrator does. */
function parseModelPlan(text) {
  let parsed
  try {
    parsed = parsePlanResponse({
      content: [{ type: 'text', text: normalizeText(text) }],
      stop_reason: 'end_turn',
    })
  } catch (err) {
    return { ok: false, reason: err.code || 'PLAN_PARSE_ERROR' }
  }
  const validated = validatePlan(parsed)
  if (!validated.valid) return { ok: false, reason: validated.reason }
  return { ok: true, plan: validated.plan }
}

function withPlan(text, fn) {
  const parsed = parseModelPlan(text)
  if (!parsed.ok) return result(false, `plan unusable (${parsed.reason})`)
  return fn(parsed.plan)
}

/**
 * Check registry. `args` come from the case file; `ctx` is `{ input, context }`.
 * Each check returns `{ pass, detail }` where `detail` is a short, stable string.
 */
export const CHECKS = {
  not_empty(text) {
    const length = normalizeText(text).trim().length
    return result(length > 0, `${length} characters`)
  },

  ends_cleanly(text) {
    const trimmed = normalizeText(text).trimEnd()
    const last = trimmed.slice(-1)
    return result(
      last !== '' && /[.!?)\]}"'`]/.test(last),
      `last character: ${JSON.stringify(last)}`
    )
  },

  word_count(text, args) {
    const count = wordCount(text)
    return result(inRange(count, args), `${count} words (want ${rangeLabel(args)})`)
  },

  sentence_count(text, args) {
    const count = sentenceCount(text)
    return result(inRange(count, args), `${count} sentences (want ${rangeLabel(args)})`)
  },

  contains_all(text, { terms, caseSensitive = false }) {
    const missing = termsMissing(normalizeText(text), terms, caseSensitive)
    return result(
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : 'all present'
    )
  },

  contains_any(text, { terms, caseSensitive = false }) {
    const body = normalizeText(text)
    const found = terms.filter((term) => termsMissing(body, [term], caseSensitive).length === 0)
    return result(found.length > 0, found.length ? `found: ${found.join(', ')}` : 'none present')
  },

  not_contains(text, { terms }) {
    const body = normalizeText(text)
    const found = terms.filter((term) => termsMissing(body, [term], false).length === 0)
    return result(
      found.length === 0,
      found.length ? `forbidden: ${found.join(', ')}` : 'none present'
    )
  },

  matches(text, { pattern, flags = 'i' }) {
    return result(new RegExp(pattern, flags).test(normalizeText(text)), `/${pattern}/${flags}`)
  },

  not_matches(text, { pattern, flags = 'im' }) {
    return result(!new RegExp(pattern, flags).test(normalizeText(text)), `/${pattern}/${flags}`)
  },

  headings(text, { required }) {
    const lines = prose(text).split('\n')
    const missing = required.filter((name) => !lines.some((line) => isHeadingLine(line, name)))
    return result(
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : 'all present'
    )
  },

  section_bullets(text, { heading, min, max }) {
    const body = sectionLines(text, heading)
    if (!body) return result(false, `section "${heading}" not found`)
    const count = body.filter((line) => BULLET.test(line)).length
    return result(
      inRange(count, { min, max }),
      `${count} bullets under "${heading}" (want ${rangeLabel({ min, max })})`
    )
  },

  max_word_ratio_of_input(text, { max }, ctx) {
    const inputWords = wordCount(ctx.input)
    const ratio = inputWords === 0 ? Infinity : wordCount(text) / inputWords
    return result(ratio <= max, `${ratio.toFixed(2)} of input length (want <=${max})`)
  },

  code_block(text, { language, min = 1, maxLines }) {
    const blocks = codeBlocks(text).filter((block) => !language || block.lang === language)
    const longest = blocks.reduce(
      (most, block) => Math.max(most, block.code.replace(/\n+$/, '').split('\n').length),
      0
    )
    const countOk = blocks.length >= min
    const linesOk = maxLines === undefined || longest <= maxLines
    return result(
      countOk && linesOk,
      `${blocks.length} ${language || 'code'} block(s), longest ${longest} lines` +
        (maxLines === undefined ? '' : ` (want <=${maxLines})`)
    )
  },

  // Compile-only syntax check. The code is parsed but never run.
  js_syntax(text, { language = 'js' }) {
    const aliases = language === 'js' ? ['js', 'javascript'] : [language]
    const blocks = codeBlocks(text).filter((block) => aliases.includes(block.lang))
    if (blocks.length === 0) return result(false, 'no JavaScript block to parse')
    for (const [index, block] of blocks.entries()) {
      try {
        new vm.Script(block.code, { filename: `block-${index + 1}.js` })
      } catch (err) {
        return result(false, `block ${index + 1}: ${String(err.message).split('\n')[0]}`)
      }
    }
    return result(true, `${blocks.length} block(s) parse`)
  },

  plan_valid(text) {
    const parsed = parseModelPlan(text)
    return parsed.ok
      ? result(true, `${parsed.plan.subtasks.length} valid subtask(s)`)
      : result(false, `rejected: ${parsed.reason}`)
  },

  plan_subtasks(text, args) {
    return withPlan(text, (plan) =>
      result(
        inRange(plan.subtasks.length, args),
        `${plan.subtasks.length} subtasks (want ${rangeLabel(args)})`
      )
    )
  },

  plan_agents(text, { include = [], exclude = [], order = [] }) {
    return withPlan(text, (plan) => {
      const ids = plan.subtasks.map((step) => step.agentId)
      const problems = []
      for (const id of include) if (!ids.includes(id)) problems.push(`missing ${id}`)
      for (const id of exclude) if (ids.includes(id)) problems.push(`unexpected ${id}`)
      const positions = order.map((id) => ids.indexOf(id))
      const ordered = positions.every((pos, i) => pos !== -1 && (i === 0 || pos > positions[i - 1]))
      if (order.length > 0 && !ordered) problems.push(`order is not ${order.join(' -> ')}`)
      return result(
        problems.length === 0,
        problems.length ? problems.join('; ') : `agents: ${ids.join(' -> ')}`
      )
    })
  },

  plan_within_budget(text, _args, ctx) {
    return withPlan(text, (plan) => {
      const budget = AssetAmount.from(String(ctx.context.budget), 'USDC')
      const total = estimateCost(plan.subtasks.map((step) => step.agentId))
      return result(
        total.isLessThanOrEqualTo(budget),
        `registry cost ${total.toDecimalString(2)} vs budget ${budget.toDecimalString(2)} USDC`
      )
    })
  },

  plan_input_mentions(text, { terms }) {
    return withPlan(text, (plan) => {
      const found = terms.filter((term) =>
        plan.subtasks.some((step) => step.input.toLowerCase().includes(term.toLowerCase()))
      )
      return result(
        found.length > 0,
        found.length ? `found: ${found.join(', ')}` : 'no subtask input mentions the task'
      )
    })
  },
}

export const CHECK_TYPES = Object.freeze(Object.keys(CHECKS))

/** Run one property against one output. Unknown check types are a case-file error. */
export function runProperty(property, text, ctx) {
  const check = CHECKS[property.check]
  if (!check) throw new Error(`Unknown check type "${property.check}" in property "${property.id}"`)
  const { pass, detail } = check(text, property.args || {}, ctx)
  return { id: property.id, check: property.check, pass, detail }
}
