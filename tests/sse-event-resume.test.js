/**
 * Focused tests for issue #162:
 * Add ordered SSE event IDs and resume delivery from Last-Event-ID.
 *
 * Covers:
 *  1. Versioned event envelope with runId, stepId, sequence/event ID, and persisted delivery fields
 *  2. Stable event IDs and ordered delivery within a run (live SSE frames carry `id:` and `data:`)
 *  3. Mid-run disconnect and reconnect (`Last-Event-ID` header and `lastEventId` query param)
 *     replaying missed events strictly before new live events
 *  4. Client-side deduplication of replayed events in `public/assets/js/sse.js`
 *  5. Bounded replay window eviction and explicit `resync_required` instruction using `/api/runs/:id`
 *
 * Run: node tests/sse-event-resume.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApp, formatSSEFrame } from '../src/app.js'
import { pricingConfig } from '../src/pricing.config.js'
import {
  InMemoryRunHistoryStore,
  FileRunHistoryStore,
  EVENT_ENVELOPE_VERSION,
  formatEventId,
  parseEventId,
  createEventEnvelope,
} from '../src/storage/run-history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const nativeFetch = globalThis.fetch

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

function createTestConfig(overrides = {}) {
  return {
    anthropicApiKey: '',
    serverAddress: '',
    facilitatorUrl: 'https://www.x402.org/facilitator',
    network: 'stellar:testnet',
    runHistoryStorage: 'memory',
    runHistoryFile: null,
    runHistoryMaxRuns: 50,
    sseReplayWindowSize: 10,
    orchestrationQueue: {
      maxConcurrent: 2,
      queueCapacity: 10,
      queueTimeoutMs: 5000,
    },
    ...overrides,
  }
}

async function startTestApp({ replayWindowSize = 10, store } = {}) {
  const runHistoryStore = store || new InMemoryRunHistoryStore(50, { replayWindowSize })
  await runHistoryStore.init()
  const config = createTestConfig({ sseReplayWindowSize: replayWindowSize })
  const { app, close, broadcast, resolveStreamReplay } = createApp({
    config,
    pricingConfig,
    runHistoryStore,
    replayWindowSize,
  })
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    app,
    server,
    baseUrl,
    runHistoryStore,
    broadcast,
    resolveStreamReplay,
    async shutdown() {
      close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Opens an SSE connection to `/api/events` and collects parsed frames (`{ id, data }`).
 */
function openSSEStream(baseUrl, { lastEventIdHeader, lastEventIdQuery } = {}) {
  const frames = []
  const waiters = []
  let buffer = ''

  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(frames)) {
        const w = waiters.splice(i, 1)[0]
        w.resolve(frames.slice())
      }
    }
  }

  const parseChunk = (chunk) => {
    buffer += chunk
    let sepIdx
    while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
      const rawBlock = buffer.slice(0, sepIdx)
      buffer = buffer.slice(sepIdx + 2)
      let frameId = null
      const dataLines = []
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('id:')) {
          frameId = line.slice(3).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        }
      }
      if (dataLines.length > 0) {
        const parsedData = JSON.parse(dataLines.join('\n'))
        frames.push({ id: frameId, data: parsedData })
      }
    }
    notify()
  }

  const query = lastEventIdQuery ? `?lastEventId=${encodeURIComponent(lastEventIdQuery)}` : ''
  const targetUrl = new URL(`${baseUrl}/api/events${query}`)
  const headers = {}
  if (lastEventIdHeader) {
    headers['Last-Event-ID'] = lastEventIdHeader
  }

  let req
  const connectedPromise = new Promise((resolve, reject) => {
    req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: 'GET',
        headers,
      },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', parseChunk)
        resolve(res)
      }
    )
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err)
    })
    req.end()
  })

  return {
    frames,
    connectedPromise,
    waitForFrames(predicate, timeoutMs = 2000) {
      if (predicate(frames)) return Promise.resolve(frames.slice())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for SSE frames; received ${frames.length}: ${JSON.stringify(frames.map((f) => ({ id: f.id, type: f.data?.type })))}`
            )
          )
        }, timeoutMs)
        waiters.push({
          predicate,
          resolve: (res) => {
            clearTimeout(timer)
            resolve(res)
          },
        })
      })
    },
    disconnect() {
      try {
        req.destroy()
      } catch {}
    },
  }
}

async function withSSEClientModule(fn, { fetchImpl } = {}) {
  const sourcePath = path.join(__dirname, '..', 'public', 'assets', 'js', 'sse.js')
  const source = await fs.readFile(sourcePath, 'utf8')
  const exportList = [
    'connectSSE',
    'addFeed',
    'handleSSEMessage',
    'handleResyncRequired',
    'rememberEventId',
    'hasSeenEventId',
    'getLastEventId',
    'getLastResyncedRun',
    'resetSSEState',
    'buildSSEUrl',
  ].join(', ')
  const tempPath = path.join(__dirname, `.sse-under-test-${process.pid}-${Date.now()}.mjs`)
  await fs.writeFile(tempPath, `${source}\nexport { ${exportList} }\n`, 'utf8')

  const elements = new Map()
  const makeElement = (id) => ({
    id,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    prepend(child) {
      this.children.unshift(child)
    },
  })

  const liveEventsTracked = []
  const highlightedAgents = []
  const openedEventSources = []
  const originalFetch = globalThis.fetch

  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    createElement(tag) {
      return makeElement(tag)
    },
  }
  globalThis.trackLiveEvent = (ev) => liveEventsTracked.push(ev)
  globalThis.highlightAgent = (id) => highlightedAgents.push(id)
  globalThis.EventSource = class MockEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      this.onmessage = null
      this.onerror = null
      openedEventSources.push(this)
    }
    close() {
      this.closed = true
    }
  }
  if (fetchImpl) {
    globalThis.fetch = fetchImpl
  }

  try {
    const mod = await import(pathToFileURL(tempPath).href)
    mod.resetSSEState()
    await fn({
      sse: mod,
      elements,
      liveEventsTracked,
      highlightedAgents,
      openedEventSources,
    })
  } finally {
    await fs.unlink(tempPath).catch(() => {})
    delete globalThis.document
    delete globalThis.trackLiveEvent
    delete globalThis.highlightAgent
    delete globalThis.EventSource
    globalThis.fetch = originalFetch
  }
}

console.log('\nordered SSE event IDs and Last-Event-ID resume (issue #162)')

await test('versioned event envelope carries runId, stepId, ordered seq, and stable eventId', async () => {
  const store = new InMemoryRunHistoryStore(20, { replayWindowSize: 10 })
  const run = await store.createRun({ task: 'Envelope test', budget: 1.0, source: 'test' })

  const e1 = await store.appendEvent(run.id, {
    type: 'orchestrator_start',
    task: 'Envelope test',
    budget: 1.0,
  })
  const e2 = await store.appendEvent(run.id, {
    type: 'agent_call',
    stepId: 'step-0',
    agentId: 'research-bot',
    agent: 'Research Agent',
    cost: '0.01',
    paymentFlow: 'stellar-xlm-fallback',
  })
  const e3 = await store.appendEvent(run.id, {
    type: 'agent_response',
    stepId: 'step-0',
    agentId: 'research-bot',
    agent: 'Research Agent',
    resultPreview: 'Detailed research result',
    paidVia: 'stellar-xlm-direct',
  })

  assert.strictEqual(e1.envelopeVersion, EVENT_ENVELOPE_VERSION)
  assert.strictEqual(e1.runId, run.id)
  assert.strictEqual(e1.stepId, null)
  assert.strictEqual(e1.seq, 1)
  assert.strictEqual(e1.eventId, `${run.id}:1`)
  assert.strictEqual(e1.id, `${run.id}:1`)

  assert.strictEqual(e2.seq, 2)
  assert.strictEqual(e2.eventId, `${run.id}:2`)
  assert.strictEqual(e2.stepId, 'step-0')
  assert.strictEqual(e2.paymentFlow, 'stellar-xlm-fallback')

  assert.strictEqual(e3.seq, 3)
  assert.strictEqual(e3.eventId, `${run.id}:3`)
  assert.strictEqual(e3.stepId, 'step-0')
  assert.strictEqual(e3.resultPreview, 'Detailed research result')

  const parsed = parseEventId(e2.eventId)
  assert.deepStrictEqual(parsed, {
    raw: `${run.id}:2`,
    scope: run.id,
    runId: run.id,
    seq: 2,
  })

  const frame = formatSSEFrame(e2)
  assert.ok(frame.startsWith(`id: ${run.id}:2\ndata: `), 'SSE frame must include id: header line')
})

await test('FileRunHistoryStore persists delivery reproduction fields across restart', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-sse-162-'))
  const historyPath = path.join(tmpDir, 'run-history.json')

  try {
    const store1 = new FileRunHistoryStore(historyPath, 20, { replayWindowSize: 5 })
    await store1.init()
    const run = await store1.createRun({ task: 'Persist delivery test', budget: 0.5 })
    await store1.appendEvent(run.id, {
      type: 'orchestrator_start',
      task: 'Persist delivery test',
      budget: 0.5,
    })
    await store1.appendEvent(run.id, {
      type: 'orchestrator_plan',
      plan: 'Research -> Summary',
      subtaskCount: 2,
    })
    await store1.appendEvent(run.id, {
      type: 'agent_call',
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
      paymentFlow: 'x402-http402',
    })
    await store1.flush()

    // Reload from disk in a new store instance
    const store2 = new FileRunHistoryStore(historyPath, 20, { replayWindowSize: 5 })
    await store2.init()
    const loadedRun = await store2.getRun(run.id)

    assert.strictEqual(loadedRun.events.length, 3)
    assert.strictEqual(loadedRun.events[0].eventId, `${run.id}:1`)
    assert.strictEqual(loadedRun.events[0].task, 'Persist delivery test')
    assert.strictEqual(loadedRun.events[1].eventId, `${run.id}:2`)
    assert.strictEqual(loadedRun.events[1].plan, 'Research -> Summary')
    assert.strictEqual(loadedRun.events[1].subtaskCount, 2)
    assert.strictEqual(loadedRun.events[2].eventId, `${run.id}:3`)
    assert.strictEqual(loadedRun.events[2].stepId, 'step-0')
    assert.strictEqual(loadedRun.events[2].paymentFlow, 'x402-http402')

    const replay = await store2.getReplayAfter(`${run.id}:1`)
    assert.strictEqual(replay.status, 'ok')
    assert.strictEqual(replay.events.length, 2)
    assert.deepStrictEqual(
      replay.events.map((e) => e.eventId),
      [`${run.id}:2`, `${run.id}:3`]
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

await test('reconnecting with Last-Event-ID header replays missed events before new live events', async () => {
  const env = await startTestApp({ replayWindowSize: 10 })
  try {
    const run = await env.runHistoryStore.createRun({
      task: 'Mid-run disconnect test',
      budget: 1.0,
      source: 'test',
    })

    // 1. Connect initial SSE client
    const client1 = openSSEStream(env.baseUrl)
    await client1.waitForFrames((f) => f.some((item) => item.data.type === 'connected'))

    // 2. Emit first 2 events while client1 is connected
    env.broadcast({
      type: 'orchestrator_start',
      runId: run.id,
      task: 'Mid-run disconnect test',
      budget: 1.0,
    })
    env.broadcast({
      type: 'orchestrator_plan',
      runId: run.id,
      plan: 'Step 0 -> Step 1',
      subtaskCount: 2,
    })

    const initialFrames = await client1.waitForFrames(
      (f) => f.filter((item) => item.data.type !== 'connected').length >= 2
    )
    const liveInitial = initialFrames.filter((item) => item.data.type !== 'connected')
    assert.strictEqual(liveInitial[0].id, `${run.id}:1`)
    assert.strictEqual(liveInitial[1].id, `${run.id}:2`)
    const lastIdBeforeDisconnect = liveInitial[1].id

    // 3. Disconnect client1 mid-run
    client1.disconnect()

    // 4. Emit events 3 and 4 while client is disconnected
    env.broadcast({
      type: 'agent_call',
      runId: run.id,
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      cost: '0.01',
    })
    env.broadcast({
      type: 'agent_response',
      runId: run.id,
      stepId: 'step-0',
      agentId: 'research-bot',
      agent: 'Research Agent',
      resultPreview: 'Research findings',
    })

    // 5. Reconnect as client2 with Last-Event-ID header set to run:2
    const client2 = openSSEStream(env.baseUrl, { lastEventIdHeader: lastIdBeforeDisconnect })
    await client2.waitForFrames(
      (f) => f.filter((item) => item.data.type !== 'connected').length >= 2
    )

    // 6. Emit live event 5 after reconnection
    env.broadcast({
      type: 'orchestrator_complete',
      runId: run.id,
      quotedTotal: '0.0100',
      settledSummary: '0.01 USDC',
      agentsUsed: 1,
      elapsed: '25ms',
    })

    const allClient2Frames = await client2.waitForFrames(
      (f) => f.filter((item) => item.data.type !== 'connected').length >= 3
    )
    client2.disconnect()

    const delivered = allClient2Frames.filter((item) => item.data.type !== 'connected')
    assert.deepStrictEqual(
      delivered.map((f) => f.id),
      [`${run.id}:3`, `${run.id}:4`, `${run.id}:5`],
      'Missed events (3, 4) must be replayed in order before new live event (5)'
    )
    assert.strictEqual(delivered[0].data.replayed, true)
    assert.strictEqual(delivered[1].data.replayed, true)
    assert.strictEqual(delivered[0].data.stepId, 'step-0')
    assert.strictEqual(delivered[2].data.type, 'orchestrator_complete')
  } finally {
    await env.shutdown()
  }
})

await test('reconnecting with lastEventId query parameter replays missed events in order', async () => {
  const env = await startTestApp({ replayWindowSize: 10 })
  try {
    const run = await env.runHistoryStore.createRun({
      task: 'Query param resume test',
      budget: 1.0,
      source: 'test',
    })

    env.broadcast({ type: 'orchestrator_start', runId: run.id, task: 'Query param resume test' })
    env.broadcast({
      type: 'agent_call',
      runId: run.id,
      stepId: 'step-0',
      agentId: 'summary-bot',
      agent: 'Summary Agent',
      cost: '0.01',
    })
    env.broadcast({
      type: 'agent_response',
      runId: run.id,
      stepId: 'step-0',
      agentId: 'summary-bot',
      agent: 'Summary Agent',
      resultPreview: 'Summary text',
    })

    const client = openSSEStream(env.baseUrl, { lastEventIdQuery: `${run.id}:1` })
    const frames = await client.waitForFrames(
      (f) => f.filter((item) => item.data.type !== 'connected').length >= 2
    )
    client.disconnect()

    const replayed = frames.filter((item) => item.data.type !== 'connected')
    assert.deepStrictEqual(
      replayed.map((f) => f.id),
      [`${run.id}:2`, `${run.id}:3`]
    )
    assert.strictEqual(replayed[0].data.type, 'agent_call')
    assert.strictEqual(replayed[1].data.type, 'agent_response')
  } finally {
    await env.shutdown()
  }
})

await test('client SSE module deduplicates replayed events and resumes from lastSeenEventId', async () => {
  await withSSEClientModule(async ({ sse, elements, liveEventsTracked, openedEventSources }) => {
    const ev1 = createEventEnvelope(
      { type: 'orchestrator_start', task: 'Dedup test' },
      { runId: 'run_dedup', seq: 1, eventId: formatEventId('run_dedup', 1) }
    )
    const ev2 = createEventEnvelope(
      {
        type: 'agent_call',
        agent: 'Research Agent',
        agentId: 'research-bot',
        cost: '0.01',
      },
      {
        runId: 'run_dedup',
        stepId: 'step-0',
        seq: 2,
        eventId: formatEventId('run_dedup', 2),
      }
    )

    const first = sse.handleSSEMessage({
      lastEventId: ev1.eventId,
      data: JSON.stringify(ev1),
    })
    assert.strictEqual(first.status, 'delivered')
    assert.strictEqual(sse.getLastEventId(), 'run_dedup:1')

    // Replay of ev1 must be deduplicated
    const duplicate = sse.handleSSEMessage({
      lastEventId: ev1.eventId,
      data: JSON.stringify({ ...ev1, replayed: true }),
    })
    assert.strictEqual(duplicate.status, 'duplicate')
    assert.strictEqual(elements.get('feed').children.length, 1)
    assert.strictEqual(liveEventsTracked.length, 1)
    assert.strictEqual(elements.get('ev-cnt').textContent, '1 Events')

    // New event ev2 is delivered and advances cursor
    const second = sse.handleSSEMessage({
      lastEventId: ev2.eventId,
      data: JSON.stringify({ ...ev2, replayed: true }),
    })
    assert.strictEqual(second.status, 'delivered')
    assert.strictEqual(sse.getLastEventId(), 'run_dedup:2')
    assert.strictEqual(elements.get('feed').children.length, 2)
    assert.strictEqual(liveEventsTracked.length, 2)
    assert.strictEqual(elements.get('ev-cnt').textContent, '2 Events')

    // Reconnecting via connectSSE() uses lastSeenEventId in query URL
    sse.connectSSE()
    assert.strictEqual(openedEventSources.length, 1)
    assert.strictEqual(openedEventSources[0].url, '/api/events?lastEventId=run_dedup%3A2')
  })
})

await test('expired replay cursor emits explicit resync_required instruction and client resyncs from run detail', async () => {
  // Replay window bounded to 3 events
  const env = await startTestApp({ replayWindowSize: 3 })
  try {
    const run = await env.runHistoryStore.createRun({
      task: 'Bounded window overflow test',
      budget: 1.0,
      source: 'test',
    })

    // Emit 5 events into a window of size 3 -> events 1 and 2 are evicted; 3, 4, 5 remain
    env.broadcast({ type: 'orchestrator_start', runId: run.id, task: run.task })
    env.broadcast({ type: 'orchestrator_plan', runId: run.id, plan: 'Plan', subtaskCount: 2 })
    env.broadcast({
      type: 'agent_call',
      runId: run.id,
      stepId: 'step-0',
      agent: 'Research Agent',
      agentId: 'research-bot',
      cost: '0.01',
    })
    env.broadcast({
      type: 'agent_response',
      runId: run.id,
      stepId: 'step-0',
      agent: 'Research Agent',
      agentId: 'research-bot',
      resultPreview: 'Step 0 output',
    })
    env.broadcast({
      type: 'orchestrator_complete',
      runId: run.id,
      quotedTotal: '0.0100',
      settledSummary: '0.01 USDC',
      agentsUsed: 1,
      elapsed: '15ms',
    })

    // Reconnect with expired cursor `${run.id}:1` (evicted from window [3, 4, 5])
    const client = openSSEStream(env.baseUrl, { lastEventIdHeader: `${run.id}:1` })
    const frames = await client.waitForFrames(
      (f) => f.filter((item) => item.data.type !== 'connected').length >= 1
    )
    client.disconnect()

    const resyncFrame = frames.find((item) => item.data.type === 'resync_required')
    assert.ok(resyncFrame, 'Server must emit a resync_required event for an expired cursor')
    assert.strictEqual(resyncFrame.data.reason, 'replay_cursor_expired')
    assert.strictEqual(resyncFrame.data.lastEventId, `${run.id}:1`)
    assert.strictEqual(resyncFrame.data.runId, run.id)
    assert.strictEqual(resyncFrame.data.action, 'fetch_run_detail')
    assert.strictEqual(resyncFrame.data.runDetailUrl, `/api/runs/${run.id}`)
    assert.strictEqual(resyncFrame.data.earliestAvailableEventId, `${run.id}:3`)
    assert.strictEqual(resyncFrame.data.latestEventId, `${run.id}:5`)

    // Verify client handles resync_required by fetching /api/runs/:id
    const fetchedUrls = []
    await withSSEClientModule(
      async ({ sse, elements }) => {
        const msgResult = sse.handleSSEMessage({
          data: JSON.stringify(resyncFrame.data),
        })
        assert.strictEqual(msgResult.status, 'resync_required')
        const detail = await msgResult.resyncPromise
        assert.ok(detail, 'Client resync must fetch and return the run detail record')
        assert.strictEqual(detail.id, run.id)
        assert.deepStrictEqual(fetchedUrls, [`/api/runs/${run.id}`])
        assert.strictEqual(sse.getLastEventId(), `${run.id}:5`)
        // Feed should include the resync notice plus the retained events from run detail (3, 4, 5)
        assert.strictEqual(elements.get('feed').children.length, 4)
      },
      {
        fetchImpl: async (url) => {
          fetchedUrls.push(url)
          return nativeFetch(`${env.baseUrl}${url}`)
        },
      }
    )
  } finally {
    await env.shutdown()
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n${name}:\n${err.stack}`)
  }
  process.exit(1)
}
