/**
 * Abort timed-out model requests and clean up retry timers (issue #149).
 */

import assert from 'node:assert'
import { anthropic, createAnthropicMessage } from '../src/agents/services.js'

async function runTests() {
  // 0. Anthropic SDK client has maxRetries set to 0 so application retry budget is authoritative
  assert.strictEqual(anthropic.maxRetries, 0)

  // Track active timers to assert zero residual timers after each scenario
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const activeTimers = new Set()

  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout(
      (...cbArgs) => {
        activeTimers.delete(id)
        fn(...cbArgs)
      },
      ms,
      ...args
    )
    activeTimers.add(id)
    return id
  }
  globalThis.clearTimeout = (id) => {
    activeTimers.delete(id)
    return realClearTimeout(id)
  }

  try {
    // 1. Fast success clears deadline timer immediately
    {
      let receivedMaxRetries = null
      const res = await createAnthropicMessage(
        { model: 'claude-haiku-4-5-20251001', max_tokens: 32, messages: [] },
        {
          timeoutMs: 5000,
          maxRetries: 2,
          baseDelayMs: 10,
          createFn: async (_payload, reqOpts) => {
            receivedMaxRetries = reqOpts.maxRetries
            assert.ok(reqOpts.signal instanceof AbortSignal)
            assert.strictEqual(reqOpts.signal.aborted, false)
            return { content: [{ type: 'text', text: 'fast-ok' }] }
          },
        }
      )
      assert.strictEqual(res.content[0].text, 'fast-ok')
      assert.strictEqual(receivedMaxRetries, 0)
      assert.strictEqual(activeTimers.size, 0, 'no residual timers after fast success')
    }

    // 2. Timed-out attempt is aborted before the next attempt begins (no overlapping attempts)
    {
      let inFlight = 0
      let maxInFlight = 0
      const attemptAborts = []
      let callCount = 0

      const res = await createAnthropicMessage(
        { model: 'claude-haiku-4-5-20251001', max_tokens: 32, messages: [] },
        {
          timeoutMs: 25,
          maxRetries: 2,
          baseDelayMs: 10,
          createFn: (_payload, { signal }) =>
            new Promise((resolve, reject) => {
              callCount += 1
              const thisCall = callCount
              inFlight += 1
              maxInFlight = Math.max(maxInFlight, inFlight)

              signal.addEventListener(
                'abort',
                () => {
                  inFlight -= 1
                  attemptAborts.push(thisCall)
                  reject(signal.reason || new Error('aborted'))
                },
                { once: true }
              )

              if (thisCall === 2) {
                inFlight -= 1
                resolve({ content: [{ type: 'text', text: 'recovered-on-2' }] })
              }
            }),
        }
      )

      assert.strictEqual(res.content[0].text, 'recovered-on-2')
      assert.strictEqual(callCount, 2)
      assert.deepStrictEqual(
        attemptAborts,
        [1],
        'first timed-out attempt must be aborted before attempt 2'
      )
      assert.strictEqual(maxInFlight, 1, 'attempts must never overlap')
      assert.strictEqual(activeTimers.size, 0, 'no residual timers after timeout recovery')
    }

    // 3. Retry exhaustion makes exactly 1 + maxRetries upstream attempts and cleans up all timers
    {
      let attempts = 0
      await assert.rejects(
        () =>
          createAnthropicMessage(
            { model: 'claude-haiku-4-5-20251001', max_tokens: 32, messages: [] },
            {
              timeoutMs: 20,
              maxRetries: 2,
              baseDelayMs: 5,
              createFn: (_payload, { signal }) =>
                new Promise((_, reject) => {
                  attempts += 1
                  signal.addEventListener(
                    'abort',
                    () => reject(signal.reason || new Error('aborted')),
                    { once: true }
                  )
                }),
            }
          ),
        (err) => {
          assert.ok(err.message.includes('retries exhausted after 2 retries'))
          assert.strictEqual(err.code, 'ANTHROPIC_TIMEOUT')
          return true
        }
      )
      assert.strictEqual(attempts, 3, '1 initial + 2 retries = 3 upstream attempts')
      assert.strictEqual(activeTimers.size, 0, 'no residual timers after retry exhaustion')
    }

    // 4. Caller cancellation during retry backoff delay aborts immediately and clears timers
    {
      const callerController = new AbortController()
      let attempts = 0

      await assert.rejects(
        () =>
          createAnthropicMessage(
            { model: 'claude-haiku-4-5-20251001', max_tokens: 32, messages: [] },
            {
              timeoutMs: 1000,
              maxRetries: 3,
              baseDelayMs: 5000,
              signal: callerController.signal,
              onRetryAttempt: () => {
                // Cancel while retry backoff sleep is about to start
                realSetTimeout(() => callerController.abort(), 10)
              },
              createFn: async () => {
                attempts += 1
                const err = new Error('overloaded')
                err.status = 503
                throw err
              },
            }
          ),
        (err) => {
          assert.strictEqual(err.code, 'REQUEST_ABORTED')
          return true
        }
      )
      assert.strictEqual(attempts, 1, 'should not start a second attempt after caller abort')
      assert.strictEqual(activeTimers.size, 0, 'no residual timers after caller cancellation')
    }

    // 5. Overall request deadline bounds retry delays
    {
      let attempts = 0
      let fakeNow = 1000
      await assert.rejects(
        () =>
          createAnthropicMessage(
            { model: 'claude-haiku-4-5-20251001', max_tokens: 32, messages: [] },
            {
              timeoutMs: 100,
              overallTimeoutMs: 50,
              maxRetries: 3,
              baseDelayMs: 60,
              now: () => fakeNow,
              createFn: async () => {
                attempts += 1
                fakeNow += 10
                const err = new Error('temporarily unavailable')
                err.status = 503
                throw err
              },
            }
          ),
        (err) => {
          assert.strictEqual(err.code, 'ANTHROPIC_TIMEOUT')
          assert.ok(err.message.includes('exceeds remaining overall deadline'))
          return true
        }
      )
      assert.strictEqual(attempts, 1)
      assert.strictEqual(activeTimers.size, 0)
    }
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  console.log('✓ All abort, timeout, and timer cleanup tests passed')
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
