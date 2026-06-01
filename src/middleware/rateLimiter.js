// Simple in-memory fixed-window rate limiter with per-identifier keys
// Identifier: X-Request-Key header if present, otherwise IP (req.ip or X-Forwarded-For)

import { config } from '../config.js';
import { logger } from '../logger.js';

function getIdentifier(req) {
  const hdr = req.headers['x-request-key'] || req.headers['x-api-key'] || req.headers['authorization'];
  if (hdr && typeof hdr === 'string') return `key:${hdr}`;
  // Prefer X-Forwarded-For if present
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') return `ip:${xff.split(',')[0].trim()}`;
  return `ip:${req.ip || 'unknown'}`;
}

function createFixedWindowLimiter({ windowSec, max }) {
  const windowMs = windowSec * 1000;
  // Map identifier -> { count, windowStart }
  const store = new Map();

  return function limiter(req, res, next) {
    try {
      const id = getIdentifier(req);
      const now = Date.now();
      const entry = store.get(id) || { count: 0, windowStart: now };

      // Reset if window elapsed
      if (now - entry.windowStart >= windowMs) {
        entry.count = 0;
        entry.windowStart = now;
      }

      entry.count += 1;
      store.set(id, entry);

      if (entry.count > max) {
        const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000) || 1;
        // Clear sensitive details in logs
        logger.warn('rate_limit_exceeded', {
          correlationId: req.requestId,
          id,
          path: req.originalUrl,
          method: req.method,
          max,
          windowSec,
        });
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Retry after ${retryAfterSec} seconds.`,
          requestId: req.requestId,
          retryAfter: retryAfterSec,
        });
      }

      next();
    } catch (err) {
      // On any unexpected error in limiter, allow the request through
      logger.error('rate_limiter_error', { correlationId: req.requestId, err });
      next();
    }
  };
}

// Export preconfigured middlewares using values from config
export const orchestrateLimiter = createFixedWindowLimiter({
  windowSec: config.rateLimit.orchestrateWindowSec,
  max: config.rateLimit.orchestrateMax,
});

export const apikeyLimiter = createFixedWindowLimiter({
  windowSec: config.rateLimit.apikeyWindowSec,
  max: config.rateLimit.apikeyMax,
});

// A default limiter for other high-risk routes if needed
export const defaultLimiter = createFixedWindowLimiter({
  windowSec: config.rateLimit.defaultWindowSec,
  max: config.rateLimit.defaultMax,
});
