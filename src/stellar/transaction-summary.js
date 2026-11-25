/**
 * Pure helpers that describe a transaction's operations for the list and detail
 * views (issue #159). Nothing here touches the network, so every rule is
 * covered by tests/transaction-operations.test.js.
 */

/** Operations fetched for each transaction in the list; more are paged via the detail route. */
export const LIST_OPERATIONS_LIMIT = 10

/**
 * Direction of one operation relative to `account`:
 * `incoming`, `outgoing`, `self`, `other` (account is neither side) or `null`
 * when the operation has no sender and receiver (set_options, invoke_host_function, ...)
 * or no account was given.
 */
export function operationDirection(op, account) {
  if (!account || !op?.from || !op?.to) return null
  const fromMe = op.from === account
  const toMe = op.to === account
  if (fromMe && toMe) return 'self'
  if (fromMe) return 'outgoing'
  if (toMe) return 'incoming'
  return 'other'
}

/** Copy of each operation with its `direction` relative to `account` (cached objects are not mutated). */
export function withDirection(operations, account) {
  return operations.map((op) => ({ ...op, direction: operationDirection(op, account) }))
}

/**
 * Whether `operations` holds every operation of the transaction.
 *
 * The transaction record's `operation_count` is authoritative. A failed lookup
 * is never complete, and when the count is unknown a full page means "maybe more".
 */
export function operationsAreComplete({ operations, operationCount, error = null, limit }) {
  if (error) return false
  if (Number.isInteger(operationCount)) return operations.length >= operationCount
  return operations.length < limit
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

/**
 * Summary for one transaction. It never implies the first operation is the
 * whole transaction: `kind` says how many operations exist, `operationsComplete`
 * says whether the included ones are all of them, and `direction` is only
 * reported when every operation is included.
 */
export function summarizeOperations({
  operations,
  operationCount,
  successful,
  error = null,
  limit = LIST_OPERATIONS_LIMIT,
}) {
  const count = Number.isInteger(operationCount) ? operationCount : null
  const complete = operationsAreComplete({ operations, operationCount: count, error, limit })

  let kind = 'unknown'
  if (count !== null) kind = count === 0 ? 'none' : count === 1 ? 'single' : 'multiple'
  else if (complete)
    kind = operations.length === 0 ? 'none' : operations.length === 1 ? 'single' : 'multiple'

  const directions = unique(operations.map((op) => op.direction))
  let direction = null
  if (complete && directions.length === 1) direction = directions[0]
  else if (complete && directions.length > 1) direction = 'mixed'

  return {
    kind,
    operationCount: count,
    operationsIncluded: operations.length,
    operationsComplete: complete,
    types: unique(operations.map((op) => op.type)),
    assets: unique(operations.map((op) => op.asset_code)),
    direction,
    successful: typeof successful === 'boolean' ? successful : null,
  }
}
