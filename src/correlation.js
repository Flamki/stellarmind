import { randomUUID } from 'node:crypto'

export const CORRELATION_ID_HEADER = 'x-correlation-id'
export const LEGACY_REQUEST_ID_HEADER = 'x-request-id'
export const RUN_ID_HEADER = 'x-stellarmind-run-id'
export const STEP_ID_HEADER = 'x-stellarmind-step-id'
export const ATTEMPT_HEADER = 'x-stellarmind-attempt'

export const CORRELATION_HEADER_NAMES = Object.freeze({
  correlationId: CORRELATION_ID_HEADER,
  runId: RUN_ID_HEADER,
  stepId: STEP_ID_HEADER,
  attempt: ATTEMPT_HEADER,
})

const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/
const STELLAR_SECRET_PATTERN = /S[A-Z2-7]{55}/
const SECRET_SUBSTRING_PATTERN = /(?:sk-ant-|^bearer(?:[_:.-]|$|\b)|api[_-]?key|secret)/i

/**
 * Sanitizes a correlation, run, or step identifier so task text, whitespace,
 * control characters, and credentials (such as Anthropic API keys or Stellar
 * secret keys) are never placed into correlation headers or propagated across
 * internal HTTP boundaries (#182).
 *
 * @param {*} value
 * @returns {string | null}
 */
export function sanitizeCorrelationToken(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) return null
  if (!SAFE_TOKEN_PATTERN.test(trimmed)) return null
  if (STELLAR_SECRET_PATTERN.test(trimmed)) return null
  if (SECRET_SUBSTRING_PATTERN.test(trimmed)) return null
  return trimmed
}

/**
 * Normalizes a positive integer retry/execution attempt counter (1..1000).
 *
 * @param {*} value
 * @returns {number | null}
 */
export function sanitizeAttemptNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1 && value <= 1000) return value
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d{1,4}$/.test(trimmed)) return null
    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000) return parsed
  }
  return null
}

/**
 * Normalizes correlation metadata into a consistent object shape.
 *
 * @param {Object} [raw]
 * @returns {{ correlationId: string | null, runId: string | null, stepId: string | null, attempt: number | null }}
 */
export function normalizeCorrelationMeta(raw = {}) {
  return {
    correlationId: sanitizeCorrelationToken(raw.correlationId) || null,
    runId: sanitizeCorrelationToken(raw.runId) || null,
    stepId: sanitizeCorrelationToken(raw.stepId) || null,
    attempt: sanitizeAttemptNumber(raw.attempt),
  }
}

/**
 * Builds outbound HTTP headers carrying only sanitized correlation metadata
 * for internal `/api/premium/*` calls (#182).
 *
 * @param {Object} [meta]
 * @returns {Record<string, string>}
 */
export function buildCorrelationHeaders(meta = {}) {
  const normalized = normalizeCorrelationMeta(meta)
  const headers = {}

  if (normalized.correlationId) {
    headers[CORRELATION_ID_HEADER] = normalized.correlationId
  }
  if (normalized.runId) {
    headers[RUN_ID_HEADER] = normalized.runId
  }
  if (normalized.stepId) {
    headers[STEP_ID_HEADER] = normalized.stepId
  }
  if (normalized.attempt !== null) {
    headers[ATTEMPT_HEADER] = String(normalized.attempt)
  }

  return headers
}

/**
 * Reads a header from an Express request or a plain headers object/Headers instance.
 *
 * @param {Object} reqOrHeaders
 * @param {string} headerName
 * @returns {string | null}
 */
function readHeaderValue(reqOrHeaders, headerName) {
  if (!reqOrHeaders) return null
  if (typeof reqOrHeaders.header === 'function') {
    return reqOrHeaders.header(headerName) || null
  }
  if (typeof reqOrHeaders.get === 'function') {
    return reqOrHeaders.get(headerName) || null
  }
  const source = reqOrHeaders.headers || reqOrHeaders
  if (source && typeof source === 'object') {
    const lower = headerName.toLowerCase()
    for (const [k, v] of Object.entries(source)) {
      if (k.toLowerCase() === lower && typeof v === 'string') {
        return v
      }
    }
  }
  return null
}

/**
 * Extracts and sanitizes correlation metadata from an incoming request.
 * Generates a fresh UUID when no valid `x-correlation-id` or `x-request-id`
 * header is present.
 *
 * @param {Object} req
 * @param {Object} [options]
 * @param {boolean} [options.generateIfMissing=true]
 * @returns {{ correlationId: string | null, runId: string | null, stepId: string | null, attempt: number | null }}
 */
export function extractCorrelationContext(req, { generateIfMissing = true } = {}) {
  const incomingCorrelationId =
    sanitizeCorrelationToken(readHeaderValue(req, CORRELATION_ID_HEADER)) ||
    sanitizeCorrelationToken(readHeaderValue(req, LEGACY_REQUEST_ID_HEADER))

  const correlationId = incomingCorrelationId || (generateIfMissing ? randomUUID() : null)
  const runId = sanitizeCorrelationToken(readHeaderValue(req, RUN_ID_HEADER))
  const stepId = sanitizeCorrelationToken(readHeaderValue(req, STEP_ID_HEADER))
  const attempt = sanitizeAttemptNumber(readHeaderValue(req, ATTEMPT_HEADER))

  return {
    correlationId,
    runId,
    stepId,
    attempt,
  }
}

/**
 * Formats non-null correlation fields for structured log entries.
 *
 * @param {Object} [meta]
 * @returns {Record<string, string | number>}
 */
export function toCorrelationLogFields(meta = {}) {
  const normalized = normalizeCorrelationMeta(meta)
  const fields = {}
  if (normalized.correlationId) fields.correlationId = normalized.correlationId
  if (normalized.runId) fields.runId = normalized.runId
  if (normalized.stepId) fields.stepId = normalized.stepId
  if (normalized.attempt !== null) fields.attempt = normalized.attempt
  return fields
}
