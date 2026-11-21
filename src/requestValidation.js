import { AssetAmount, getAssetPrecision, DEFAULT_ASSET } from './agents/amount.js'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RUN_STATUSES,
  InvalidCursorError,
  createFilterKey,
  decodeRunCursor,
} from './storage/run-query.js'

const DEFAULT_BUDGET = 0.15
const MAX_TOPIC_LENGTH = 500
const MAX_SUMMARY_TEXT_LENGTH = 5000
const MAX_CODE_PROMPT_LENGTH = 2000
const MAX_APIKEY_LENGTH = 128

function validationError(message, details = [], code = 'INVALID_INPUT', status = 400) {
  const err = new Error(message)
  err.status = status
  err.code = code
  err.details = details
  return err
}

function assertStringField(
  name,
  value,
  { required = false, minLength = 1, maxLength, defaultValue = undefined } = {}
) {
  if (value === undefined || value === null) {
    if (required) {
      return {
        valid: false,
        error: {
          field: name,
          reason: 'Missing required string field',
          received: value,
        },
      }
    }
    return {
      valid: true,
      value: defaultValue,
    }
  }

  if (typeof value !== 'string') {
    return {
      valid: false,
      error: {
        field: name,
        reason: 'Expected a string value',
        received: typeof value,
      },
    }
  }

  const trimmed = value.trim()
  if (trimmed.length < minLength) {
    return {
      valid: false,
      error: {
        field: name,
        reason: `Must be at least ${minLength} character${minLength === 1 ? '' : 's'}`,
        received: value,
      },
    }
  }

  if (maxLength !== undefined && trimmed.length > maxLength) {
    return {
      valid: false,
      error: {
        field: name,
        reason: `Must be no more than ${maxLength} characters`,
        received: value,
      },
    }
  }

  return {
    valid: true,
    value: trimmed,
  }
}

function assertBudget(value, asset = DEFAULT_ASSET) {
  if (value === undefined || value === null || value === '') {
    return {
      valid: true,
      value: DEFAULT_BUDGET,
      amount: AssetAmount.from(DEFAULT_BUDGET, asset),
    }
  }

  const str = String(value).trim()
  const parsed = Number(str)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return {
      valid: false,
      error: {
        field: 'budget',
        reason: 'Budget must be a finite numeric value',
        received: value,
      },
    }
  }

  if (parsed < 0) {
    return {
      valid: false,
      error: {
        field: 'budget',
        reason: 'Budget cannot be negative',
        received: value,
      },
    }
  }

  const maxPrecision = getAssetPrecision(asset)
  const parts = str.split('.')
  if (parts.length === 2 && parts[1].length > maxPrecision) {
    return {
      valid: false,
      error: {
        field: 'budget',
        reason: `Unsupported fractional precision: asset '${asset}' allows at most ${maxPrecision} decimal places, received ${parts[1].length} decimal places in '${value}'`,
        code: 'UNSUPPORTED_PRECISION',
        asset,
        maxPrecision,
        receivedPrecision: parts[1].length,
        received: value,
      },
    }
  }

  let exactAmount
  try {
    exactAmount = AssetAmount.from(str, asset)
  } catch (err) {
    return {
      valid: false,
      error: {
        field: 'budget',
        reason: err.message,
        code: err.code || 'INVALID_INPUT',
        received: value,
      },
    }
  }

  return {
    valid: true,
    value: parsed,
    amount: exactAmount,
  }
}

function assertApiKey(value) {
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: {
        field: 'apiKey',
        reason: 'API key must be a string',
        received: typeof value,
      },
    }
  }

  if (!value.startsWith('sk-ant-')) {
    return {
      valid: false,
      error: {
        field: 'apiKey',
        reason: 'API key must start with sk-ant-',
        received: value,
      },
    }
  }

  if (value.length > MAX_APIKEY_LENGTH) {
    return {
      valid: false,
      error: {
        field: 'apiKey',
        reason: `API key must be no more than ${MAX_APIKEY_LENGTH} characters`,
        received: value,
      },
    }
  }

  return { valid: true, value: value.trim() }
}

function validatePremiumQuery(req, _res, next) {
  const endpoint = req.path
  const details = []
  let payload = {}

  if (endpoint === '/api/premium/research' || endpoint === '/api/premium/analyze') {
    const topicResult = assertStringField('topic', req.query.topic, {
      required: false,
      minLength: 1,
      maxLength: MAX_TOPIC_LENGTH,
      defaultValue:
        endpoint === '/api/premium/research' ? 'AI and blockchain payments' : 'AI agent economies',
    })
    if (!topicResult.valid) details.push(topicResult.error)
    else payload.topic = topicResult.value
  }

  if (endpoint === '/api/premium/summarize') {
    const textResult = assertStringField('text', req.query.text, {
      required: false,
      minLength: 1,
      maxLength: MAX_SUMMARY_TEXT_LENGTH,
      defaultValue: 'Please provide text to summarize via ?text= parameter',
    })
    if (!textResult.valid) details.push(textResult.error)
    else payload.text = textResult.value
  }

  if (endpoint === '/api/premium/code') {
    const promptResult = assertStringField('prompt', req.query.prompt, {
      required: false,
      minLength: 1,
      maxLength: MAX_CODE_PROMPT_LENGTH,
      defaultValue: 'Write a hello world function',
    })
    if (!promptResult.valid) details.push(promptResult.error)
    else payload.prompt = promptResult.value
  }

  if (details.length > 0) {
    return next(validationError('Invalid request query parameters', details))
  }

  req.validated = { ...(req.validated || {}), ...payload }
  next()
}

function validateOrchestrate(req, _res, next) {
  const source = (req.method === 'GET' ? req.query : req.body) || {}
  const taskResult = assertStringField('task', source.task, {
    required: true,
    minLength: 1,
    maxLength: MAX_TOPIC_LENGTH,
  })
  const budgetResult = assertBudget(source.budget)

  const details = []
  if (!taskResult.valid) details.push(taskResult.error)
  if (!budgetResult.valid) details.push(budgetResult.error)

  let mode = 'sync'
  // Check body first, then query string, then Prefer header
  const modeValue = source.mode ?? req.query?.mode
  const asyncValue = source.async ?? req.query?.async
  if (modeValue !== undefined) {
    if (typeof modeValue !== 'string' || !['sync', 'async'].includes(modeValue.toLowerCase())) {
      details.push({
        field: 'mode',
        reason: "Submission mode must be either 'sync' or 'async'",
        received: modeValue,
      })
    } else {
      mode = modeValue.toLowerCase()
    }
  } else if (asyncValue !== undefined) {
    if (asyncValue === true || asyncValue === 'true') {
      mode = 'async'
    } else if (asyncValue === false || asyncValue === 'false') {
      mode = 'sync'
    } else {
      details.push({
        field: 'async',
        reason: "Parameter 'async' must be a boolean",
        received: asyncValue,
      })
    }
  } else if (
    typeof req.header === 'function' &&
    req.header('prefer')?.toLowerCase().includes('respond-async')
  ) {
    mode = 'async'
  }

  const headerKey =
    typeof req.header === 'function'
      ? req.header('idempotency-key') || req.header('x-idempotency-key')
      : undefined
  const rawKey = headerKey !== undefined ? headerKey : source.idempotencyKey
  let idempotencyKey = null
  if (rawKey !== undefined && rawKey !== null) {
    if (typeof rawKey !== 'string' || rawKey.trim().length === 0 || rawKey.length > 256) {
      details.push({
        field: 'idempotencyKey',
        reason: 'Idempotency key must be a non-empty string with at most 256 characters',
        received: rawKey,
      })
    } else {
      idempotencyKey = rawKey.trim()
    }
  }

  if (details.length > 0) {
    return next(validationError('Invalid orchestrate request', details))
  }

  req.validated = {
    ...req.validated,
    task: taskResult.value,
    budget: budgetResult.value,
    mode,
    idempotencyKey,
  }
  next()
}

const MAX_STATUS_FILTER_TOKENS = 20
const MAX_RECEIVED_ECHO_LENGTH = 100
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/
const MS_PER_MINUTE = 60 * 1000
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE

function echoReceived(value) {
  if (typeof value === 'string') return value.slice(0, MAX_RECEIVED_ECHO_LENGTH)
  return Array.isArray(value) ? 'array' : typeof value
}

function isCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/**
 * Parses a `createdFrom` / `createdTo` value.
 *
 *   - `YYYY-MM-DD`: a UTC calendar day. As a lower bound it means the start
 *     of that day; as an upper bound, the end of it (23:59:59.999), so
 *     `createdFrom=2026-10-01&createdTo=2026-10-31` covers all of October.
 *   - ISO 8601 date-time with an explicit `Z` or `±hh:mm` offset: that exact
 *     instant. Offset-less date-times are rejected as ambiguous.
 *
 * Both bounds are inclusive.
 *
 * @returns {{ ms: number } | { error: string }}
 */
function parseRunDateBound(raw, edge) {
  const value = raw.trim()

  const dateOnly = DATE_ONLY_PATTERN.exec(value)
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number)
    if (year < 1970 || !isCalendarDate(year, month, day)) {
      return { error: 'Not a valid calendar date (expected a real date on or after 1970-01-01)' }
    }
    const startOfDay = Date.UTC(year, month - 1, day)
    return { ms: edge === 'from' ? startOfDay : startOfDay + MS_PER_DAY - 1 }
  }

  const dateTime = DATE_TIME_PATTERN.exec(value)
  if (dateTime) {
    const [year, month, day, hour, minute] = dateTime.slice(1, 6).map(Number)
    const second = dateTime[6] === undefined ? 0 : Number(dateTime[6])
    const millis = dateTime[7] === undefined ? 0 : Number(dateTime[7].padEnd(3, '0'))
    const zone = dateTime[8]

    let offsetMinutes = 0
    if (zone !== 'Z') {
      const sign = zone[0] === '-' ? -1 : 1
      const offsetHours = Number(zone.slice(1, 3))
      const offsetMins = Number(zone.slice(4, 6))
      if (offsetHours > 23 || offsetMins > 59) {
        return { error: 'UTC offset is out of range' }
      }
      offsetMinutes = sign * (offsetHours * 60 + offsetMins)
    }

    if (
      year < 1970 ||
      !isCalendarDate(year, month, day) ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return { error: 'Not a valid calendar date-time' }
    }

    return {
      ms:
        Date.UTC(year, month - 1, day, hour, minute, second, millis) -
        offsetMinutes * MS_PER_MINUTE,
    }
  }

  return {
    error:
      'Expected an ISO 8601 date (YYYY-MM-DD) or date-time with a Z or ±hh:mm offset ' +
      '(e.g. 2026-10-01T00:00:00Z)',
  }
}

/**
 * Validates and normalizes the query string of `GET /api/runs` (issue #141).
 *
 * Every problem is collected and reported together in `details`, each with a
 * machine-readable `code`, so a client can fix a request in one round trip.
 * On success `req.validated.runList` carries the parsed values.
 */
function validateListRuns(req, _res, next) {
  const query = req.query || {}
  const details = []

  const problem = (field, code, reason, received) => {
    const entry = { field, code, reason }
    if (received !== undefined) entry.received = echoReceived(received)
    details.push(entry)
  }

  // Scalar parameters may appear at most once; `?limit=1&limit=2` is ambiguous.
  const readSingle = (field) => {
    const value = query[field]
    if (value === undefined) return undefined
    if (Array.isArray(value)) {
      problem(field, 'DUPLICATE_PARAMETER', 'Parameter must be provided only once', value)
      return undefined
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problem(field, 'INVALID_VALUE', 'Parameter must not be empty', value)
      return undefined
    }
    return value
  }

  // limit — non-integers and values below 1 are rejected; values above the
  // maximum are clamped, and the applied value is echoed in the response.
  let limit = DEFAULT_PAGE_SIZE
  const limitRaw = readSingle('limit')
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw.trim()) || Number(limitRaw) < 1) {
      problem('limit', 'INVALID_LIMIT', 'Expected a positive integer', limitRaw)
    } else {
      limit = Math.min(Number(limitRaw), MAX_PAGE_SIZE)
    }
  }

  // status — repeated and/or comma-separated, e.g. `status=failed,interrupted`.
  const statuses = []
  const statusParam = query.status
  if (statusParam !== undefined) {
    const rawValues = Array.isArray(statusParam) ? statusParam : [statusParam]
    const tokens = rawValues.flatMap((value) =>
      typeof value === 'string' ? value.split(',').map((token) => token.trim()) : [value]
    )
    if (tokens.length > MAX_STATUS_FILTER_TOKENS) {
      problem('status', 'INVALID_STATUS', `At most ${MAX_STATUS_FILTER_TOKENS} values allowed`)
    } else {
      for (const token of tokens) {
        if (typeof token === 'string' && RUN_STATUSES.includes(token)) {
          if (!statuses.includes(token)) statuses.push(token)
        } else {
          problem(
            'status',
            'INVALID_STATUS',
            `Unknown status. Expected one or more of: ${RUN_STATUSES.join(', ')}`,
            token
          )
        }
      }
    }
  }
  statuses.sort((a, b) => RUN_STATUSES.indexOf(a) - RUN_STATUSES.indexOf(b))

  // createdFrom / createdTo
  let createdFromMs = null
  let createdToMs = null
  for (const [field, edge] of [
    ['createdFrom', 'from'],
    ['createdTo', 'to'],
  ]) {
    const raw = readSingle(field)
    if (raw === undefined) continue
    const parsed = parseRunDateBound(raw, edge)
    if ('error' in parsed) {
      problem(field, 'INVALID_DATE', parsed.error, raw)
    } else if (edge === 'from') {
      createdFromMs = parsed.ms
    } else {
      createdToMs = parsed.ms
    }
  }
  if (createdFromMs !== null && createdToMs !== null && createdFromMs > createdToMs) {
    problem('createdFrom', 'INVALID_DATE_RANGE', 'createdFrom must not be later than createdTo')
  }

  // cursor — must be one this server issued, for these same filters.
  let after = null
  const cursorRaw = readSingle('cursor')
  if (cursorRaw !== undefined) {
    try {
      const decoded = decodeRunCursor(cursorRaw)
      after = decoded.position
      if (details.length === 0) {
        const expected = createFilterKey({ statuses, createdFromMs, createdToMs })
        if (decoded.filterKey !== expected) {
          after = null
          problem(
            'cursor',
            'CURSOR_FILTER_MISMATCH',
            'Cursor was issued for different filters. Omit the cursor to restart pagination ' +
              'when changing status or date filters',
            cursorRaw
          )
        }
      }
    } catch (err) {
      if (!(err instanceof InvalidCursorError)) throw err
      problem('cursor', 'INVALID_CURSOR', err.reason, cursorRaw)
    }
  }

  if (details.length > 0) {
    return next(validationError('Invalid run list query parameters', details))
  }

  req.validated = {
    ...(req.validated || {}),
    runList: {
      limit,
      after,
      statuses,
      createdFromMs,
      createdToMs,
      filterKey: createFilterKey({ statuses, createdFromMs, createdToMs }),
    },
  }
  next()
}

function validateWalletTransactions(req, _res, next) {
  if (req.query.address === undefined) {
    return next()
  }

  const result = assertStringField('address', req.query.address, {
    required: true,
    minLength: 1,
    maxLength: 64,
  })

  if (!result.valid) {
    return next(validationError('Invalid wallet query parameters', [result.error]))
  }

  req.validated = { ...(req.validated || {}), address: result.value }
  next()
}

function validateConfigApiKey(req, _res, next) {
  const result = assertApiKey(req.body.apiKey)
  if (!result.valid) {
    return next(validationError('Invalid API key payload', [result.error], 'INVALID_API_KEY'))
  }
  req.validated = { ...(req.validated || {}), apiKey: result.value }
  next()
}

function validateOrchestrateExecute(req, res, next) {
  const source = req.body || {}
  const details = []

  const planIdResult = assertStringField('planId', source.planId, {
    required: true,
    minLength: 1,
    maxLength: 128,
  })
  if (!planIdResult.valid) {
    details.push(planIdResult.error)
  }

  let mode = 'sync'
  const modeValue = source.mode ?? req.query?.mode
  const asyncValue = source.async ?? req.query?.async
  if (modeValue !== undefined) {
    if (typeof modeValue !== 'string' || !['sync', 'async'].includes(modeValue.toLowerCase())) {
      details.push({
        field: 'mode',
        reason: "Submission mode must be either 'sync' or 'async'",
        received: modeValue,
      })
    } else {
      mode = modeValue.toLowerCase()
    }
  } else if (asyncValue !== undefined) {
    if (asyncValue === true || asyncValue === 'true') {
      mode = 'async'
    } else if (asyncValue === false || asyncValue === 'false') {
      mode = 'sync'
    } else {
      details.push({
        field: 'async',
        reason: "Parameter 'async' must be a boolean",
        received: asyncValue,
      })
    }
  } else if (
    typeof req.header === 'function' &&
    req.header('prefer')?.toLowerCase().includes('respond-async')
  ) {
    mode = 'async'
  }

  const headerKey =
    typeof req.header === 'function'
      ? req.header('idempotency-key') || req.header('x-idempotency-key')
      : undefined
  const rawKey = headerKey !== undefined ? headerKey : source.idempotencyKey
  let idempotencyKey = null
  if (rawKey !== undefined && rawKey !== null) {
    if (typeof rawKey !== 'string' || rawKey.trim().length === 0 || rawKey.length > 256) {
      details.push({
        field: 'idempotencyKey',
        reason: 'Idempotency key must be a non-empty string with at most 256 characters',
        received: rawKey,
      })
    } else {
      idempotencyKey = rawKey.trim()
    }
  }

  if (details.length > 0) {
    return next(validationError('Invalid execute request', details))
  }

  req.validated = {
    planId: planIdResult.value,
    mode,
    idempotencyKey,
  }
  next()
}

export {
  validationError,
  assertStringField,
  assertBudget,
  assertApiKey,
  validatePremiumQuery,
  validateOrchestrate,
  validateOrchestrateExecute,
  validateListRuns,
  validateWalletTransactions,
  validateConfigApiKey,
}
