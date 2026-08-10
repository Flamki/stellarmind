/**
 * Circuit Breaker Module — StellarMind
 * Protects against unstable upstream model providers.
 * Stellar Wave bounty #23
 */

const STATES = {
  CLOSED: 'CLOSED',       // Normal operation — requests pass through
  OPEN: 'OPEN',           // Failure threshold exceeded — requests blocked
  HALF_OPEN: 'HALF_OPEN'  // Testing if provider has recovered
};

class CircuitBreaker {
  /**
   * @param {Object} options
   * @param {string} options.name — circuit name (e.g., provider name)
   * @param {number} [options.failureThreshold=5] — failures before opening
   * @param {number} [options.resetTimeout=30000] — ms before attempting half-open
   * @param {number} [options.successThreshold=2] — successes needed to close
   * @param {number} [options.requestTimeout=15000] — ms before request considered failed
   */
  constructor(_options = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.successThreshold = options.successThreshold || 2;
    this.requestTimeout = options.requestTimeout || 15000;

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastFailureError = null;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
  }

  /**
   * Execute an async function with circuit breaker protection.
   * @param {Function} fn — async function to execute
   * @returns {Promise<*>} result of fn if circuit is closed/half-open and fn succeeds
   * @throws {Error} if circuit is open or fn fails while half-open
   */
  async execute(fn) {
    if (this.state === STATES.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = STATES.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new CircuitOpenError(this.name, this.lastFailureTime, this.resetTimeout);
      }
    }

    try {
      const result = await this._withTimeout(fn());
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  _onSuccess() {
    this.totalSuccesses++;
    if (this.state === STATES.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = STATES.CLOSED;
        this.failureCount = 0;
      }
    } else {
      // In CLOSED state, occasional successes reset the failure window
      this.failureCount = Math.max(0, this.failureCount - 1);
    }
  }

  _onFailure(error) {
    this.totalFailures++;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.lastFailureError = error.message || String(error);

    if (this.state === STATES.HALF_OPEN) {
      this.state = STATES.OPEN;
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = STATES.OPEN;
    }
  }

  async _withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Request timeout')), this.requestTimeout);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get current circuit breaker status.
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastFailureError: this.lastFailureError,
      failureThreshold: this.failureThreshold,
      resetTimeout: this.resetTimeout
    };
  }

  /**
   * Force the circuit breaker open (e.g., manual intervention).
   */
  forceOpen() {
    this.state = STATES.OPEN;
    this.lastFailureTime = Date.now();
  }

  /**
   * Force the circuit breaker closed (reset).
   */
  forceClose() {
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}

class CircuitOpenError extends Error {
  constructor(name, lastFailureTime, resetTimeout) {
    const remaining = Math.max(0, resetTimeout - (Date.now() - lastFailureTime));
    super(`Circuit "${name}" is OPEN. Resets in ${Math.round(remaining / 1000)}s.`);
    this.name = 'CircuitOpenError';
    this.circuitName = name;
    this.resetsIn = remaining;
  }
}

class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map();
  }

  get(name, options) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker({ name, ...options }));
    }
    return this.breakers.get(name);
  }

  getAllStatus() {
    return [...this.breakers.values()].map(b => b.getStatus());
  }
}

const registry = new CircuitBreakerRegistry();

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  CircuitBreakerRegistry,
  registry,
  STATES
};
