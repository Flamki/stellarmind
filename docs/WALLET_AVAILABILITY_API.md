# Wallet Availability API Documentation

## Overview

The wallet availability endpoints distinguish between successful empty results and error states,
providing typed error responses with correlation IDs for debugging. This document describes the
updated API response formats.

## Core Principles

1. **Explicit Success Indication**: All responses include a `success` boolean field
2. **Typed Error States**: Errors are categorized with `errorType` for appropriate client handling
3. **Partial Availability**: Balance endpoint reports per-wallet availability status
4. **Correlation IDs**: Every response includes a correlation ID for request tracing
5. **Retryability Signals**: Error responses indicate whether the operation can be retried

## Error Types

| Error Type          | HTTP Status | Description                                          | Retryable |
| ------------------- | ----------- | ---------------------------------------------------- | --------- |
| `ACCOUNT_NOT_FOUND` | 404         | Account does not exist on the Stellar network        | No        |
| `TIMEOUT`           | 503         | Request timed out waiting for Horizon response       | Yes       |
| `NETWORK_ERROR`     | 503         | Network connectivity issue (DNS, connection refused) | Yes       |
| `UPSTREAM_ERROR`    | 503         | Horizon service error or other upstream issue        | Yes       |

## Endpoints

### GET /api/wallet/balances

Returns balance information for all configured wallets with per-wallet availability status.

#### Success Response (200 OK)

All wallets available:

```json
{
  "wallets": {
    "server": {
      "address": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "balances": [
        {
          "asset": "XLM",
          "balance": "100.0000000",
          "issuer": null
        },
        {
          "asset": "USDC",
          "balance": "50.0000000",
          "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        }
      ],
      "available": true
    },
    "orchestrator": {
      "address": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
      "balances": [],
      "available": true
    }
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "correlationId": "req-abc123"
}
```

#### Partial Availability Response (200 OK)

Some wallets unavailable:

```json
{
  "wallets": {
    "server": {
      "address": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "balances": [
        {
          "asset": "XLM",
          "balance": "100.0000000",
          "issuer": null
        }
      ],
      "available": true
    },
    "orchestrator": {
      "address": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
      "available": false,
      "error": "Request timeout after 30s",
      "errorType": "TIMEOUT",
      "timestamp": "2024-01-01T00:00:00.000Z"
    }
  },
  "partialAvailability": true,
  "message": "Some wallet data could not be retrieved. Check individual wallet status.",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "correlationId": "req-abc123"
}
```

#### Key Points

- Status is always `200 OK` even with partial failures
- Check `partialAvailability` field to detect issues
- Each wallet has an `available` boolean field
- Unavailable wallets include `error`, `errorType`, and `timestamp`
- Empty balances array with `available: true` means a valid funded account with no assets

### GET /api/wallet/transactions

Returns transaction history for a specific wallet address.

#### Query Parameters

| Parameter              | Type    | Default              | Description                    |
| ---------------------- | ------- | -------------------- | ------------------------------ |
| `address`              | string  | orchestrator address | Stellar public key             |
| `limit`                | integer | 20                   | Number of transactions (1-200) |
| `order` or `direction` | string  | `desc`               | Sort order: `asc` or `desc`    |
| `cursor` or `page`     | string  | null                 | Paging cursor for pagination   |

#### Success Response (200 OK)

```json
{
  "success": true,
  "transactions": [
    {
      "hash": "abc123def456...",
      "ledger": 12345,
      "created_at": "2024-01-01T00:00:00Z",
      "memo": "test payment",
      "memo_type": "text",
      "feeCharged": "100",
      "operationCount": 1,
      "successful": true,
      "operations": [
        {
          "id": "op123",
          "type": "payment",
          "amount": "10.0000000",
          "asset_code": "XLM",
          "from": "GXXXXX...",
          "to": "GYYYYYY..."
        }
      ],
      "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123def456..."
    }
  ],
  "address": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "count": 1,
  "correlationId": "req-abc123"
}
```

#### Empty Account Success Response (200 OK)

Valid account with no transactions:

```json
{
  "success": true,
  "transactions": [],
  "address": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "count": 0,
  "correlationId": "req-abc123"
}
```

#### Error Response - Account Not Found (404 Not Found)

```json
{
  "success": false,
  "error": "Account not found",
  "errorType": "ACCOUNT_NOT_FOUND",
  "message": "Account not found on the Stellar network. It may not be funded yet.",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "correlationId": "req-abc123",
  "retryable": false
}
```

#### Error Response - Upstream Error (503 Service Unavailable)

```json
{
  "success": false,
  "error": "getaddrinfo ENOTFOUND horizon-testnet.stellar.org",
  "errorType": "NETWORK_ERROR",
  "message": "Network error connecting to Horizon. Please check your connection and try again.",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "correlationId": "req-abc123",
  "retryable": true
}
```

## Distinguishing Empty from Error

### Before (Issue #158)

Both empty accounts and errors returned `[]`, making them indistinguishable:

```javascript
// Could be either:
// 1. Valid empty account
// 2. Horizon timeout
// 3. Network error
const txs = await fetch('/api/wallet/transactions').then((r) => r.json())
// txs = []  — which case is it?
```

### After (Fixed)

Success and error are explicit and distinguishable:

```javascript
const response = await fetch('/api/wallet/transactions').then((r) => r.json())

if (response.success) {
  if (response.transactions.length === 0) {
    console.log('Valid empty account')
  } else {
    console.log(`Found ${response.transactions.length} transactions`)
  }
} else {
  console.error(`Error: ${response.message} (${response.errorType})`)
  console.error(`Correlation ID: ${response.correlationId}`)

  if (response.retryable) {
    // Show retry button
  }
}
```

## Frontend Integration

### Wallet Balance Display

The frontend `wallet.js` module handles per-wallet availability:

```javascript
const data = await fetch('/api/wallet/balances').then((r) => r.json())

for (const [key, wallet] of Object.entries(data.wallets)) {
  if (wallet.available) {
    // Display balances
    displayBalances(wallet.balances)
  } else {
    // Show error state with user-friendly message
    showError(wallet.errorType, wallet.error)
  }
}
```

### Transaction Page Display

The frontend `pages.js` module shows actionable retry states:

```javascript
const data = await fetch('/api/wallet/transactions').then((r) => r.json())

if (!data.success) {
  if (data.retryable) {
    showRetryButton()
  }
  showError(data.message, data.correlationId)
} else if (data.transactions.length === 0) {
  showEmptyState('✅ No transactions yet. This account is empty but valid.')
} else {
  renderTransactions(data.transactions)
}
```

## Error Messages

### Balance Errors (User-Facing)

| Error Type          | Display Message        |
| ------------------- | ---------------------- |
| `ACCOUNT_NOT_FOUND` | ⚠️ Not funded          |
| `TIMEOUT`           | ⏱️ Timeout             |
| `NETWORK_ERROR`     | 🌐 Network error       |
| `UPSTREAM_ERROR`    | ⚠️ Service unavailable |

### Transaction Errors (User-Facing)

| Error Type          | Display Message                                                                  |
| ------------------- | -------------------------------------------------------------------------------- |
| `ACCOUNT_NOT_FOUND` | Account not found on the Stellar network. It may not be funded yet.              |
| `TIMEOUT`           | Request timed out while fetching transactions. Please try again.                 |
| `NETWORK_ERROR`     | Network error connecting to Horizon. Please check your connection and try again. |
| `UPSTREAM_ERROR`    | Horizon service is temporarily unavailable. Please try again later.              |

## Migration Guide

### Backend (src/stellar/wallet.js)

**Before:**

```javascript
export async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey)
    return account.balances.map(...)
  } catch (err) {
    return []  // Loses error context
  }
}
```

**After:**

```javascript
export async function getBalance(publicKey) {
  try {
    const account = await server.loadAccount(publicKey)
    return {
      success: true,
      balances: account.balances.map(...)
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
      errorType: categorizeError(err),
      timestamp: new Date().toISOString()
    }
  }
}
```

### API Endpoints (src/server.js)

**Before:**

```javascript
app.get('/api/wallet/balances', async (req, res) => {
  const balances = await getBalance(address)
  res.json({ address, balances }) // Empty array if error
})
```

**After:**

```javascript
app.get('/api/wallet/balances', async (req, res) => {
  const result = await getBalance(address)
  if (result.success) {
    res.json({ address, balances: result.balances, available: true })
  } else {
    res.json({
      address,
      available: false,
      error: result.error,
      errorType: result.errorType,
    })
  }
})
```

### Frontend (public/assets/js/\*.js)

**Before:**

```javascript
const balances = await fetch('/api/wallet/balances').then((r) => r.json())
if (balances.length === 0) {
  // Is this an error or empty account? Unknown!
}
```

**After:**

```javascript
const data = await fetch('/api/wallet/balances').then((r) => r.json())
if (!data.wallets.server.available) {
  showError(data.wallets.server.errorType)
} else if (data.wallets.server.balances.length === 0) {
  showEmptyState()
} else {
  displayBalances(data.wallets.server.balances)
}
```

## Testing

Run the wallet availability tests:

```bash
node tests/wallet-availability.test.js
```

Tests validate:

- Success responses have required fields
- Error responses have required fields
- Empty accounts are distinguishable from errors
- Partial availability is correctly reported
- Error types map to appropriate HTTP status codes
- Correlation IDs are included in all responses

## See Also

- [API Examples](./API_EXAMPLES.md) - Full API documentation
- [Architecture](./architecture.md) - System architecture overview
- Issue #158 - Original issue description
