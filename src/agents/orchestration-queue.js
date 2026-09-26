import { randomUUID } from 'node:crypto'

/**
 * Error thrown when the admission queue has reached maximum capacity.
 */
export class QueueCapacityExceededError extends Error {
  constructor(message, state, retryAfter) {
    super(message || 'Server is overloaded. Orchestration admission queue capacity exceeded.')
    this.name = 'QueueCapacityExceededError'
    this.status = 503
    this.statusCode = 503
    this.code = 'QUEUE_CAPACITY_EXCEEDED'
    this.expose = true
    this.state = state
    this.retryAfter = retryAfter
  }
}

/**
 * Error thrown when a queued request exceeds the queue wait deadline.
 */
export class QueueTimeoutError extends Error {
  constructor(message, state, retryAfter) {
    super(message || 'Orchestration request timed out while waiting in admission queue.')
    this.name = 'QueueTimeoutError'
    this.status = 503
    this.statusCode = 503
    this.code = 'QUEUE_TIMEOUT'
    this.expose = true
    this.state = state
    this.retryAfter = retryAfter
  }
}

/**
 * Error thrown when a queued or running request is aborted/cancelled.
 */
export class QueueAbortError extends Error {
  constructor(message, state) {
    super(message || 'Orchestration request was aborted.')
    this.name = 'QueueAbortError'
    this.status = 499
    this.statusCode = 499
    this.code = 'REQUEST_ABORTED'
    this.expose = true
    this.state = state
  }
}

/**
 * Single-process in-memory admission queue for bounding concurrent orchestration work.
 *
 * Guarantees:
 * - Active execution count never exceeds maxConcurrent.
 * - Queue capacity is bounded by queueCapacity.
 * - Queue wait time is bounded by queueTimeoutMs.
 * - Cancellation and failure release execution capacity exactly once.
 * - Note: This queue coordinates work within a single server process only. It does not
 *   provide distributed synchronization across multiple server replicas.
 */
export class OrchestrationAdmissionQueue {
  constructor(options = {}) {
    const maxConcurrent = Number.parseInt(options.maxConcurrent, 10)
    const queueCapacity = Number.parseInt(options.queueCapacity, 10)
    const queueTimeoutMs = Number.parseInt(options.queueTimeoutMs, 10)

    this.maxConcurrent = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2
    this.queueCapacity = Number.isFinite(queueCapacity) && queueCapacity >= 0 ? queueCapacity : 10
    this.queueTimeoutMs =
      Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0 ? queueTimeoutMs : 30000

    this.activeCount = 0
    this.queue = []
    this.activeEntries = new Map()
  }

  getState() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      queueCapacity: this.queueCapacity,
      queueTimeoutMs: this.queueTimeoutMs,
    }
  }

  get queueLength() {
    return this.queue.length
  }

  getQueuePosition(id) {
    const idx = this.queue.findIndex((e) => e.id === id)
    return idx === -1 ? null : idx + 1
  }

  getRunStatus(id) {
    if (this.activeEntries.has(id)) {
      return { status: 'active', position: null }
    }
    const idx = this.queue.findIndex((e) => e.id === id)
    if (idx !== -1) {
      return { status: 'queued', position: idx + 1 }
    }
    return null
  }

  /**
   * Run a task through the admission queue.
   *
   * @param {Function} taskFn - Async function to execute when admitted: ({ signal }) => Promise<any>
   * @param {Object} [options]
   * @param {string} [options.id] - Optional identifier for tracking/cancellation
   * @param {AbortSignal} [options.signal] - Optional external abort signal
   * @param {Function} [options.onQueued] - Callback ({ position, queueLength, activeCount })
   * @param {Function} [options.onAdmitted] - Callback ({ waitDurationMs, activeCount, queued })
   * @returns {Promise<any>} Result of taskFn
   */
  async run(taskFn, options = {}) {
    if (typeof taskFn !== 'function') {
      throw new TypeError('taskFn must be a function')
    }

    if (options.signal?.aborted) {
      throw new QueueAbortError(
        'Orchestration request was aborted prior to admission',
        this.getState()
      )
    }

    const id = options.id || randomUUID()

    // Fast-path: immediate admission if capacity available
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++
      const activeAbortController = new AbortController()

      let onExternalAbort = null
      if (options.signal) {
        onExternalAbort = () => activeAbortController.abort(options.signal.reason)
        options.signal.addEventListener('abort', onExternalAbort, { once: true })
      }

      this.activeEntries.set(id, { abortController: activeAbortController })

      let released = false
      const release = () => {
        if (released) return
        released = true
        if (options.signal && onExternalAbort) {
          options.signal.removeEventListener('abort', onExternalAbort)
        }
        this.activeEntries.delete(id)
        this._releaseSlot()
      }

      try {
        options.onAdmitted?.({
          waitDurationMs: 0,
          activeCount: this.activeCount,
          queued: false,
        })
        return await taskFn({ signal: activeAbortController.signal })
      } finally {
        release()
      }
    }

    // Capacity is full: check queue capacity
    if (this.queue.length >= this.queueCapacity) {
      const retryAfter = Math.max(1, Math.ceil(this.queueTimeoutMs / 1000))
      throw new QueueCapacityExceededError(
        `Server is overloaded. Orchestration admission queue capacity (${this.queueCapacity}) exceeded.`,
        this.getState(),
        retryAfter
      )
    }

    // Place into queue
    return new Promise((resolve, reject) => {
      let timer = null
      const activeAbortController = new AbortController()

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (options.signal && onSignalAbort) {
          options.signal.removeEventListener('abort', onSignalAbort)
        }
      }

      let onSignalAbort = null
      if (options.signal) {
        onSignalAbort = () => {
          cleanup()
          const removed = this._removeFromQueue(id)
          if (removed) {
            reject(
              new QueueAbortError(
                'Orchestration request was aborted while waiting in admission queue',
                this.getState()
              )
            )
          }
        }
        options.signal.addEventListener('abort', onSignalAbort, { once: true })
      }

      if (this.queueTimeoutMs > 0 && Number.isFinite(this.queueTimeoutMs)) {
        timer = setTimeout(() => {
          cleanup()
          const removed = this._removeFromQueue(id)
          if (removed) {
            const retryAfter = Math.max(1, Math.ceil(this.queueTimeoutMs / 1000))
            reject(
              new QueueTimeoutError(
                `Orchestration request timed out after waiting ${this.queueTimeoutMs}ms in admission queue`,
                this.getState(),
                retryAfter
              )
            )
          }
        }, this.queueTimeoutMs)
        timer.unref?.()
      }

      const entry = {
        id,
        taskFn,
        resolve,
        reject,
        cleanup,
        activeAbortController,
        signal: options.signal,
        queuedAt: Date.now(),
        onAdmitted: options.onAdmitted,
      }

      this.queue.push(entry)
      options.onQueued?.({
        position: this.queue.length,
        queueLength: this.queue.length,
        activeCount: this.activeCount,
      })
    })
  }

  _removeFromQueue(id) {
    const index = this.queue.findIndex((e) => e.id === id)
    if (index !== -1) {
      const [removed] = this.queue.splice(index, 1)
      removed.cleanup?.()
      return removed
    }
    return null
  }

  _releaseSlot() {
    while (this.queue.length > 0) {
      const nextEntry = this.queue.shift()
      nextEntry.cleanup()

      if (nextEntry.signal?.aborted) {
        nextEntry.reject(
          new QueueAbortError(
            'Orchestration request was aborted while waiting in admission queue',
            this.getState()
          )
        )
        continue
      }

      let onExternalAbort = null
      if (nextEntry.signal) {
        onExternalAbort = () => nextEntry.activeAbortController.abort(nextEntry.signal.reason)
        nextEntry.signal.addEventListener('abort', onExternalAbort, { once: true })
      }

      this.activeEntries.set(nextEntry.id, {
        abortController: nextEntry.activeAbortController,
      })

      const waitDurationMs = Date.now() - nextEntry.queuedAt
      this._executeAdmittedEntry(nextEntry, onExternalAbort, waitDurationMs)
      return
    }

    this.activeCount = Math.max(0, this.activeCount - 1)
  }

  async _executeAdmittedEntry(entry, onExternalAbort, waitDurationMs) {
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (entry.signal && onExternalAbort) {
        entry.signal.removeEventListener('abort', onExternalAbort)
      }
      this.activeEntries.delete(entry.id)
      this._releaseSlot()
    }

    try {
      entry.onAdmitted?.({
        waitDurationMs,
        activeCount: this.activeCount,
        queued: true,
      })
      const result = await entry.taskFn({ signal: entry.activeAbortController.signal })
      entry.resolve(result)
    } catch (err) {
      entry.reject(err)
    } finally {
      release()
    }
  }

  cancel(id, reason = 'Request was cancelled') {
    const queued = this._removeFromQueue(id)
    if (queued) {
      queued.reject(
        new QueueAbortError(
          `Orchestration request cancelled while in queue: ${reason}`,
          this.getState()
        )
      )
      return { cancelled: true, phase: 'queued' }
    }

    const active = this.activeEntries.get(id)
    if (active) {
      active.abortController?.abort(reason)
      return { cancelled: true, phase: 'active' }
    }

    return { cancelled: false, phase: null }
  }

  clear(reason = 'Queue cleared') {
    while (this.queue.length > 0) {
      const entry = this.queue.shift()
      entry.cleanup()
      entry.reject(new QueueAbortError(reason, this.getState()))
    }
  }
}
