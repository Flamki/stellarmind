import { randomUUID } from 'node:crypto';

/**
 * Attach a requestId to every incoming request so it flows through
 * to error responses and server logs.
 */
export function requestId(req, _res, next) {
  req.requestId = randomUUID();
  next();
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
  const isProd = process.env.NODE_ENV === 'production';

  // Determine HTTP status — honour err.status / err.statusCode if set
  const status = err.status || err.statusCode || 500;

  // Derive a machine-readable code from the error name or a default
  const code = err.code || err.name || (status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR');

  // Always log the full error server-side for diagnostics
  console.error({
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    status,
    code,
    message: err.message,
    stack: err.stack,
  });

  // In production, mask only 5xx server errors to avoid leaking internals.
  // 4xx client errors keep their message so API consumers get actionable feedback.
  const message = isProd && status >= 500
    ? 'An unexpected error occurred'
    : (err.message || 'An unexpected error occurred');

  const body = {
    code,
    message,
    requestId: req.requestId,
  };

  // Expose stack only in development
  if (!isProd && err.stack) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}
