/**
 * Circuit breaker implementation for upstream AI model providers.
 * Prevents cascading failures and latency spikes during model downtime.
 */
import { config } from '../config.js'

export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? (config.circuitBreaker?.failureThreshold || 3)
    this.cooldownWindowMs = options.cooldownWindowMs ?? (config.circuitBreaker?.cooldownWindowMs || 30000)
    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.consecutiveFailures = 0
    this.lastFailureTime = null
    this.lastStateChange = Date.now()
  }

  canExecute() {
    if (this.state === 'CLOSED') {
      return true
    }

    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.lastFailureTime || 0)
      if (elapsed >= this.cooldownWindowMs) {
        this.transitionTo('HALF_OPEN')
        return true
      }
      return false
    }

    if (this.state === 'HALF_OPEN') {
      return true
    }

    return true
  }

  recordSuccess() {
    if (this.state !== 'CLOSED') {
      console.log('[CircuitBreaker] Upstream provider recovered. State transitioned to CLOSED.')
      this.transitionTo('CLOSED')
    }
    this.consecutiveFailures = 0
  }

  recordFailure(error) {
    this.consecutiveFailures += 1
    this.lastFailureTime = Date.now()

    if (this.state === 'HALF_OPEN') {
      console.warn(`[CircuitBreaker] Probe request failed: ${error?.message}. Re-opening breaker for ${this.cooldownWindowMs}ms.`)
      this.transitionTo('OPEN')
    } else if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
      console.warn(`[CircuitBreaker] ${this.consecutiveFailures} consecutive failures reached threshold. Transitioning to OPEN for ${this.cooldownWindowMs}ms.`)
      this.transitionTo('OPEN')
    }
  }

  transitionTo(newState) {
    this.state = newState
    this.lastStateChange = Date.now()
  }

  getStatus() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      cooldownWindowMs: this.cooldownWindowMs,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
      isDegraded: this.state !== 'CLOSED',
    }
  }
}

export const modelCircuitBreaker = new CircuitBreaker()
