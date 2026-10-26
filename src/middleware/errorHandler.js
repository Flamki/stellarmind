import { logger } from '../logger.js'
import {
  ATTEMPT_HEADER,
  CORRELATION_ID_HEADER,
  RUN_ID_HEADER,
  STEP_ID_HEADER,
  extractCorrelationContext,
  toCorrelationLogFields,
} from '../correlation.js'

/**
 * Attach sanitized correlation metadata (`requestId`, `runId`, `stepId`,
 * `stepAttempt`, and `correlationContext`) to every incoming request so it
 * flows through internal premium requests, error responses, and server logs
 * without ever accepting raw task text or credentials (#182).
 */
export function requestId(req, _res, next) {
  const correlation = extractCorrelationContext(req, { generateIfMissing: true })
  req.requestId = correlation.correlationId
  req.runId = correlation.runId
  req.stepId = correlation.stepId
  req.stepAttempt = correlation.attempt
  req.correlationContext = correlation
  next()
}

export function requestLogger(req, res, next) {
  const startedAt = Date.now()
  res.setHeader(CORRELATION_ID_HEADER, req.requestId)
  if (req.runId) res.setHeader(RUN_ID_HEADER, req.runId)
  if (req.stepId) res.setHeader(STEP_ID_HEADER, req.stepId)
  if (req.stepAttempt !== null && req.stepAttempt !== undefined) {
    res.setHeader(ATTEMPT_HEADER, String(req.stepAttempt))
  }

  const correlationFields = toCorrelationLogFields({
    correlationId: req.requestId,
    runId: req.runId,
    stepId: req.stepId,
    attempt: req.stepAttempt,
  })

  logger.info('request_start', {
    ...correlationFields,
    method: req.method,
    path: req.path,
    url: req.originalUrl,
  })

  res.on('finish', () => {
    logger.info('request_complete', {
      ...correlationFields,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    })
  })

  next()
}

/**
 * Centralized Express error-handling middleware.
 *
 * Normalizes all unhandled errors into a consistent JSON envelope:
 *   { code, message, requestId }
 *
 * Stack traces are only included in non-production environments and
 * are never sent to the client in production.
 */
export function errorHandler(err, req, res, _next) {
  const isProd = process.env.NODE_ENV === 'production'

  // Determine HTTP status — honour err.status / err.statusCode if set
  const status = err.status || err.statusCode || 500

  // Derive a machine-readable code from the error name or a default
  const code = err.code || err.name || (status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR')

  if (err.retryAfter) {
    res.setHeader('Retry-After', String(err.retryAfter))
  }

  // Always log the full error server-side for diagnostics
  logger.error('request_error', {
    ...toCorrelationLogFields({
      correlationId: req.requestId,
      runId: req.runId,
      stepId: req.stepId,
      attempt: req.stepAttempt,
    }),
    method: req.method,
    url: req.originalUrl,
    status,
    code,
    message: err.message,
    err,
  })

  // In production, mask only 5xx server errors to avoid leaking internals.
  // 4xx client errors and exposed errors keep their message so API consumers get actionable feedback.
  const message =
    isProd && status >= 500 && !err.expose
      ? 'An unexpected error occurred'
      : err.message || 'An unexpected error occurred'

  const body = {
    code,
    message,
    requestId: req.requestId,
  }

  if (err.retryAfter !== undefined) {
    body.retryAfter = err.retryAfter
  }

  if (err.state !== undefined) {
    body.state = err.state
  }

  if (Array.isArray(err.details) && err.details.length > 0) {
    body.details = err.details
  }

  // Expose stack only in development
  if (!isProd && err.stack) {
    body.stack = err.stack
  }

  res.status(status).json(body)
}
