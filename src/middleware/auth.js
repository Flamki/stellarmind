import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Middleware to protect configuration mutation routes with an optional admin token.
 * 
 * If ADMIN_TOKEN is configured in the environment, requests must provide it
 * in the X-Admin-Token header.
 * 
 * If no token is configured, the request is allowed (Developer Bypass).
 */
export function adminAuth(req, res, next) {
  const token = config.adminToken;

  // Developer Bypass: If no token is configured, allow the request.
  if (!token) {
    logger.info('admin_auth_bypass', { 
      reason: 'no_admin_token_configured',
      path: req.path,
      correlationId: req.requestId 
    });
    return next();
  }

  const providedToken = req.header('x-admin-token');

  if (!providedToken || providedToken !== token) {
    logger.warn('admin_auth_failed', {
      path: req.path,
      reason: !providedToken ? 'missing_token' : 'invalid_token',
      correlationId: req.requestId
    });

    const err = new Error('Unauthorized: Admin token required for this operation');
    err.status = 401;
    err.code = 'UNAUTHORIZED';
    return next(err);
  }

  logger.info('admin_auth_success', {
    path: req.path,
    correlationId: req.requestId
  });
  
  next();
}
