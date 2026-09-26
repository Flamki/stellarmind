import assert from 'node:assert'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

process.env.SERVER_STELLAR_ADDRESS = process.env.SERVER_STELLAR_ADDRESS || 'GTEST_PLACEHOLDER'
process.env.RUN_HISTORY_STORAGE = 'memory'

const { app, admissionQueue } = await import('../src/server.js')

// Start server on an ephemeral port for testing
const server = http.createServer(app)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const baseUrl = `http://127.0.0.1:${port}`

function closeServer() {
  return new Promise((resolve) => server.close(resolve))
}

async function runIntegrationTests() {
  console.log('--- Running Orchestration Admission Queue Integration Tests ---')

  // Save original queue config to restore later
  const origMax = admissionQueue.maxConcurrent
  const origCap = admissionQueue.queueCapacity
  const origTimeout = admissionQueue.queueTimeoutMs

  try {
    // 1. GET /api/orchestrate/queue
    {
      console.log('  ✓ GET /api/orchestrate/queue returns queue state')
      const res = await fetch(`${baseUrl}/api/orchestrate/queue`)
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.strictEqual(typeof data.active, 'number')
      assert.strictEqual(typeof data.queued, 'number')
      assert.strictEqual(data.multiReplicaCoordination, false)
      assert(typeof data.note === 'string')
      assert.strictEqual(typeof data.retryAfterDefaultSec, 'number')
    }

    // 2. GET /api/status includes orchestrationQueue
    {
      console.log('  ✓ GET /api/status includes orchestrationQueue metadata')
      const res = await fetch(`${baseUrl}/api/status`)
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.ok(data.orchestrationQueue, 'Status response must contain orchestrationQueue')
      assert.strictEqual(data.orchestrationQueue.multiReplicaCoordination, false)
      assert.strictEqual(typeof data.orchestrationQueue.maxConcurrent, 'number')
      assert.strictEqual(typeof data.orchestrationQueue.queueCapacity, 'number')
    }

    // 3. Queue overflow returns HTTP 503 with Retry-After header and QUEUE_CAPACITY_EXCEEDED
    {
      console.log('  ✓ Queue overflow returns HTTP 503 with Retry-After header')
      admissionQueue.maxConcurrent = 1
      admissionQueue.queueCapacity = 1
      admissionQueue.queueTimeoutMs = 15000

      // Hold slot 1 with a stubbed run
      let releaseSlot1
      const slot1Promise = admissionQueue.run(
        () =>
          new Promise((resolve) => {
            releaseSlot1 = resolve
          })
      )
      assert.strictEqual(admissionQueue.activeCount, 1)

      // Request 1: will enter queue (1/1)
      const req1Promise = fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Integration test queued run 1', budget: 1.0 }),
      })

      // Allow request 1 to reach queue
      await delay(40)
      assert.strictEqual(admissionQueue.queueLength, 1)

      // Request 2: queue is full (1/1) -> immediately rejected with 503
      const res2 = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Integration test overflow run', budget: 1.0 }),
      })

      assert.strictEqual(res2.status, 503, 'Overflow request must return HTTP 503')
      assert.ok(res2.headers.get('retry-after'), 'Must include Retry-After header')
      const body2 = await res2.json()
      assert.strictEqual(body2.code, 'QUEUE_CAPACITY_EXCEEDED')
      assert.ok(body2.retryAfter)
      assert.ok(body2.state)
      assert.strictEqual(body2.state.active, 1)
      assert.strictEqual(body2.state.queued, 1)

      // Release slot 1 so queued request 1 can run and complete
      releaseSlot1('slot1-done')
      await slot1Promise
      const res1 = await req1Promise
      assert.strictEqual(res1.status, 200)

      assert.strictEqual(admissionQueue.activeCount, 0)
      assert.strictEqual(admissionQueue.queueLength, 0)
    }

    // 4. Queue wait deadline returns HTTP 503 with QUEUE_TIMEOUT
    {
      console.log('  ✓ Queue timeout returns HTTP 503 with QUEUE_TIMEOUT')
      admissionQueue.maxConcurrent = 1
      admissionQueue.queueCapacity = 5
      admissionQueue.queueTimeoutMs = 100 // 100ms timeout

      // Hold slot 1
      let releaseSlot1
      const slot1Promise = admissionQueue.run(
        () =>
          new Promise((resolve) => {
            releaseSlot1 = resolve
          })
      )

      // Submit HTTP request that will wait in queue past timeout
      const res2 = await fetch(`${baseUrl}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Integration test timeout run', budget: 1.0 }),
      })

      assert.strictEqual(res2.status, 503, 'Timed-out queued request must return HTTP 503')
      assert.ok(res2.headers.get('retry-after'), 'Must include Retry-After header')
      const body2 = await res2.json()
      assert.strictEqual(body2.code, 'QUEUE_TIMEOUT')
      assert.ok(body2.state)

      // Release slot 1
      releaseSlot1('slot1-done')
      await slot1Promise
      assert.strictEqual(admissionQueue.activeCount, 0)
      assert.strictEqual(admissionQueue.queueLength, 0)
    }

    // 5. Explicit cancellation endpoint POST /api/orchestrate/:id/cancel
    {
      console.log('  ✓ POST /api/orchestrate/:id/cancel cancels queued request')
      admissionQueue.maxConcurrent = 1
      admissionQueue.queueCapacity = 5
      admissionQueue.queueTimeoutMs = 30000

      // Hold active slot
      let releaseSlot1
      const slot1Promise = admissionQueue.run(
        () =>
          new Promise((resolve) => {
            releaseSlot1 = resolve
          })
      )

      // Start queued request with specific ID
      const queuedId = 'custom-test-cancel-id'
      let queuedRes = null

      const req2Promise = admissionQueue
        .run(async () => 'should-not-run', { id: queuedId })
        .catch((err) => {
          queuedRes = err
        })

      assert.strictEqual(admissionQueue.queueLength, 1)

      // Call cancel endpoint
      const cancelRes = await fetch(`${baseUrl}/api/orchestrate/${queuedId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test explicit cancel' }),
      })

      assert.strictEqual(cancelRes.status, 200)
      const cancelBody = await cancelRes.json()
      assert.strictEqual(cancelBody.success, true)
      assert.strictEqual(cancelBody.phase, 'queued')

      await req2Promise
      assert.ok(queuedRes)
      assert.strictEqual(queuedRes.code, 'REQUEST_ABORTED')
      assert.strictEqual(admissionQueue.queueLength, 0)

      // Release slot 1
      releaseSlot1('slot1-done')
      await slot1Promise
      assert.strictEqual(admissionQueue.activeCount, 0)
    }

    // 6. Client connection close cancels queued work
    {
      console.log('  ✓ Client connection close aborts queued work and frees capacity')
      admissionQueue.maxConcurrent = 1
      admissionQueue.queueCapacity = 5
      admissionQueue.queueTimeoutMs = 30000

      // Hold slot 1
      let releaseSlot1
      const slot1Promise = admissionQueue.run(
        () =>
          new Promise((resolve) => {
            releaseSlot1 = resolve
          })
      )

      // Now create an HTTP client request that enters queue and then immediately destroys connection
      const clientReq = http.request(
        `${baseUrl}/api/orchestrate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        () => {}
      )
      clientReq.on('error', () => {
        // Expected socket hangup
      })
      clientReq.write(JSON.stringify({ task: 'Disconnecting client', budget: 1.0 }))
      clientReq.end()

      await delay(50)
      assert.strictEqual(admissionQueue.queueLength, 1)

      // Client closes connection
      clientReq.destroy()

      // Give server time to handle client 'close'
      await delay(100)
      assert.strictEqual(
        admissionQueue.queueLength,
        0,
        'Disconnected request must be removed from queue'
      )

      releaseSlot1('slot1-done')
      await slot1Promise
      assert.strictEqual(admissionQueue.activeCount, 0)
      assert.strictEqual(admissionQueue.queueLength, 0)
    }

    console.log('✅ All Orchestration Admission Queue integration tests passed!')
    process.exit(0)
  } finally {
    // Restore original settings
    admissionQueue.maxConcurrent = origMax
    admissionQueue.queueCapacity = origCap
    admissionQueue.queueTimeoutMs = origTimeout
    await closeServer()
  }
}

runIntegrationTests().catch((err) => {
  console.error('❌ Integration test failed:', err)
  closeServer().finally(() => process.exit(1))
})
