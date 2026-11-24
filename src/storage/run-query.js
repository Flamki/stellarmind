import crypto from 'node:crypto'

/**
 * Query helpers behind `GET /api/runs` (issue #141): deterministic ordering,
 * keyset ("cursor") pagination, status/date filtering and the lightweight
 * list projection.
 *
 * Everything here is pure — no I/O, no clock — so the same logic serves the
 * in-memory and file-backed stores and can be tested against fixtures.
 *
 * Ordering contract
 * -----------------
 * Runs are ordered newest-first by `createdAt`, with `id` (descending) as the
 * tie-breaker, so two runs created in the same millisecond still have one
 * fixed relative order. A cursor is the (createdAt, id) position of the last
 * run on a page, and the next page is "everything strictly older than that
 * position". Because the position is a value rather than an array offset:
 *
 *   - a run inserted between page requests is newer than the cursor, so it
 *     can never shift an older run onto a second page (no duplicates);
 *   - a run trimmed by the retention limit cannot make later runs skip.
 */

export const RUN_STATUSES = Object.freeze(['running', 'completed', 'failed', 'interrupted'])
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
export const RUN_LIST_ORDER = 'createdAt:desc,id:desc'

const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 512
const MAX_CURSOR_ID_LENGTH = 200
const MAX_SUMMARY_ERROR_MESSAGE_LENGTH = 500

export class InvalidCursorError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'InvalidCursorError'
    this.reason = reason
  }
}

/** Epoch milliseconds of a run's `createdAt`, or `null` if absent/unparseable. */
function createdAtMs(run) {
  const ms = Date.parse(run?.createdAt)
  return Number.isFinite(ms) ? ms : null
}

// Runs without a usable `createdAt` (legacy records) sort after every dated
// run, in a stable order among themselves (by id).
function msKey(ms) {
  return ms === null ? Number.NEGATIVE_INFINITY : ms
}

/** The (createdAt, id) sort position of a run. */
export function runPosition(run) {
  return { ms: createdAtMs(run), id: String(run?.id) }
}

/** Ascending comparison of two positions. */
function comparePositions(a, b) {
  const aMs = msKey(a.ms)
  const bMs = msKey(b.ms)
  if (aMs !== bMs) return aMs < bMs ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * Short, stable fingerprint of the active filters. It is embedded in cursors
 * so a cursor issued for one filter set cannot be replayed against another,
 * which would otherwise return a confusing, silently different sequence.
 */
export function createFilterKey({ statuses = [], createdFromMs = null, createdToMs = null } = {}) {
  const canonical = JSON.stringify({
    s: [...new Set(statuses)].sort(),
    f: createdFromMs,
    t: createdToMs,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/** Encodes a position into an opaque, URL-safe cursor token. */
export function encodeRunCursor(position, filterKey) {
  const payload = { v: CURSOR_VERSION, c: position.ms, i: position.id, f: filterKey }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decodes and strictly validates a cursor token.
 * @returns {{ position: { ms: number|null, id: string }, filterKey: string }}
 * @throws {InvalidCursorError} for anything that is not a cursor this server issued.
 */
export function decodeRunCursor(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidCursorError('Cursor must be a non-empty string')
  }
  if (token.length > MAX_CURSOR_LENGTH) {
    throw new InvalidCursorError(`Cursor must be no more than ${MAX_CURSOR_LENGTH} characters`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new InvalidCursorError('Cursor contains characters that are not URL-safe base64')
  }

  const bytes = Buffer.from(token, 'base64url')
  // Reject non-canonical encodings so every position has exactly one valid token.
  if (bytes.toString('base64url') !== token) {
    throw new InvalidCursorError('Cursor is not a valid token')
  }

  let payload
  try {
    payload = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new InvalidCursorError('Cursor is not a valid token')
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InvalidCursorError('Cursor is not a valid token')
  }
  if (payload.v !== CURSOR_VERSION) {
    throw new InvalidCursorError('Cursor was issued by an unsupported version')
  }
  const keys = Object.keys(payload)
  if (keys.length !== 4 || !['v', 'c', 'i', 'f'].every((key) => keys.includes(key))) {
    throw new InvalidCursorError('Cursor is not a valid token')
  }
  if (payload.c !== null && !Number.isSafeInteger(payload.c)) {
    throw new InvalidCursorError('Cursor is not a valid token')
  }
  if (
    typeof payload.i !== 'string' ||
    payload.i.length === 0 ||
    payload.i.length > MAX_CURSOR_ID_LENGTH
  ) {
    throw new InvalidCursorError('Cursor is not a valid token')
  }
  if (typeof payload.f !== 'string' || !/^[0-9a-f]{12}$/.test(payload.f)) {
    throw new InvalidCursorError('Cursor is not a valid token')
  }

  return { position: { ms: payload.c, id: payload.i }, filterKey: payload.f }
}

function clampPageSize(limit) {
  const parsed = Number.parseInt(limit, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

/**
 * Selects one page of runs.
 *
 * @param {object[]} runs raw run records, in any order
 * @param {object} [query]
 * @param {number} [query.limit] page size (clamped to 1..MAX_PAGE_SIZE)
 * @param {{ms: number|null, id: string}|null} [query.after] return only runs strictly older than this position
 * @param {string[]} [query.statuses] keep runs whose status is any of these
 * @param {number|null} [query.createdFromMs] inclusive lower bound on `createdAt`
 * @param {number|null} [query.createdToMs] inclusive upper bound on `createdAt`
 * @returns {{ runs: object[], hasMore: boolean, nextPosition: object|null, limit: number }}
 */
export function selectRunPage(runs, query = {}) {
  const {
    limit = DEFAULT_PAGE_SIZE,
    after = null,
    statuses = [],
    createdFromMs = null,
    createdToMs = null,
  } = query

  const pageSize = clampPageSize(limit)
  const statusSet = statuses.length > 0 ? new Set(statuses) : null
  const hasDateFilter = createdFromMs !== null || createdToMs !== null

  const candidates = []
  for (const run of runs) {
    if (!run || typeof run !== 'object') continue
    if (statusSet && !statusSet.has(run.status)) continue

    const position = runPosition(run)
    if (hasDateFilter) {
      // A run with no usable timestamp can never satisfy a date window.
      if (position.ms === null) continue
      if (createdFromMs !== null && position.ms < createdFromMs) continue
      if (createdToMs !== null && position.ms > createdToMs) continue
    }
    candidates.push({ run, position })
  }

  candidates.sort((a, b) => comparePositions(b.position, a.position))

  let start = 0
  if (after) {
    start = candidates.findIndex((entry) => comparePositions(entry.position, after) < 0)
    if (start === -1) start = candidates.length
  }

  // Read one extra row so "is there another page" is exact rather than a
  // guess from a full page — the last page therefore has no cursor.
  const window = candidates.slice(start, start + pageSize + 1)
  const hasMore = window.length > pageSize
  const page = hasMore ? window.slice(0, pageSize) : window

  return {
    runs: page.map((entry) => entry.run),
    hasMore,
    nextPosition: hasMore ? page[page.length - 1].position : null,
    limit: pageSize,
  }
}

/**
 * Lightweight list projection of a (normalized) run record.
 *
 * Deliberately omits everything unbounded — `events`, `results`, `output`,
 * `plan`, `result`, `txProofs`, `paymentAttempts`, `usage` — so list payloads
 * stay small as histories grow. Full records come from `GET /api/runs/:id`.
 */
export function toRunSummary(run) {
  const summary = run.summary && typeof run.summary === 'object' ? run.summary : {}
  const error =
    run.error && typeof run.error === 'object'
      ? {
          code: run.error.code ?? null,
          message:
            typeof run.error.message === 'string'
              ? run.error.message.slice(0, MAX_SUMMARY_ERROR_MESSAGE_LENGTH)
              : null,
        }
      : null

  return {
    id: run.id,
    runId: run.runId ?? run.id,
    task: run.task ?? null,
    budget: run.budget ?? null,
    source: run.source ?? null,
    status: run.status ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    completedAt: run.completedAt ?? null,
    outputAvailable: Boolean(run.outputAvailable),
    error,
    interruptedAt: run.interruptedAt ?? null,
    interruptedReason: run.interruptedReason ?? null,
    totals: {
      totalSpent: summary.totalSpent ?? null,
      quotedTotal: summary.quotedTotal ?? null,
      settledSummary: summary.settledSummary ?? null,
      txCount: summary.txCount ?? null,
      elapsed: summary.elapsed ?? null,
    },
    eventCount: Array.isArray(run.events) ? run.events.length : 0,
    runUrl: `/api/runs/${encodeURIComponent(run.id)}`,
  }
}
