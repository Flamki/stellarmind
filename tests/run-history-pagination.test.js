/**
 * Tests for stable cursor pagination, filters and list summaries on
 * GET /api/runs (issue #141).
 *
 * Covers:
 *  - deterministic ordering (createdAt desc, id desc) with tied timestamps
 *  - exhaustive, duplicate-free paging, with a cursor-less terminal page
 *  - concurrent insertion between page requests (newer and tied timestamps)
 *  - status and date filters, alone and composed with pagination
 *  - cursors bound to the filters they were issued for
 *  - structured 400s for invalid cursors, filters, limits and date ranges
 *  - lightweight list payloads vs. full detail retrieval
 *  - cursors that survive a process restart on the file-backed store
 *
 * Run: node tests/run-history-pagination.test.js
 */

import assert from 'node:assert'
import express from 'express'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { InMemoryRunHistoryStore, FileRunHistoryStore } from '../src/storage/run-history.js'
import { registerOrchestrationRoutes } from '../src/routes/orchestration-routes.js'
import { requestId, errorHandler } from '../src/middleware/errorHandler.js'
import {
  MAX_PAGE_SIZE,
  createFilterKey,
  decodeRunCursor,
  encodeRunCursor,
} from '../src/storage/run-query.js'

// ─── Tiny test harness ───────────────────────────────────────
const failures = []
let passed = 0

function test(name, fn) {
  return { name, fn }
}

async function runTests(tests) {
  for (const { name, fn } of tests) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (err) {
      failures.push({ name, err })
      console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
    }
  }
}

// ─── Fixtures & helpers ──────────────────────────────────────
const T0 = Date.parse('2026-10-01T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function fixtureRun({ id, createdAt, status = 'completed', ...rest }) {
  return {
    id,
    task: `task ${id}`,
    budget: 0.15,
    source: 'api',
    status,
    createdAt,
    updatedAt: createdAt,
    completedAt: status === 'running' ? null : createdAt,
    summary: null,
    plan: null,
    results: null,
    output: null,
    outputAvailable: false,
    error: null,
    events: [],
    txProofs: [],
    paymentAttempts: [],
    usage: null,
    ...rest,
  }
}

/** Orders fixtures the way the API contract promises. */
function expectedOrder(runs) {
  return [...runs].sort((a, b) => {
    const aMs = Date.parse(a.createdAt)
    const bMs = Date.parse(b.createdAt)
    if (aMs !== bMs) return bMs - aMs
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

async function createStore(runs = [], maxRuns = 500) {
  const store = new InMemoryRunHistoryStore(maxRuns)
  await store.init()
  // Stored in ascending-id order, i.e. deliberately NOT the order the API
  // promises: ordering must never depend on how records happen to be stored.
  store.runs = [...runs].sort((a, b) => a.id.localeCompare(b.id))
  return store
}

async function createTestServer(store) {
  const app = express()
  app.use(express.json())
  app.use(requestId)
  registerOrchestrationRoutes(app, {
    runHistoryStore: store,
    orchestrate: async () => ({}),
    broadcast: () => {},
  })
  app.use(errorHandler)

  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function getJson(baseUrl, pathAndQuery) {
  const res = await fetch(`${baseUrl}${pathAndQuery}`, { signal: AbortSignal.timeout(10000) })
  return { status: res.status, body: await res.json() }
}

function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach((entry) => search.append(key, entry))
    else search.set(key, value)
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** Pages through the whole list over HTTP, returning every page's body. */
async function collectAllPages(baseUrl, params = {}, maxPages = 100) {
  const pages = []
  let cursor
  for (let i = 0; i < maxPages; i += 1) {
    const { status, body } = await getJson(baseUrl, `/api/runs${qs({ ...params, cursor })}`)
    assert.strictEqual(status, 200, `page ${i + 1} should be 200, got ${status}`)
    pages.push(body)
    if (!body.nextCursor) return pages
    cursor = body.nextCursor
  }
  throw new Error(`pagination did not terminate within ${maxPages} pages`)
}

/** Follows `nextCursor` from a known cursor, failing instead of looping forever. */
async function collectFrom(baseUrl, params, startCursor, maxPages = 50) {
  const pages = []
  let cursor = startCursor
  for (let i = 0; cursor; i += 1) {
    assert.ok(i < maxPages, `pagination did not terminate within ${maxPages} pages`)
    const { status, body } = await getJson(baseUrl, `/api/runs${qs({ ...params, cursor })}`)
    assert.strictEqual(status, 200)
    pages.push(body)
    cursor = body.nextCursor
  }
  return pages
}

const idsOf = (pages) => pages.flatMap((page) => page.runs.map((run) => run.id))

/** 12 runs over 4 distinct instants, three runs per instant (heavy timestamp ties). */
function tiedFixture() {
  const runs = []
  for (let slot = 0; slot < 4; slot += 1) {
    for (const suffix of ['a', 'b', 'c']) {
      runs.push(
        fixtureRun({
          id: `run_${slot}_${suffix}`,
          createdAt: iso(T0 + slot * 60_000),
          status: ['completed', 'failed', 'running', 'interrupted'][
            (slot + suffix.charCodeAt(0)) % 4
          ],
        })
      )
    }
  }
  return runs
}

async function assertValidation(baseUrl, query, { field, code }) {
  const { status, body } = await getJson(baseUrl, query)
  assert.strictEqual(status, 400, `${query} should be rejected, got ${status}`)
  assert.strictEqual(body.code, 'INVALID_INPUT')
  assert.ok(body.requestId, 'error body should carry requestId')
  assert.ok(Array.isArray(body.details) && body.details.length > 0, 'details should be present')
  const match = body.details.find((detail) => detail.field === field && detail.code === code)
  assert.ok(
    match,
    `expected detail {field:${field}, code:${code}} for ${query}, got ${JSON.stringify(body.details)}`
  )
  assert.ok(typeof match.reason === 'string' && match.reason.length > 0, 'reason should be set')
  return body
}

// ─── Tests ───────────────────────────────────────────────────
console.log('\nrun history cursor pagination and filters (issue #141)')

const tests = [
  test('orders newest-first by createdAt with id as a deterministic tie-breaker', async () => {
    const runs = tiedFixture()
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const { body } = await getJson(baseUrl, '/api/runs?limit=100')
      assert.deepStrictEqual(
        body.runs.map((run) => run.id),
        expectedOrder(runs).map((run) => run.id)
      )
      assert.strictEqual(body.order, 'createdAt:desc,id:desc')
      assert.strictEqual(body.nextCursor, null)
      assert.strictEqual(body.hasMore, false)
    } finally {
      server.close()
    }
  }),

  test('pages through tied timestamps exactly once, for every page size', async () => {
    const runs = tiedFixture()
    const expected = expectedOrder(runs).map((run) => run.id)
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      for (const limit of [1, 2, 3, 4, 5, 7, 11, 12, 13]) {
        const pages = await collectAllPages(baseUrl, { limit })
        const ids = idsOf(pages)
        assert.deepStrictEqual(
          ids,
          expected,
          `limit=${limit} should return every run once, in order`
        )
        assert.strictEqual(new Set(ids).size, ids.length, `limit=${limit} returned duplicates`)
      }
    } finally {
      server.close()
    }
  }),

  test('terminal page has no cursor, and an exactly-full last page does not invent one', async () => {
    const runs = tiedFixture() // 12 runs
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const pages = await collectAllPages(baseUrl, { limit: 4 })
      assert.strictEqual(pages.length, 3)
      assert.ok(pages[0].nextCursor && pages[0].hasMore === true)
      assert.ok(pages[1].nextCursor && pages[1].hasMore === true)
      assert.strictEqual(pages[2].nextCursor, null, 'last page must not carry a cursor')
      assert.strictEqual(pages[2].hasMore, false)
      assert.strictEqual(pages[2].count, 4)

      const empty = await createStore([])
      const second = await createTestServer(empty)
      try {
        const { body } = await getJson(second.baseUrl, '/api/runs')
        assert.deepStrictEqual(
          {
            count: body.count,
            runs: body.runs,
            nextCursor: body.nextCursor,
            hasMore: body.hasMore,
          },
          { count: 0, runs: [], nextCursor: null, hasMore: false }
        )
      } finally {
        second.server.close()
      }
    } finally {
      server.close()
    }
  }),

  test('a run inserted between page requests never duplicates older entries', async () => {
    const runs = tiedFixture()
    const expected = expectedOrder(runs).map((run) => run.id)
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const first = (await getJson(baseUrl, '/api/runs?limit=5')).body
      assert.deepStrictEqual(idsOf([first]), expected.slice(0, 5))

      // Concurrent inserts: strictly newer runs (real createRun uses "now"),
      // plus fixtures that tie with the cursor's own timestamp.
      const newer1 = await store.createRun({ task: 'new 1', budget: 1 })
      const newer2 = await store.createRun({ task: 'new 2', budget: 1 })
      const cursorMs = decodeRunCursor(first.nextCursor).position.ms
      store.runs.push(
        fixtureRun({ id: 'run_tie_high', createdAt: iso(cursorMs) }),
        fixtureRun({ id: 'run_tie_low', createdAt: iso(cursorMs) })
      )

      const rest = await collectFrom(baseUrl, { limit: 5 }, first.nextCursor)
      const laterIds = idsOf(rest)
      const firstIds = idsOf([first])

      assert.strictEqual(
        new Set([...firstIds, ...laterIds]).size,
        firstIds.length + laterIds.length,
        'no id may appear on more than one page'
      )
      for (const id of expected.slice(5)) {
        assert.ok(laterIds.includes(id), `older run ${id} must still be returned exactly once`)
      }
      assert.ok(!laterIds.includes(newer1.id), 'newer run belongs before the cursor')
      assert.ok(!laterIds.includes(newer2.id), 'newer run belongs before the cursor')
    } finally {
      server.close()
    }
  }),

  test('inserting at the head and trimming the tail keeps paging consistent', async () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      fixtureRun({ id: `run_${String(i).padStart(2, '0')}`, createdAt: iso(T0 + i * 1000) })
    )
    const store = await createStore(runs, 30)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const first = (await getJson(baseUrl, '/api/runs?limit=10')).body
      // maxRuns=30 means each createRun evicts the oldest run.
      await store.createRun({ task: 'newcomer', budget: 1 })
      const second = (
        await getJson(baseUrl, `/api/runs${qs({ limit: 10, cursor: first.nextCursor })}`)
      ).body
      const firstIds = idsOf([first])
      const secondIds = idsOf([second])
      assert.strictEqual(secondIds.filter((id) => firstIds.includes(id)).length, 0)
      assert.deepStrictEqual(
        secondIds,
        expectedOrder(runs)
          .map((run) => run.id)
          .slice(10, 20)
      )
    } finally {
      server.close()
    }
  }),

  test('status filter selects a single status or a union of statuses', async () => {
    const runs = tiedFixture()
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const failed = idsOf(await collectAllPages(baseUrl, { status: 'failed', limit: 2 }))
      assert.deepStrictEqual(
        failed,
        expectedOrder(runs)
          .filter((run) => run.status === 'failed')
          .map((run) => run.id)
      )

      for (const variant of [
        'failed,interrupted',
        ['failed', 'interrupted'],
        ' failed , failed,interrupted',
      ]) {
        const { body } = await getJson(baseUrl, `/api/runs${qs({ status: variant, limit: 100 })}`)
        assert.deepStrictEqual(
          body.runs.map((run) => run.id),
          expectedOrder(runs)
            .filter((run) => ['failed', 'interrupted'].includes(run.status))
            .map((run) => run.id)
        )
        assert.deepStrictEqual(body.filters.status, ['failed', 'interrupted'])
      }
    } finally {
      server.close()
    }
  }),

  test('date filters are inclusive, accept dates or offset date-times, and compose', async () => {
    const runs = tiedFixture() // instants at T0 + 0/1/2/3 minutes
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const inWindow = (fromMs, toMs) =>
        expectedOrder(runs)
          .filter((run) => {
            const ms = Date.parse(run.createdAt)
            return ms >= fromMs && ms <= toMs
          })
          .map((run) => run.id)

      // Exact instants are inclusive at both ends.
      let { body } = await getJson(
        baseUrl,
        `/api/runs${qs({ createdFrom: iso(T0 + 60_000), createdTo: iso(T0 + 120_000), limit: 100 })}`
      )
      assert.deepStrictEqual(
        body.runs.map((r) => r.id),
        inWindow(T0 + 60_000, T0 + 120_000)
      )
      assert.strictEqual(body.filters.createdFrom, iso(T0 + 60_000))
      assert.strictEqual(body.filters.createdTo, iso(T0 + 120_000))

      // Date-only: the whole UTC day on both ends.
      ;({ body } = await getJson(
        baseUrl,
        '/api/runs?createdFrom=2026-10-01&createdTo=2026-10-01&limit=100'
      ))
      assert.strictEqual(body.count, 12)
      assert.strictEqual(body.filters.createdFrom, '2026-10-01T00:00:00.000Z')
      assert.strictEqual(body.filters.createdTo, '2026-10-01T23:59:59.999Z')

      // Offset date-times normalise to the same instant.
      ;({ body } = await getJson(
        baseUrl,
        `/api/runs${qs({ createdFrom: '2026-10-01T05:31:00+05:30', limit: 100 })}`
      ))
      assert.strictEqual(body.filters.createdFrom, '2026-10-01T00:01:00.000Z')
      assert.deepStrictEqual(
        body.runs.map((r) => r.id),
        inWindow(T0 + 60_000, Infinity)
      )

      // Nothing in the window → empty terminal page, not an error.
      ;({ body } = await getJson(baseUrl, '/api/runs?createdFrom=2030-01-01'))
      assert.deepStrictEqual([body.count, body.nextCursor, body.hasMore], [0, null, false])
    } finally {
      server.close()
    }
  }),

  test('status and date filters compose consistently with pagination', async () => {
    const runs = tiedFixture()
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const fromMs = T0 + 60_000
      const toMs = T0 + 180_000
      const expected = expectedOrder(runs)
        .filter((run) => {
          const ms = Date.parse(run.createdAt)
          return ['completed', 'failed'].includes(run.status) && ms >= fromMs && ms <= toMs
        })
        .map((run) => run.id)
      assert.ok(expected.length > 2, 'fixture should produce a multi-page result')

      for (const limit of [1, 2, 3]) {
        const pages = await collectAllPages(baseUrl, {
          status: 'completed,failed',
          createdFrom: iso(fromMs),
          createdTo: iso(toMs),
          limit,
        })
        assert.deepStrictEqual(idsOf(pages), expected, `limit=${limit}`)
        for (const page of pages) {
          assert.deepStrictEqual(page.filters.status, ['completed', 'failed'])
        }
      }

      // Paged-and-filtered equals filtered-in-one-shot.
      const oneShot = (
        await getJson(
          baseUrl,
          `/api/runs${qs({ status: 'completed,failed', createdFrom: iso(fromMs), createdTo: iso(toMs), limit: 100 })}`
        )
      ).body
      assert.deepStrictEqual(
        oneShot.runs.map((run) => run.id),
        expected
      )
    } finally {
      server.close()
    }
  }),

  test('a cursor is bound to the filters it was issued for', async () => {
    const store = await createStore(tiedFixture())
    const { server, baseUrl } = await createTestServer(store)
    try {
      const page = (await getJson(baseUrl, '/api/runs?status=completed,failed&limit=1')).body
      assert.ok(page.nextCursor)

      // Equivalent filter spellings share a cursor…
      const ok = await getJson(
        baseUrl,
        `/api/runs${qs({ status: ['failed', 'completed'], limit: 1, cursor: page.nextCursor })}`
      )
      assert.strictEqual(ok.status, 200)

      // …but different filters do not.
      await assertValidation(
        baseUrl,
        `/api/runs${qs({ status: 'completed', cursor: page.nextCursor })}`,
        { field: 'cursor', code: 'CURSOR_FILTER_MISMATCH' }
      )
      await assertValidation(baseUrl, `/api/runs${qs({ cursor: page.nextCursor })}`, {
        field: 'cursor',
        code: 'CURSOR_FILTER_MISMATCH',
      })
      await assertValidation(
        baseUrl,
        `/api/runs${qs({ status: 'completed,failed', createdFrom: '2026-10-01', cursor: page.nextCursor })}`,
        { field: 'cursor', code: 'CURSOR_FILTER_MISMATCH' }
      )
    } finally {
      server.close()
    }
  }),

  test('invalid cursors return structured validation errors', async () => {
    const store = await createStore(tiedFixture())
    const { server, baseUrl } = await createTestServer(store)
    try {
      const filterKey = createFilterKey({})
      const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const good = encodeRunCursor({ ms: T0, id: 'run_x' }, filterKey)

      const badCursors = {
        garbage: 'not-a-cursor',
        'not base64url': 'abc$%^',
        'non-canonical padding': `${good}=`,
        'not JSON': Buffer.from('hello').toString('base64url'),
        'JSON array': b64([1, 2, 3]),
        'wrong version': b64({ v: 2, c: T0, i: 'run_x', f: filterKey }),
        'missing field': b64({ v: 1, c: T0, i: 'run_x' }),
        'extra field': b64({ v: 1, c: T0, i: 'run_x', f: filterKey, x: 1 }),
        'non-integer timestamp': b64({ v: 1, c: 'yesterday', i: 'run_x', f: filterKey }),
        'fractional timestamp': b64({ v: 1, c: 1.5, i: 'run_x', f: filterKey }),
        'empty id': b64({ v: 1, c: T0, i: '', f: filterKey }),
        'bad filter key': b64({ v: 1, c: T0, i: 'run_x', f: 'ZZZ' }),
        'too long': 'A'.repeat(600),
      }

      for (const [label, cursor] of Object.entries(badCursors)) {
        const body = await assertValidation(baseUrl, `/api/runs${qs({ cursor })}`, {
          field: 'cursor',
          code: 'INVALID_CURSOR',
        })
        const detail = body.details.find((entry) => entry.field === 'cursor')
        assert.ok(detail.received.length <= 100, `${label}: echoed value must be bounded`)
      }

      await assertValidation(baseUrl, '/api/runs?cursor=', {
        field: 'cursor',
        code: 'INVALID_VALUE',
      })
      await assertValidation(baseUrl, `/api/runs?cursor=${good}&cursor=${good}`, {
        field: 'cursor',
        code: 'DUPLICATE_PARAMETER',
      })

      // A well-formed cursor for the default filters is accepted, even if it
      // points past the end of the data.
      const past = await getJson(baseUrl, `/api/runs${qs({ cursor: good })}`)
      assert.strictEqual(past.status, 200)
    } finally {
      server.close()
    }
  }),

  test('invalid filter, limit and date values return structured validation errors', async () => {
    const store = await createStore(tiedFixture())
    const { server, baseUrl } = await createTestServer(store)
    try {
      await assertValidation(baseUrl, '/api/runs?status=done', {
        field: 'status',
        code: 'INVALID_STATUS',
      })
      await assertValidation(baseUrl, '/api/runs?status=Completed', {
        field: 'status',
        code: 'INVALID_STATUS',
      })
      await assertValidation(baseUrl, '/api/runs?status=completed,,failed', {
        field: 'status',
        code: 'INVALID_STATUS',
      })
      await assertValidation(baseUrl, '/api/runs?status=', {
        field: 'status',
        code: 'INVALID_STATUS',
      })

      for (const limit of ['0', '-1', 'abc', '1.5', '10x', '']) {
        await assertValidation(baseUrl, `/api/runs${qs({ limit })}`, {
          field: 'limit',
          code: limit === '' ? 'INVALID_VALUE' : 'INVALID_LIMIT',
        })
      }
      await assertValidation(baseUrl, '/api/runs?limit=1&limit=2', {
        field: 'limit',
        code: 'DUPLICATE_PARAMETER',
      })

      for (const [name, value] of [
        ['createdFrom', 'yesterday'],
        ['createdFrom', '2026-02-30'],
        ['createdFrom', '2026-13-01'],
        ['createdFrom', '2026-10-01T10:00:00'], // no offset: ambiguous
        ['createdFrom', '2026-10-01T25:00:00Z'],
        ['createdTo', '1969-12-31'],
        ['createdTo', '1700000000000'],
        ['createdTo', '2026-10-01T10:00:00+24:00'],
      ]) {
        await assertValidation(baseUrl, `/api/runs${qs({ [name]: value })}`, {
          field: name,
          code: 'INVALID_DATE',
        })
      }

      await assertValidation(baseUrl, '/api/runs?createdFrom=2026-10-05&createdTo=2026-10-01', {
        field: 'createdFrom',
        code: 'INVALID_DATE_RANGE',
      })

      // All problems are reported together.
      const { body } = await getJson(baseUrl, '/api/runs?limit=0&status=nope&createdFrom=bad')
      assert.deepStrictEqual(body.details.map((detail) => detail.field).sort(), [
        'createdFrom',
        'limit',
        'status',
      ])
    } finally {
      server.close()
    }
  }),

  test('limit defaults to 20 and clamps above the maximum', async () => {
    const runs = Array.from({ length: 130 }, (_, i) =>
      fixtureRun({ id: `run_${String(i).padStart(3, '0')}`, createdAt: iso(T0 + i * 1000) })
    )
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      let { body } = await getJson(baseUrl, '/api/runs')
      assert.strictEqual(body.limit, 20)
      assert.strictEqual(body.count, 20)
      assert.strictEqual(body.hasMore, true)
      ;({ body } = await getJson(baseUrl, '/api/runs?limit=100000'))
      assert.strictEqual(body.limit, MAX_PAGE_SIZE)
      assert.strictEqual(body.count, MAX_PAGE_SIZE)
    } finally {
      server.close()
    }
  }),

  test('list items are lightweight summaries; detail retrieval returns the full record', async () => {
    const bigEvents = Array.from({ length: 200 }, (_, i) => ({
      type: 'agent_result',
      timestamp: iso(T0 + i),
      agent: 'research-bot',
      reason: 'x'.repeat(200),
    }))
    const bigOutput = Array.from({ length: 50 }, (_, i) => ({
      agent: `bot-${i}`,
      result: 'y'.repeat(2000),
    }))
    const runs = Array.from({ length: 25 }, (_, i) =>
      fixtureRun({
        id: `run_${String(i).padStart(2, '0')}`,
        createdAt: iso(T0 + i * 1000),
        events: bigEvents,
        results: bigOutput,
        output: bigOutput,
        outputAvailable: true,
        plan: { subtasks: bigOutput },
        txProofs: [{ method: 'x402', txHash: 'abc', explorerUrl: 'https://example.test' }],
        summary: { totalSpent: '0.1000', quotedTotal: '0.1000', txCount: 3, elapsed: '4s' },
      })
    )
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const listRes = await fetch(`${baseUrl}/api/runs?limit=20`)
      const listText = await listRes.text()
      const list = JSON.parse(listText)

      for (const item of list.runs) {
        for (const heavy of [
          'events',
          'results',
          'output',
          'plan',
          'result',
          'txProofs',
          'usage',
        ]) {
          assert.ok(!(heavy in item), `summary must not include "${heavy}"`)
        }
        assert.strictEqual(item.eventCount, 200)
        assert.strictEqual(item.outputAvailable, true)
        assert.strictEqual(item.totals.totalSpent, '0.1000')
        assert.strictEqual(item.totals.txCount, 3)
        assert.strictEqual(item.runUrl, `/api/runs/${item.id}`)
      }

      const detailText = await (await fetch(`${baseUrl}/api/runs/${list.runs[0].id}`)).text()
      const detail = JSON.parse(detailText)
      assert.strictEqual(detail.events.length, 200)
      assert.strictEqual(detail.output.length, 50)

      // 20 summaries must cost far less than a single full record.
      assert.ok(
        listText.length < detailText.length,
        `list page (${listText.length} B) should be smaller than one detail (${detailText.length} B)`
      )
      assert.ok(listText.length < 20_000, `list page was ${listText.length} B`)
    } finally {
      server.close()
    }
  }),

  test('summaries expose failure and interruption reasons without unbounded fields', async () => {
    const runs = [
      fixtureRun({
        id: 'run_failed',
        createdAt: iso(T0 + 2000),
        status: 'failed',
        error: { code: 'EXECUTION_FAILED', message: 'z'.repeat(5000) },
      }),
      fixtureRun({
        id: 'run_interrupted',
        createdAt: iso(T0 + 1000),
        status: 'interrupted',
        interruptedAt: iso(T0 + 1500),
        interruptedReason: 'server_restart',
      }),
    ]
    const store = await createStore(runs)
    const { server, baseUrl } = await createTestServer(store)
    try {
      const { body } = await getJson(baseUrl, '/api/runs')
      const [failed, interrupted] = body.runs
      assert.strictEqual(failed.error.code, 'EXECUTION_FAILED')
      assert.strictEqual(failed.error.message.length, 500)
      assert.strictEqual(failed.outputAvailable, false)
      assert.strictEqual(interrupted.interruptedReason, 'server_restart')
      assert.strictEqual(interrupted.error, null)
    } finally {
      server.close()
    }
  }),

  test('legacy runs without createdAt sort last and stay pageable', async () => {
    const dated = [
      fixtureRun({ id: 'run_new', createdAt: iso(T0 + 2000) }),
      fixtureRun({ id: 'run_old', createdAt: iso(T0 + 1000) }),
    ]
    const legacy = [
      fixtureRun({ id: 'run_legacy_a', createdAt: undefined }),
      fixtureRun({ id: 'run_legacy_b', createdAt: undefined }),
    ]
    const store = await createStore([...dated, ...legacy])
    const { server, baseUrl } = await createTestServer(store)
    try {
      const ids = idsOf(await collectAllPages(baseUrl, { limit: 1 }))
      assert.deepStrictEqual(ids, ['run_new', 'run_old', 'run_legacy_b', 'run_legacy_a'])

      const windowed = (await getJson(baseUrl, '/api/runs?createdFrom=2020-01-01')).body
      assert.deepStrictEqual(
        windowed.runs.map((run) => run.id),
        ['run_new', 'run_old'],
        'undated runs never satisfy a date window'
      )
    } finally {
      server.close()
    }
  }),

  test('GET /api/runs/pending-payments still resolves ahead of /api/runs/:id', async () => {
    const store = await createStore(tiedFixture())
    const { server, baseUrl } = await createTestServer(store)
    try {
      const { status, body } = await getJson(baseUrl, '/api/runs/pending-payments')
      assert.strictEqual(status, 200)
      assert.strictEqual(body.count, 0)
    } finally {
      server.close()
    }
  }),

  test('cursors stay valid across a restart of the file-backed store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-history-pagination-'))
    const file = path.join(dir, 'runs.json')
    try {
      const writer = new FileRunHistoryStore(file, 200)
      await writer.init()
      for (let i = 0; i < 7; i += 1) {
        await writer.createRun({ task: `persisted ${i}`, budget: 1 })
      }
      await writer.flush()

      const before = await createTestServer(writer)
      let cursor
      let firstIds
      try {
        const { body } = await getJson(before.baseUrl, '/api/runs?limit=3')
        cursor = body.nextCursor
        firstIds = idsOf([body])
        assert.ok(cursor)
      } finally {
        before.server.close()
      }

      // "Restart": a brand-new store instance reading the same file.
      const reader = new FileRunHistoryStore(file, 200)
      await reader.init()
      const after = await createTestServer(reader)
      try {
        const rest = await collectFrom(after.baseUrl, { limit: 3 }, cursor)
        const all = [...firstIds, ...idsOf(rest)]
        assert.strictEqual(all.length, 7)
        assert.strictEqual(new Set(all).size, 7)
      } finally {
        after.server.close()
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }),

  test('listRecent remains available for existing callers', async () => {
    const runs = tiedFixture()
    const store = await createStore(runs)
    const recent = await store.listRecent(3)
    assert.strictEqual(recent.length, 3)
    assert.ok(Array.isArray(recent[0].events), 'listRecent still returns full records')
  }),
]

await runTests(tests)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
