/**
 * Abortable model requests and one retry budget (issue #149).
 *
 * Uses fake timers and an abort-aware provider stub. Asserts, per attempt:
 *  - a timed-out attempt is signalled to abort BEFORE the next attempt starts
 *  - success, failure and cancellation leave no pending timers
 *  - real upstream attempts == 1 + maxRetries, and SDK retries are disabled
 *  - retry delays are cancellable and respect the overall request deadline
 *  - attempts never overlap
 *
 * Run: node tests/anthropic-abort-retry.test.js
 */

import assert from 'node:assert'
import { mock } from 'node:test'
import { createAnthropicMessage } from '../src/agents/services.js'

const failures = []
let passed = 0

/** Let queued promise continuations run (fake timers do not advance microtasks). */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/**
 * Provider stub. `script` is a list of behaviours, one per real attempt:
 *  'ok' | 'hang' (never settles on its own, abort-aware) | 'hang-ignore-abort'
 *  | 'fail-503' | 'fail-400'
 */
function makeProvider(script) {
  const state = { calls: 0, active: 0, maxActive: 0, aborted: [], options: [], events: [] }
  const client = {
    messages: {
      create(payload, opts) {
        const index = state.calls
        state.calls += 1
        state.active += 1
        state.maxActive = Math.max(state.maxActive, state.active)
        state.options.push(opts)
        state.events.push(`start:${index}`)
        const behaviour = script[index] ?? 'ok'
        const done = () => {
          state.active -= 1
        }
        return new Promise((resolve, reject) => {
          const signal = opts?.signal
          if (behaviour === 'ok') {
            done()
            resolve({ id: `msg-${index}`, content: [] })
          } else if (behaviour === 'fail-503') {
            done()
            const err = new Error('overloaded')
            err.status = 503
            reject(err)
          } else if (behaviour === 'fail-400') {
            done()
            const err = new Error('bad request')
            err.status = 400
            reject(err)
          } else if (behaviour === 'hang-ignore-abort') {
            signal?.addEventListener('abort', () => {
              state.aborted.push(index)
              state.events.push(`abort:${index}`)
              done()
            })
          } else {
            signal?.addEventListener('abort', () => {
              state.aborted.push(index)
              state.events.push(`abort:${index}`)
              done()
              reject(signal.reason)
            })
          }
        })
      },
    },
  }
  return { client, state }
}

/** Wrap the (mocked) timer globals so we can assert no timer is left pending. */
function trackTimers() {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const live = new Set()
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = realSet(() => {
      live.delete(handle)
      fn(...args)
    }, ms)
    live.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    live.delete(handle)
    realClear(handle)
  }
  return live
}

async function test(name, fn) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const live = trackTimers()
  try {
    await fn()
    await flush()
    assert.strictEqual(live.size, 0, `residual timers left pending: ${live.size}`)
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  ✗ ${name}\n      ${err.message}`)
  } finally {
    mock.timers.reset()
  }
}

const base = { timeoutMs: 1000, baseDelayMs: 100 }
const PAYLOAD = { model: 'm', max_tokens: 1, messages: [] }

console.log('\nanthropic abort + retry budget (#149)')

await test('fast success: one attempt, SDK retries disabled, no residual timers', async () => {
  const { client, state } = makeProvider(['ok'])
  const res = await createAnthropicMessage(PAYLOAD, { ...base, maxRetries: 2, client })
  assert.strictEqual(res.id, 'msg-0')
  assert.strictEqual(state.calls, 1)
  assert.strictEqual(state.options[0].maxRetries, 0, 'SDK-level retries must be disabled')
  assert.ok(state.options[0].signal instanceof AbortSignal)
  // Nothing may fire later: advancing past the deadline must not abort a finished attempt.
  mock.timers.tick(5000)
  assert.deepStrictEqual(state.aborted, [])
})

await test('hanging call: aborted at the deadline, then retried; attempts never overlap', async () => {
  const { client, state } = makeProvider(['hang', 'ok'])
  const promise = createAnthropicMessage(PAYLOAD, { ...base, maxRetries: 2, client })
  await flush()
  mock.timers.tick(1000) // attempt 0 times out
  await flush()
  mock.timers.tick(100) // backoff delay
  const res = await promise
  assert.strictEqual(res.id, 'msg-1')
  assert.deepStrictEqual(state.aborted, [0])
  assert.deepStrictEqual(state.events, ['start:0', 'abort:0', 'start:1'])
  assert.strictEqual(state.maxActive, 1, 'attempts must not overlap')
})

await test('provider that ignores the signal still times out and is aborted first', async () => {
  const { client, state } = makeProvider(['hang-ignore-abort', 'ok'])
  const promise = createAnthropicMessage(PAYLOAD, { ...base, maxRetries: 1, client })
  await flush()
  mock.timers.tick(1000)
  await flush()
  mock.timers.tick(100)
  const res = await promise
  assert.strictEqual(res.id, 'msg-1')
  assert.deepStrictEqual(state.events, ['start:0', 'abort:0', 'start:1'])
})

await test('retry exhaustion: real upstream attempts == 1 + maxRetries', async () => {
  const { client, state } = makeProvider(['fail-503', 'fail-503', 'fail-503', 'fail-503'])
  const promise = createAnthropicMessage(PAYLOAD, { ...base, maxRetries: 2, client })
  const settled = promise.then(
    () => null,
    (e) => e
  )
  await flush()
  mock.timers.tick(100)
  await flush()
  mock.timers.tick(200)
  const err = await settled
  assert.ok(err, 'must reject after exhausting retries')
  assert.match(err.message, /retries exhausted after 2 retries/)
  assert.strictEqual(state.calls, 3)
  assert.strictEqual(state.maxActive, 1)
})

await test('non-transient error: fails fast with a single attempt', async () => {
  const { client, state } = makeProvider(['fail-400', 'ok'])
  await assert.rejects(
    createAnthropicMessage(PAYLOAD, { ...base, maxRetries: 2, client }),
    /Non-transient/
  )
  assert.strictEqual(state.calls, 1)
  mock.timers.tick(5000)
  assert.deepStrictEqual(state.aborted, [])
})

await test('cancellation during an attempt aborts upstream and does not retry', async () => {
  const { client, state } = makeProvider(['hang', 'ok'])
  const controller = new AbortController()
  const promise = createAnthropicMessage(PAYLOAD, {
    ...base,
    maxRetries: 2,
    client,
    signal: controller.signal,
  })
  const settled = promise.then(
    () => null,
    (e) => e
  )
  await flush()
  controller.abort()
  const err = await settled
  assert.strictEqual(err.code, 'ANTHROPIC_ABORTED')
  assert.strictEqual(err.name, 'AbortError')
  assert.deepStrictEqual(state.aborted, [0])
  assert.strictEqual(state.calls, 1)
  mock.timers.tick(5000) // the deadline timer was cleared
  assert.deepStrictEqual(state.aborted, [0])
})

await test('cancellation during the retry delay cancels the sleep and starts nothing', async () => {
  const { client, state } = makeProvider(['fail-503', 'ok'])
  const controller = new AbortController()
  const promise = createAnthropicMessage(PAYLOAD, {
    ...base,
    baseDelayMs: 5000,
    maxRetries: 2,
    client,
    signal: controller.signal,
  })
  const settled = promise.then(
    () => null,
    (e) => e
  )
  await flush()
  controller.abort()
  const err = await settled
  assert.strictEqual(err.code, 'ANTHROPIC_ABORTED')
  mock.timers.tick(10000) // sleep timer was cleared: no second attempt may start
  await flush()
  assert.strictEqual(state.calls, 1)
})

await test('already-aborted signal makes no upstream call', async () => {
  const { client, state } = makeProvider(['ok'])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    createAnthropicMessage(PAYLOAD, { ...base, client, signal: controller.signal }),
    (e) => e.code === 'ANTHROPIC_ABORTED'
  )
  assert.strictEqual(state.calls, 0)
})

await test('overall deadline: a retry delay that cannot fit is not slept, request fails fast', async () => {
  const { client, state } = makeProvider(['fail-503', 'ok'])
  const err = await createAnthropicMessage(PAYLOAD, {
    ...base,
    baseDelayMs: 5000,
    maxRetries: 2,
    overallTimeoutMs: 2000,
    client,
  }).catch((e) => e)
  assert.strictEqual(err.code, 'ANTHROPIC_DEADLINE_EXCEEDED')
  assert.strictEqual(state.calls, 1)
})

await test('overall deadline cuts a hanging attempt short and is not retried', async () => {
  const { client, state } = makeProvider(['hang', 'ok'])
  const promise = createAnthropicMessage(PAYLOAD, {
    timeoutMs: 10000,
    baseDelayMs: 100,
    maxRetries: 3,
    overallTimeoutMs: 1500,
    client,
  })
  const settled = promise.then(
    () => null,
    (e) => e
  )
  await flush()
  mock.timers.tick(1500)
  const err = await settled
  assert.strictEqual(err.code, 'ANTHROPIC_DEADLINE_EXCEEDED')
  assert.deepStrictEqual(state.aborted, [0])
  assert.strictEqual(state.calls, 1)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.err.stack}`)
  process.exit(1)
}
