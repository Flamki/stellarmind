import assert from 'node:assert'
import { setTimeout as delay } from 'node:timers/promises'
import {
  OrchestrationAdmissionQueue,
  QueueCapacityExceededError,
  QueueTimeoutError,
  QueueAbortError,
} from '../src/agents/orchestration-queue.js'

async function runTests() {
  console.log('--- Running OrchestrationAdmissionQueue Unit Tests ---')

  // 1. Concurrency limit is strictly bounded
  {
    console.log('  ✓ Bounded active concurrency (maxConcurrent: 2)')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 2,
      queueCapacity: 10,
      queueTimeoutMs: 5000,
    })

    let peakActive = 0
    let currentActive = 0
    const completed = []

    const makeTask = (id, durationMs) => async () => {
      currentActive++
      if (currentActive > peakActive) {
        peakActive = currentActive
      }
      assert(currentActive <= 2, `Active count (${currentActive}) exceeded maxConcurrent (2)`)
      await delay(durationMs)
      currentActive--
      completed.push(id)
      return { id, done: true }
    }

    const promises = [
      queue.run(makeTask(1, 50)),
      queue.run(makeTask(2, 50)),
      queue.run(makeTask(3, 50)),
      queue.run(makeTask(4, 50)),
      queue.run(makeTask(5, 50)),
    ]

    const results = await Promise.all(promises)
    assert.strictEqual(results.length, 5)
    assert.strictEqual(completed.length, 5)
    assert.strictEqual(peakActive, 2, 'Peak active should not exceed maxConcurrent')
    assert.strictEqual(queue.getState().active, 0)
    assert.strictEqual(queue.getState().queued, 0)
  }

  // 2. Queue capacity overflow throws QueueCapacityExceededError with retryAfter & state
  {
    console.log('  ✓ Queue capacity overflow rejection (503 / QUEUE_CAPACITY_EXCEEDED)')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 1,
      queueCapacity: 2,
      queueTimeoutMs: 10000,
    })

    let task1Resolve
    const task1Promise = new Promise((resolve) => {
      task1Resolve = resolve
    })

    // Task 1: active
    const p1 = queue.run(async () => task1Promise)
    assert.strictEqual(queue.getState().active, 1)
    assert.strictEqual(queue.getState().queued, 0)

    // Task 2: queued (slot 1 of 2)
    const p2 = queue.run(async () => 'task2')
    assert.strictEqual(queue.getState().active, 1)
    assert.strictEqual(queue.getState().queued, 1)

    // Task 3: queued (slot 2 of 2)
    const p3 = queue.run(async () => 'task3')
    assert.strictEqual(queue.getState().active, 1)
    assert.strictEqual(queue.getState().queued, 2)

    // Task 4: overflow -> must throw QueueCapacityExceededError immediately
    let threw = false
    try {
      await queue.run(async () => 'task4')
    } catch (err) {
      threw = true
      assert(err instanceof QueueCapacityExceededError)
      assert.strictEqual(err.status, 503)
      assert.strictEqual(err.code, 'QUEUE_CAPACITY_EXCEEDED')
      assert.strictEqual(err.expose, true)
      assert(err.retryAfter >= 1)
      assert.strictEqual(err.state.active, 1)
      assert.strictEqual(err.state.queued, 2)
      assert.strictEqual(err.state.queueCapacity, 2)
    }
    assert.strictEqual(threw, true, 'Task 4 should have been rejected immediately')

    // Release task 1 so queue can drain
    task1Resolve('task1')
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    assert.strictEqual(r1, 'task1')
    assert.strictEqual(r2, 'task2')
    assert.strictEqual(r3, 'task3')
    assert.strictEqual(queue.getState().active, 0)
    assert.strictEqual(queue.getState().queued, 0)
  }

  // 3. Queue wait deadline timeout throws QueueTimeoutError
  {
    console.log('  ✓ Queue wait deadline timeout (503 / QUEUE_TIMEOUT)')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 1,
      queueCapacity: 5,
      queueTimeoutMs: 60,
    })

    let task1Resolve
    const task1Promise = new Promise((resolve) => {
      task1Resolve = resolve
    })

    // Task 1 holds the only slot
    const p1 = queue.run(async () => task1Promise)

    // Task 2 queued with 60ms timeout
    let timedOut = false
    const p2 = queue
      .run(async () => 'task2')
      .catch((err) => {
        timedOut = true
        assert(err instanceof QueueTimeoutError)
        assert.strictEqual(err.status, 503)
        assert.strictEqual(err.code, 'QUEUE_TIMEOUT')
        assert.strictEqual(err.expose, true)
        assert(err.retryAfter >= 1)
        assert.strictEqual(err.state.maxConcurrent, 1)
      })

    // Wait for timeout to trigger
    await p2
    await delay(20)
    assert.strictEqual(timedOut, true, 'Task 2 should have timed out')
    assert.strictEqual(queue.getState().queued, 0, 'Timed out item should be removed from queue')

    // Complete task 1 and check capacity recovery
    task1Resolve('task1')
    await p1
    assert.strictEqual(queue.getState().active, 0)
    assert.strictEqual(queue.getState().queued, 0)

    // Now a subsequent task should run immediately without being blocked
    const subsequent = await queue.run(async () => 'recovered')
    assert.strictEqual(subsequent, 'recovered')
    assert.strictEqual(queue.getState().active, 0)
  }

  // 4. Pre-aborted signal rejection
  {
    console.log('  ✓ Pre-aborted signal rejection prior to admission')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 2,
      queueCapacity: 5,
    })

    const controller = new AbortController()
    controller.abort('pre-aborted')

    let threw = false
    try {
      await queue.run(async () => 'should not run', { signal: controller.signal })
    } catch (err) {
      threw = true
      assert(err instanceof QueueAbortError)
      assert.strictEqual(err.status, 499)
      assert.strictEqual(err.code, 'REQUEST_ABORTED')
    }
    assert.strictEqual(threw, true)
    assert.strictEqual(queue.getState().active, 0)
  }

  // 5. Cancellation while queued releases capacity exactly once (never acquired, 0 releases)
  {
    console.log('  ✓ Cancel while queued (releases capacity exactly once)')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 1,
      queueCapacity: 5,
    })

    let activeResolve
    const activeTask = new Promise((resolve) => {
      activeResolve = resolve
    })

    const pActive = queue.run(async () => activeTask, { id: 'active-1' })
    assert.strictEqual(queue.getState().active, 1)

    // Submit queued task
    let queuedRejected = false
    const pQueued = queue
      .run(async () => 'queued-result', { id: 'queued-1' })
      .catch((err) => {
        queuedRejected = true
        assert(err instanceof QueueAbortError)
        assert.strictEqual(err.code, 'REQUEST_ABORTED')
      })

    assert.strictEqual(queue.getState().queued, 1)
    assert.strictEqual(queue.getQueuePosition('queued-1'), 1)
    assert.deepStrictEqual(queue.getRunStatus('queued-1'), { status: 'queued', position: 1 })

    // Cancel queued task
    const cancelRes = queue.cancel('queued-1', 'Cancelled by user')
    assert.strictEqual(cancelRes.cancelled, true)
    assert.strictEqual(cancelRes.phase, 'queued')
    assert.strictEqual(queue.getState().queued, 0)

    await pQueued
    assert.strictEqual(queuedRejected, true)

    // Finish active task
    activeResolve('active-done')
    await pActive

    // Verify activeCount returned to 0 cleanly, no double releases or underflows
    assert.strictEqual(queue.getState().active, 0)
    assert.strictEqual(queue.getState().queued, 0)

    // Submit new task to verify queue accepts new work
    const nextResult = await queue.run(async () => 'next-success')
    assert.strictEqual(nextResult, 'next-success')
    assert.strictEqual(queue.getState().active, 0)
  }

  // 6. Cancellation of active task triggers abort signal and releases slot exactly once
  {
    console.log('  ✓ Cancel while active (signal aborts, releases slot exactly once)')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 1,
      queueCapacity: 5,
    })

    let abortReceived = false
    let taskFinished = false

    const pActive = queue
      .run(
        async ({ signal }) => {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              abortReceived = true
              const err = new Error('Task aborted')
              err.code = 'REQUEST_ABORTED'
              taskFinished = true
              reject(err)
            })
          })
        },
        { id: 'active-cancel' }
      )
      .catch((err) => err)

    assert.strictEqual(queue.getState().active, 1)
    assert.deepStrictEqual(queue.getRunStatus('active-cancel'), {
      status: 'active',
      position: null,
    })

    // Queue another task behind it
    const pNext = queue.run(async () => 'next-item-ran', { id: 'next-item' })
    assert.strictEqual(queue.getState().queued, 1)

    // Cancel active task
    const cancelRes = queue.cancel('active-cancel', 'Stop run')
    assert.strictEqual(cancelRes.cancelled, true)
    assert.strictEqual(cancelRes.phase, 'active')

    const err = await pActive
    assert.strictEqual(abortReceived, true)
    assert.strictEqual(taskFinished, true)
    assert.strictEqual(err.code, 'REQUEST_ABORTED')

    // Verify next queued task was admitted and completed
    const nextRes = await pNext
    assert.strictEqual(nextRes, 'next-item-ran')
    assert.strictEqual(queue.getState().active, 0)
    assert.strictEqual(queue.getState().queued, 0)
  }

  // 7. Task failure releases capacity exactly once
  {
    console.log('  ✓ Failure in task releases capacity exactly once')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 1,
      queueCapacity: 5,
    })

    let threw = false
    try {
      await queue.run(async () => {
        throw new Error('Simulated worker crash')
      })
    } catch (err) {
      threw = true
      assert.strictEqual(err.message, 'Simulated worker crash')
    }
    assert.strictEqual(threw, true)
    assert.strictEqual(queue.getState().active, 0)

    // Verify slot can be immediately used by another task
    const ok = await queue.run(async () => 'healthy')
    assert.strictEqual(ok, 'healthy')
    assert.strictEqual(queue.getState().active, 0)
  }

  // 8. Eventual capacity recovery after high burst with mixed outcomes
  {
    console.log('  ✓ Eventual capacity recovery after high burst with mixed outcomes')
    const queue = new OrchestrationAdmissionQueue({
      maxConcurrent: 3,
      queueCapacity: 5,
      queueTimeoutMs: 200,
    })

    const results = []
    const tasks = []

    for (let i = 0; i < 15; i++) {
      const p = queue
        .run(async () => {
          if (i === 2) throw new Error('Task 2 exploded')
          await delay(30)
          return `task-${i}`
        })
        .then(
          (res) => results.push({ id: i, status: 'fulfilled', res }),
          (err) => results.push({ id: i, status: 'rejected', code: err.code || err.name })
        )
      tasks.push(p)
    }

    await Promise.all(tasks)

    // Total tasks: 15. Capacity: 3 active + 5 queued = 8 max accepted at once. The rest rejected immediately.
    assert.strictEqual(results.length, 15)
    assert(results.some((r) => r.status === 'fulfilled'))
    assert(results.some((r) => r.status === 'rejected' && r.code === 'QUEUE_CAPACITY_EXCEEDED'))

    // All active and queued state must recover to 0
    assert.strictEqual(queue.getState().active, 0, 'Active count must recover to 0')
    assert.strictEqual(queue.getState().queued, 0, 'Queued count must recover to 0')

    // Confirm fresh task succeeds
    const fresh = await queue.run(async () => 'clean')
    assert.strictEqual(fresh, 'clean')
    assert.strictEqual(queue.getState().active, 0)
  }

  console.log('✅ All OrchestrationAdmissionQueue unit tests passed!')
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
