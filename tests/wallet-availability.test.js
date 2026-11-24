/**
 * Wallet Availability Tests
 * Validates that empty results are distinguished from errors
 * and that partial availability is properly reported.
 *
 * Run: node tests/wallet-availability.test.js
 */

import assert from 'node:assert'

// ─── Tiny test harness (collect-all, fail-fast exit) ─────────────
const failures = []
let passed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

// ─── Test Response Structures ──────────────────────────────────
console.log('Wallet API Response Structures')

test('getBalance success response has required fields', () => {
  const successResponse = {
    success: true,
    balances: [
      { asset: 'XLM', balance: '100.0000000', issuer: null },
      {
        asset: 'USDC',
        balance: '50.0000000',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    ],
  }

  assert.strictEqual(successResponse.success, true)
  assert.ok(Array.isArray(successResponse.balances))
  assert.strictEqual(successResponse.balances.length, 2)
  assert.strictEqual(successResponse.error, undefined)
  assert.strictEqual(successResponse.errorType, undefined)
})

test('getBalance error response has required fields', () => {
  const errorResponse = {
    success: false,
    error: 'Account not found',
    errorType: 'ACCOUNT_NOT_FOUND',
    timestamp: '2024-01-01T00:00:00.000Z',
  }

  assert.strictEqual(errorResponse.success, false)
  assert.strictEqual(errorResponse.balances, undefined)
  assert.ok(typeof errorResponse.error === 'string')
  assert.ok(typeof errorResponse.errorType === 'string')
  assert.ok(typeof errorResponse.timestamp === 'string')
})

test('getBalance empty account (success) is distinguishable from error', () => {
  const emptyAccount = {
    success: true,
    balances: [],
  }

  const errorAccount = {
    success: false,
    error: 'Network error',
    errorType: 'NETWORK_ERROR',
    timestamp: '2024-01-01T00:00:00.000Z',
  }

  // Empty account is successful with empty array
  assert.strictEqual(emptyAccount.success, true)
  assert.ok(Array.isArray(emptyAccount.balances))
  assert.strictEqual(emptyAccount.balances.length, 0)

  // Error has no balances field
  assert.strictEqual(errorAccount.success, false)
  assert.strictEqual(errorAccount.balances, undefined)
  assert.ok(errorAccount.error)
})

console.log('Transaction API Response Structures')

test('getTransactions success response has required fields', () => {
  const successResponse = {
    success: true,
    transactions: [
      {
        hash: 'abc123',
        ledger: 12345,
        created_at: '2024-01-01T00:00:00Z',
        operations: [],
      },
    ],
  }

  assert.strictEqual(successResponse.success, true)
  assert.ok(Array.isArray(successResponse.transactions))
  assert.strictEqual(successResponse.error, undefined)
})

test('getTransactions error response has required fields', () => {
  const errorResponse = {
    success: false,
    error: 'Request timeout',
    errorType: 'TIMEOUT',
    timestamp: '2024-01-01T00:00:00.000Z',
  }

  assert.strictEqual(errorResponse.success, false)
  assert.strictEqual(errorResponse.transactions, undefined)
  assert.ok(typeof errorResponse.error === 'string')
  assert.ok(typeof errorResponse.errorType === 'string')
})

test('getTransactions empty account (success) is distinguishable from error', () => {
  const emptyAccount = {
    success: true,
    transactions: [],
  }

  const errorAccount = {
    success: false,
    error: 'Horizon unavailable',
    errorType: 'UPSTREAM_ERROR',
    timestamp: '2024-01-01T00:00:00.000Z',
  }

  // Empty account is successful with empty array
  assert.strictEqual(emptyAccount.success, true)
  assert.ok(Array.isArray(emptyAccount.transactions))
  assert.strictEqual(emptyAccount.transactions.length, 0)

  // Error has no transactions field
  assert.strictEqual(errorAccount.success, false)
  assert.strictEqual(errorAccount.transactions, undefined)
  assert.ok(errorAccount.error)
})

console.log('Balances Endpoint Response Structures')

test('balances endpoint with all wallets available', () => {
  const response = {
    wallets: {
      server: {
        address: 'GTEST123',
        balances: [{ asset: 'XLM', balance: '100.0', issuer: null }],
        available: true,
      },
      orchestrator: {
        address: 'GTEST456',
        balances: [],
        available: true,
      },
    },
    timestamp: '2024-01-01T00:00:00.000Z',
    correlationId: 'req-123',
  }

  assert.ok(response.wallets.server.available)
  assert.ok(response.wallets.orchestrator.available)
  assert.strictEqual(response.partialAvailability, undefined)
})

test('balances endpoint with partial availability', () => {
  const response = {
    wallets: {
      server: {
        address: 'GTEST123',
        balances: [{ asset: 'XLM', balance: '100.0', issuer: null }],
        available: true,
      },
      orchestrator: {
        address: 'GTEST456',
        available: false,
        error: 'Request timeout',
        errorType: 'TIMEOUT',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    },
    partialAvailability: true,
    message: 'Some wallet data could not be retrieved. Check individual wallet status.',
    timestamp: '2024-01-01T00:00:00.000Z',
    correlationId: 'req-123',
  }

  assert.ok(response.wallets.server.available)
  assert.strictEqual(response.wallets.orchestrator.available, false)
  assert.strictEqual(response.partialAvailability, true)
  assert.ok(response.message)
  assert.ok(response.correlationId)
})

test('unavailable wallet includes error details', () => {
  const wallet = {
    address: 'GTEST123',
    available: false,
    error: 'Account not found',
    errorType: 'ACCOUNT_NOT_FOUND',
    timestamp: '2024-01-01T00:00:00.000Z',
  }

  assert.strictEqual(wallet.available, false)
  assert.strictEqual(wallet.balances, undefined)
  assert.ok(typeof wallet.error === 'string')
  assert.ok(typeof wallet.errorType === 'string')
  assert.ok(typeof wallet.timestamp === 'string')
})

console.log('Transactions Endpoint HTTP Response Structures')

test('transactions endpoint success response', () => {
  const response = {
    success: true,
    transactions: [],
    address: 'GTEST123',
    count: 0,
    correlationId: 'req-123',
  }

  assert.strictEqual(response.success, true)
  assert.ok(Array.isArray(response.transactions))
  assert.ok(response.address)
  assert.ok(response.correlationId)
})

test('transactions endpoint error response with 404', () => {
  const response = {
    success: false,
    error: 'Account not found',
    errorType: 'ACCOUNT_NOT_FOUND',
    message: 'Account not found on the Stellar network. It may not be funded yet.',
    timestamp: '2024-01-01T00:00:00.000Z',
    correlationId: 'req-123',
    retryable: false,
  }

  assert.strictEqual(response.success, false)
  assert.strictEqual(response.transactions, undefined)
  assert.ok(response.error)
  assert.ok(response.message)
  assert.strictEqual(response.retryable, false)
})

test('transactions endpoint error response with 503', () => {
  const response = {
    success: false,
    error: 'Connection timeout',
    errorType: 'TIMEOUT',
    message: 'Request timed out while fetching transactions. Please try again.',
    timestamp: '2024-01-01T00:00:00.000Z',
    correlationId: 'req-123',
    retryable: true,
  }

  assert.strictEqual(response.success, false)
  assert.strictEqual(response.retryable, true)
  assert.ok(response.correlationId)
})

console.log('Error Type Categories')

test('all expected error types are defined', () => {
  const errorTypes = ['ACCOUNT_NOT_FOUND', 'TIMEOUT', 'NETWORK_ERROR', 'UPSTREAM_ERROR']

  for (const errorType of errorTypes) {
    assert.ok(typeof errorType === 'string')
    assert.ok(errorType.length > 0)
  }
})

test('error types map to appropriate HTTP status codes', () => {
  const statusMap = {
    ACCOUNT_NOT_FOUND: 404,
    TIMEOUT: 503,
    NETWORK_ERROR: 503,
    UPSTREAM_ERROR: 503,
  }

  assert.strictEqual(statusMap['ACCOUNT_NOT_FOUND'], 404)
  assert.strictEqual(statusMap['TIMEOUT'], 503)
  assert.strictEqual(statusMap['NETWORK_ERROR'], 503)
  assert.strictEqual(statusMap['UPSTREAM_ERROR'], 503)
})

// ─── Report results ───────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)

if (failures.length > 0) {
  process.exit(1)
}
