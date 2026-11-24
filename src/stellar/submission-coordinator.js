/**
 * Per-account submission coordinator.
 *
 * Every direct payment from the shared payer wallet loads the account, builds a
 * transaction at that account's next sequence number and submits it. Two runs
 * doing that at once load the same sequence, and one of them is rejected with
 * `tx_bad_seq`. This coordinator serialises submissions per source account, so
 * each one loads a fresh sequence after the previous one has finished, while
 * different accounts never wait for each other.
 *
 * Deployment boundary: the queues live in this process's memory. They coordinate
 * every caller inside ONE Node process. Two processes (or replicas) sharing one
 * payer account are not coordinated by this module; run a single instance per
 * payer account, or add an external lock before scaling out.
 *
 * Waiting is bounded in both directions: a lane holds at most `maxQueueDepth`
 * submissions (running plus waiting), and a submission waits at most `maxWaitMs`
 * before it starts. Either limit rejects with a `SubmissionQueueError` that says
 * why; a request is never silently dropped.
 */

export const QUEUE_FULL = 'queue_full'
export const QUEUE_WAIT_TIMEOUT = 'queue_wait_timeout'

export class SubmissionQueueError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SubmissionQueueError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.maxQueueDepth] max submissions per account, running + waiting
 * @param {number} [options.maxWaitMs] max time a submission waits for its turn
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {typeof setTimeout} [options.setTimeoutFn]
 * @param {typeof clearTimeout} [options.clearTimeoutFn]
 */
export function createSubmissionCoordinator({
  maxQueueDepth = 20,
  maxWaitMs = 30000,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  /** key -> { running: boolean, queue: Entry[] } */
  const lanes = new Map()
  /** key -> structured outcome of the most recent finished submission */
  const lastOutcomes = new Map()

  function pending(lane) {
    return lane.queue.length + (lane.running ? 1 : 0)
  }

  function pump(key) {
    const lane = lanes.get(key)
    if (!lane || lane.running) return
    const entry = lane.queue.shift()
    if (!entry) {
      lanes.delete(key)
      return
    }
    lane.running = true
    if (entry.timer) clearTimeoutFn(entry.timer)
    const waitedMs = now() - entry.enqueuedAt

    // The task is user code: a throw (sync or async) must still release the lane.
    Promise.resolve()
      .then(() => entry.task({ waitedMs, key }))
      .then(
        (value) => {
          lastOutcomes.set(key, { status: 'ok', finishedAt: now(), waitedMs })
          entry.resolve(value)
        },
        (err) => {
          lastOutcomes.set(key, {
            status: 'error',
            finishedAt: now(),
            waitedMs,
            error: err?.message || String(err),
            code: err?.code || null,
          })
          entry.reject(err)
        }
      )
      .finally(() => {
        lane.running = false
        pump(key)
      })
  }

  /**
   * Run `task` once every earlier submission for `key` has finished. The task
   * receives `{ waitedMs, key }`. Resolves or rejects with whatever the task does.
   */
  function run(key, task) {
    if (typeof key !== 'string' || !key) {
      return Promise.reject(new TypeError('submission coordinator needs an account key'))
    }
    let lane = lanes.get(key)
    if (!lane) {
      lane = { running: false, queue: [] }
      lanes.set(key, lane)
    }
    if (pending(lane) >= maxQueueDepth) {
      return Promise.reject(
        new SubmissionQueueError(
          QUEUE_FULL,
          `Submission queue for this account is full (${maxQueueDepth} pending)`,
          { depth: pending(lane), maxQueueDepth }
        )
      )
    }

    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, enqueuedAt: now(), timer: null }
      if (lane.running && Number.isFinite(maxWaitMs) && maxWaitMs >= 0) {
        entry.timer = setTimeoutFn(() => {
          const index = lane.queue.indexOf(entry)
          if (index === -1) return
          lane.queue.splice(index, 1)
          reject(
            new SubmissionQueueError(
              QUEUE_WAIT_TIMEOUT,
              `Waited ${maxWaitMs}ms for an earlier submission on this account to finish`,
              { waitedMs: now() - entry.enqueuedAt, maxWaitMs }
            )
          )
        }, maxWaitMs)
      }
      lane.queue.push(entry)
      pump(key)
    })
  }

  return {
    run,
    /** Submissions running or waiting for `key`. */
    depth(key) {
      const lane = lanes.get(key)
      return lane ? pending(lane) : 0
    },
    /** Outcome of the most recent finished submission for `key`, or null. */
    lastOutcome(key) {
      return lastOutcomes.get(key) || null
    },
  }
}
