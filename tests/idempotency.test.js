/**
 * Durable idempotency keys for orchestration submission (issue #132).
 *
 * Covers: concurrent matching submissions, response-loss retries, request
 * mismatches, store reloads, retention/expiry and the execute endpoint.
 *
 * Run: node tests/idempotency.test.js
 */
import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import { InMemoryRunHistoryStore, FileRunHistoryStore } from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'
import { activePlansStore } from '../src/agents/orchestrator.js'

const failures = []
let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

function countingOrchestrator(delayMs = 150) {
  const fn = async (task, budget, broadcast) => {
    fn.calls += 1
    broadcast({ type: 'orchestration_start', task })
    await delay(delayMs)
    return { task, budget, plan: {}, results: [{ agent: 'research-bot', result: 'ok' }] }
  }
  fn.calls = 0
  return fn
}

async function startServer(store, orchestrate) {
  const app = express()
  app.use(express.json())
  app.use(requestId)
  await store.init()
  registerOrchestrationRoutes(app, { runHistoryStore: store, orchestrate, broadcast: () => {} })
  app.use(errorHandler)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  }
}

const post = (baseUrl, p, body, headers = {}) =>
  fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })

const KEY = { 'Idempotency-Key': 'key-1' }

console.log('Idempotency keys (#132)')

await test('concurrent matching async submissions resolve to one run', async () => {
  const orch = countingOrchestrator()
  const store = new InMemoryRunHistoryStore(50)
  const { server, baseUrl } = await startServer(store, orch)
  try {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(baseUrl, '/api/orchestrate?async=true', { task: 'same', budget: 1 }, KEY)
      )
    )
    const bodies = await Promise.all(responses.map((r) => r.json()))
    assert.ok(responses.every((r) => r.status === 202))
    assert.strictEqual(new Set(bodies.map((b) => b.runId)).size, 1)
    assert.strictEqual(store.runs.length, 1)
    assert.strictEqual(responses.filter((r) => r.headers.get('x-idempotent-replay')).length, 9)
    await delay(300)
    assert.strictEqual(orch.calls, 1)
  } finally {
    server.close()
  }
})

await test('concurrent matching sync submissions share one execution', async () => {
  const orch = countingOrchestrator()
  const store = new InMemoryRunHistoryStore(50)
  const { server, baseUrl } = await startServer(store, orch)
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(baseUrl, '/api/orchestrate', { task: 'same', budget: 1 }, KEY)
      )
    )
    const bodies = await Promise.all(responses.map((r) => r.json()))
    assert.ok(
      responses.every((r) => r.status === 200),
      responses.map((r) => r.status).join()
    )
    assert.strictEqual(new Set(bodies.map((b) => b.runId)).size, 1)
    assert.strictEqual(orch.calls, 1)
    assert.strictEqual(store.runs.length, 1)
  } finally {
    server.close()
  }
})

await test('retry after a lost response returns the original run', async () => {
  const orch = countingOrchestrator()
  const store = new InMemoryRunHistoryStore(50)
  const { server, port, baseUrl } = await startServer(store, orch)
  try {
    const payload = JSON.stringify({ task: 'lost', budget: 1 })
    // Send the request, then drop the connection without reading the reply.
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `POST /api/orchestrate?async=true HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nIdempotency-Key: lost-1\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
        )
        sock.destroy()
        resolve()
      })
    })
    await delay(100)
    const res = await post(
      baseUrl,
      '/api/orchestrate?async=true',
      { task: 'lost', budget: 1 },
      { 'Idempotency-Key': 'lost-1' }
    )
    const body = await res.json()
    assert.strictEqual(res.headers.get('x-idempotent-replay'), 'true')
    assert.strictEqual(store.runs.length, 1)
    assert.strictEqual(body.runId, store.runs[0].id)
    await delay(300)
    assert.strictEqual(orch.calls, 1)
  } finally {
    server.close()
  }
})

await test('same key with a different task or budget is a 409 conflict', async () => {
  const orch = countingOrchestrator(10)
  const store = new InMemoryRunHistoryStore(50)
  const { server, baseUrl } = await startServer(store, orch)
  try {
    const first = await post(baseUrl, '/api/orchestrate?async=true', { task: 'a', budget: 1 }, KEY)
    const { runId } = await first.json()
    for (const body of [
      { task: 'b', budget: 1 },
      { task: 'a', budget: 2 },
    ]) {
      const res = await post(baseUrl, '/api/orchestrate?async=true', body, KEY)
      assert.strictEqual(res.status, 409)
      const err = await res.json()
      assert.strictEqual(err.error?.code ?? err.code, 'IDEMPOTENCY_KEY_CONFLICT')
      assert.ok(JSON.stringify(err).includes(runId))
    }
    // Surrounding whitespace in the task is normalized, so this still matches.
    const same = await post(
      baseUrl,
      '/api/orchestrate?async=true',
      { task: '  a ', budget: 1 },
      KEY
    )
    assert.strictEqual(same.status, 202)
    assert.strictEqual((await same.json()).runId, runId)
    assert.strictEqual(store.runs.length, 1)
  } finally {
    server.close()
  }
})

await test('a conflict is also detected between concurrent submissions', async () => {
  const orch = countingOrchestrator()
  const store = new InMemoryRunHistoryStore(50)
  const { server, baseUrl } = await startServer(store, orch)
  try {
    const [a, b] = await Promise.all([
      post(baseUrl, '/api/orchestrate?async=true', { task: 'a', budget: 1 }, KEY),
      post(baseUrl, '/api/orchestrate?async=true', { task: 'b', budget: 1 }, KEY),
    ])
    assert.deepStrictEqual([a.status, b.status].sort(), [202, 409])
    assert.strictEqual(store.runs.length, 1)
  } finally {
    server.close()
  }
})

await test('mappings survive a restart (store reload) and still detect mismatches', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idem-'))
  const file = path.join(dir, 'runs.json')
  const orch = countingOrchestrator(10)
  try {
    const store1 = new FileRunHistoryStore(file, 50)
    const s1 = await startServer(store1, orch)
    const first = await post(
      s1.baseUrl,
      '/api/orchestrate?async=true',
      { task: 'durable', budget: 1 },
      KEY
    )
    const { runId } = await first.json()
    await delay(100)
    await store1.flush()
    s1.server.close()

    const store2 = new FileRunHistoryStore(file, 50)
    const s2 = await startServer(store2, orch)
    try {
      const again = await post(
        s2.baseUrl,
        '/api/orchestrate?async=true',
        { task: 'durable', budget: 1 },
        KEY
      )
      assert.strictEqual(again.headers.get('x-idempotent-replay'), 'true')
      assert.strictEqual((await again.json()).runId, runId)
      const clash = await post(
        s2.baseUrl,
        '/api/orchestrate?async=true',
        { task: 'other', budget: 1 },
        KEY
      )
      assert.strictEqual(clash.status, 409)
      assert.strictEqual(orch.calls, 1)
    } finally {
      s2.server.close()
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

await test('the newest mapping survives a reload when the history is full', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idem-'))
  const file = path.join(dir, 'runs.json')
  const orch = countingOrchestrator(5)
  try {
    const store1 = new FileRunHistoryStore(file, 3)
    const s1 = await startServer(store1, orch)
    let lastRunId
    for (let i = 0; i < 5; i += 1) {
      const res = await post(
        s1.baseUrl,
        '/api/orchestrate?async=true',
        { task: `t${i}`, budget: 1 },
        { 'Idempotency-Key': `k${i}` }
      )
      lastRunId = (await res.json()).runId
    }
    await delay(100)
    await store1.flush()
    s1.server.close()
    const callsBefore = orch.calls

    const store2 = new FileRunHistoryStore(file, 3)
    const s2 = await startServer(store2, orch)
    try {
      const res = await post(
        s2.baseUrl,
        '/api/orchestrate?async=true',
        { task: 't4', budget: 1 },
        { 'Idempotency-Key': 'k4' }
      )
      assert.strictEqual((await res.json()).runId, lastRunId)
      await delay(50)
      assert.strictEqual(orch.calls, callsBefore)
    } finally {
      s2.server.close()
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

await test('a mapping is honored inside the retention window and expires after it', async () => {
  const orch = countingOrchestrator(5)
  const store = new InMemoryRunHistoryStore(50, { idempotencyTtlMs: 300 })
  const { server, baseUrl } = await startServer(store, orch)
  try {
    const first = await post(
      baseUrl,
      '/api/orchestrate?async=true',
      { task: 'ttl', budget: 1 },
      KEY
    )
    const { runId } = await first.json()
    const inside = await post(
      baseUrl,
      '/api/orchestrate?async=true',
      { task: 'ttl', budget: 1 },
      KEY
    )
    assert.strictEqual((await inside.json()).runId, runId)
    await delay(400)
    // After expiry the key may be reused, even with different parameters.
    const after = await post(
      baseUrl,
      '/api/orchestrate?async=true',
      { task: 'new work', budget: 2 },
      KEY
    )
    assert.strictEqual(after.status, 202)
    assert.notStrictEqual((await after.json()).runId, runId)
    await delay(100)
    assert.strictEqual(orch.calls, 2)
  } finally {
    server.close()
  }
})

await test('expired mappings are not restored from disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idem-'))
  const file = path.join(dir, 'runs.json')
  try {
    const store1 = new FileRunHistoryStore(file, 50, { idempotencyTtlMs: 200 })
    await store1.init()
    const run = await store1.createRun({
      task: 't',
      budget: 1,
      idempotencyKey: 'k',
      idempotencyFingerprint: 'f',
    })
    await store1.flush()
    await delay(300)
    const store2 = new FileRunHistoryStore(file, 50, { idempotencyTtlMs: 200 })
    await store2.init()
    assert.strictEqual(await store2.getIdempotencyRecord('k'), null)
    assert.ok(await store2.getRun(run.id), 'the run itself is kept')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

await test('concurrent execute submissions with one key create one run', async () => {
  const orch = countingOrchestrator(5)
  const store = new InMemoryRunHistoryStore(50)
  const { server, baseUrl } = await startServer(store, orch)
  try {
    const planId = 'plan_idem_test'
    activePlansStore.set(planId, {
      task: 'planned',
      budget: 1,
      steps: [],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(
          baseUrl,
          '/api/orchestrate/execute?async=true',
          { planId },
          { 'Idempotency-Key': 'exec-1' }
        )
      )
    )
    await Promise.all(responses.map((r) => r.text()))
    assert.strictEqual(store.runs.length, 1, `statuses: ${responses.map((r) => r.status).join()}`)
  } finally {
    activePlansStore.delete?.('plan_idem_test')
    server.close()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
