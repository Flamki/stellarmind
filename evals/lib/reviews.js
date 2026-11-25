/**
 * Human review records (issue #154).
 *
 * Automated checks measure structure; whether an answer is accurate, useful
 * or well judged is a human call. Reviews are recorded by hand in
 * reviews.v1.json and are never inferred or scored by this tool. A review is
 * only "current" while it matches the eval set version and the prompt
 * revision it judged; otherwise it is reported as stale.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EVALS_DIR } from './load.js'
import { normalizeText } from './checks.js'

export const VERDICTS = ['accept', 'needs-work']
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function loadReviews(dir = EVALS_DIR, caseIds = []) {
  const file = path.join(dir, 'reviews.v1.json')
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(normalizeText(fs.readFileSync(file, 'utf8')))
  const reviews = parsed.reviews
  if (!Array.isArray(reviews)) throw new Error('reviews.v1.json: "reviews" must be an array')

  const known = new Set(caseIds)
  const problems = []
  for (const [index, review] of reviews.entries()) {
    const where = `review #${index + 1}`
    if (!known.has(review.caseId)) problems.push(`${where}: unknown caseId "${review.caseId}"`)
    if (!review.reviewer) problems.push(`${where}: reviewer is required`)
    if (!DATE_PATTERN.test(review.reviewedAt || ''))
      problems.push(`${where}: reviewedAt must be YYYY-MM-DD`)
    if (!VERDICTS.includes(review.verdict))
      problems.push(`${where}: verdict must be one of ${VERDICTS.join(', ')}`)
    if (typeof review.evalSetVersion !== 'string')
      problems.push(`${where}: evalSetVersion is required`)
    if (review.promptRevision !== null && typeof review.promptRevision !== 'string') {
      problems.push(`${where}: promptRevision must be a string or null`)
    }
  }
  if (problems.length > 0)
    throw new Error(`Invalid reviews.v1.json:\n  - ${problems.join('\n  - ')}`)
  return reviews
}

/**
 * Status of the most recent review of a case.
 * @returns {{ status: 'not recorded'|'accept'|'needs-work'|'stale', latest: object|null }}
 */
export function reviewStatus(caseId, { evalSetVersion, promptRevision }, reviews) {
  const latest = [...reviews].reverse().find((review) => review.caseId === caseId) || null
  if (!latest) return { status: 'not recorded', latest: null }
  const current =
    latest.evalSetVersion === evalSetVersion && latest.promptRevision === promptRevision
  return { status: current ? latest.verdict : 'stale', latest }
}
