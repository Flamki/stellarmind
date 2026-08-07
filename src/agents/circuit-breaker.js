/**
 * Circuit Breaker for unstable upstream model providers.
 *
 * Implements the classic circuit breaker pattern:
 *   - CLOSED: requests flow normally
 *   - OPEN: requests short-circuit to fallback
 *   - HALF-OPEN: one probe request to test recovery
 *
 * Closes #23
 */

import { logger } from '../logger.js'

const DEFAULT_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 30_000 // 30 seconds
const DEFAULT_PROBE_TIMEOUT_MS = 10_000

const State = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
}

/**
 * @typedef {Object} CircuitBreakerOptions
 * @property {number} [failureThreshold=5] - Consecutive failures before opening
 * @property {number} [cooldownMs=30000] - Time in OPEN before transitioning to HALF_OPEN
 * @property {number} [probeTimeoutMs=10000] - Max wait for a half-open probe
 * @property {string} [name='default'] - Identifier for logging
 * @property {Function} [fallback] - Optional fallback function
 */

export class CircuitBreaker {
  /**
   * @param {CircuitBreakerOptions} options
   */
  constructor(options = {}) {
    this.name = options.name || 'default'
    this.failureThreshold = options.failureThreshold ?? DEFAULT_THRESHOLD
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    this.fallback = options.fallback || null

    this.state = State.CLOSED
    this.failureCount = 0
    this.lastFailureTime = null
    this.openedAt = null
    this.successCount = 0
    this.totalCalls = 0
  }

  /**
   * Execute an async operation with circuit breaker protection.
   * @param {Function} fn - The async operation to protect
   * @param {Object} [ctx] - Optional context for logging
   * @returns {Promise<*>}
   */
  async call(fn, ctx = {}) {
    this.totalCalls++

    if (this.state === State.OPEN) {
      if (this._cooldownElapsed()) {
        this._transitionTo(State.HALF_OPEN)
      } else {
        return this._handleOpen(ctx)
      }
    }

    try {
      const result = this.state === State.HALF_OPEN
        ? await this._probe(fn)
        : await fn()

      this._onSuccess()
      return result
    } catch (err) {
      return this._onFailure(err, ctx)
    }
  }

  /**
   * Return current breaker status for dashboard/API visibility.
   * @returns {{ state: string, failures: number, openedAt: string|null, totalCalls: number, successCount: number }}
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      failuresUntilOpen: Math.max(0, this.failureThreshold - this.failureCount),
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      cooldownMs: this.cooldownMs,
      totalCalls: this.totalCalls,
      successCount: this.successCount,
    }
  }

  /** Reset breaker to closed state (for testing/manual recovery). */
  reset() {
    this.failureCount = 0
    this.lastFailureTime = null
    this.openedAt = null
    this._transitionTo(State.CLOSED)
    logger.info('circuit_breaker_reset', { name: this.name })
  }

  // ── Private helpers ──────────────────────────────────────────

  _transitionTo(newState) {
    const prev = this.state
    this.state = newState
    if (newState === State.OPEN) {
      this.openedAt = Date.now()
    }
    if (newState === State.CLOSED) {
      this.openedAt = null
      this.failureCount = 0
    }
    logger.warn('circuit_breaker_state_change', {
      name: this.name,
      from: prev,
      to: newState,
      failureCount: this.failureCount,
    })
  }

  _cooldownElapsed() {
    return this.openedAt && (Date.now() - this.openedAt) >= this.cooldownMs
  }

  async _probe(fn) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Circuit breaker probe timed out')), this.probeTimeoutMs)
    )
    return Promise.race([fn(), timeout])
  }

  _onSuccess() {
    if (this.state === State.HALF_OPEN) {
      logger.info('circuit_breaker_probe_success', { name: this.name })
      this._transitionTo(State.CLOSED)
    } else {
      this.failureCount = 0
      this.successCount++
    }
  }

  async _onFailure(err, ctx) {
    this.failureCount++
    this.lastFailureTime = Date.now()
    this.successCount = Math.max(0, this.successCount - 1)

    logger.warn('circuit_breaker_failure', {
      name: this.name,
      failureCount: this.failureCount,
      threshold: this.failureThreshold,
      error: err?.message || String(err),
      ...ctx,
    })

    if (this.failureCount >= this.failureThreshold) {
      this._transitionTo(State.OPEN)
    }

    if (this.fallback && this.state === State.OPEN) {
      return this.fallback(ctx)
    }

    throw err
  }

  async _handleOpen(ctx) {
    logger.warn('circuit_breaker_open_rejected', {
      name: this.name,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      ...ctx,
    })

    if (this.fallback) {
      return this.fallback(ctx)
    }

    throw new Error(
      `Circuit breaker [${this.name}] is OPEN — upstream model provider is unavailable` +
      ` (${this.failureCount} failures). Retry after ${this.cooldownMs}ms cooldown.`
    )
  }
}

/**
 * Create a pre-configured circuit breaker for Anthropic API calls.
 * @param {CircuitBreakerOptions} [options]
 * @returns {CircuitBreaker}
 */
export function createAnthropicBreaker(options = {}) {
  return new CircuitBreaker({
    name: 'anthropic-provider',
    failureThreshold: 3,
    cooldownMs: 15_000,
    probeTimeoutMs: 8_000,
    ...options,
  })
}

export { State }
