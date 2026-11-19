# Exact Asset Amounts & Budget Accounting

## Context & Motivation

StellarMind orchestrates AI agents that charge micropayments settled on the Stellar blockchain (via
x402 and native transfers). Previously, budget admission, agent per-call costs, and spend
accumulation used JavaScript floating-point arithmetic (`parseFloat`, `+` addition, and late
`.toFixed(4)` formatting).

IEEE-754 floating-point numbers inherently accumulate rounding drift when handling repeated
fractional additions. For example:

```javascript
0.01 * 10 // 0.09999999999999999 (not 0.10)
0.07 + 0.03 // 0.09999999999999999 (not 0.10)
```

As the number of agent steps and price diversity grow beyond simple demos, exact accounting becomes
essential to ensure:

- Spend totals never drift or diverge from on-chain settlement amounts.
- Budget admission guardrails enforce strict, predictable spending boundaries.
- Plans that exactly meet the budget are reliably accepted, while plans exceeding the budget by even
  a single base unit are rejected.

---

## Amount Representation (`AssetAmount`)

Exact asset amounts are modeled by the dependency-free `AssetAmount` class in
[`src/agents/amount.js`](../src/agents/amount.js).

### Integer Base Units

Every monetary value is stored internally as a `BigInt` count of integer base units:

- For USDC on Stellar: 1 USDC = 10,000,000 base units (stroops, $10^{-7}$).
- For XLM on Stellar: 1 XLM = 10,000,000 base units (stroops, $10^{-7}$).

```javascript
import { AssetAmount } from './src/agents/amount.js'

const cost = AssetAmount.from('0.05', 'USDC')
console.log(cost.baseUnits) // 500000n
console.log(cost.precision) // 7
console.log(cost.asset) // 'USDC'
```

### Explicit Per-Asset Precision

Asset precision is defined in `ASSET_PRECISION`:

| Asset    | Precision (Decimals) | Base Unit Name | Base Units per 1.0 Unit |
| :------- | :------------------- | :------------- | :---------------------- |
| **USDC** | 7                    | Stroop         | 10,000,000              |
| **XLM**  | 7                    | Stroop         | 10,000,000              |

Custom asset precisions can be registered for extensions or testing via
`registerAsset(asset, precision)`.

---

## Rounding Rules & Conversion at API Boundaries

### 1. Admission Rounding Rule: Strict Rejection

When amounts enter the system at API boundaries (such as `POST /api/orchestrate`, `assertBudget`, or
`AssetAmount.from`):

- Any fractional precision exceeding the asset's configured decimal places is **strictly rejected**
  with an `UnsupportedPrecisionError` (`code: 'UNSUPPORTED_PRECISION'`).
- The system **never silently truncates or rounds** input budgets or prices.

Example API validation rejection:

```json
{
  "status": 400,
  "code": "INVALID_INPUT",
  "message": "Invalid orchestrate request",
  "details": [
    {
      "field": "budget",
      "reason": "Unsupported fractional precision: asset 'USDC' allows at most 7 decimal places, received 8 decimal places in '0.12345678'",
      "code": "UNSUPPORTED_PRECISION",
      "asset": "USDC",
      "maxPrecision": 7,
      "receivedPrecision": 8,
      "received": "0.12345678"
    }
  ]
}
```

### 2. Calculation Rounding Rule: Zero Rounding Error

During orchestration runs:

- Budget headroom (`remainingBudget`), spend accumulation (`totalSpent.plus(cost)`), and guardrail
  checks (`exceedsBudget`) operate entirely on integer base units.
- Arithmetic is lossless and produces zero IEEE-754 drift across arbitrary numbers of steps.

### 3. Display Formatting Rule

For reporting and display compatibility:

- `formatAmount(value, 4)` renders amounts formatted to 4 decimal places (default), preserving
  compatibility with existing dashboard and SSE consumers.
- `amount.toDecimalString(decimals)` renders fixed decimal places up to the asset's precision.
- `amount.toExactString()` renders exact decimal representations without unnecessary trailing zeros.

---

## Budget Guardrails & Boundary Behavior

The core guardrail is evaluated in [`src/agents/budget.js`](../src/agents/budget.js):

$$\text{exceedsBudget}(\text{totalSpent}, \text{cost}, \text{budget}) \iff \text{totalSpent.baseUnits} + \text{cost.baseUnits} > \text{budget.baseUnits}$$

### Exact Equality (Accepted)

A plan whose total cost exactly equals the budget is permitted:

- If `budget = 0.05` and `cost = 0.05`, `0 + 500,000n > 500,000n` is `false`.
- The step executes, leaving `remainingBudget` at exactly `0n` base units.
- `isBudgetExhausted` returns `true`.

### One Supported Unit Over Budget (Rejected)

A plan that overshoots the budget by even a single supported base unit is rejected:

- For USDC, 1 base unit is $0.0000001$ USDC ($1$ stroop).
- If `budget = 0.0500000` ($500,000$ base units) and `cost = 0.0500001` ($500,001$ base units):
  - $500,001\text{n} > 500,000\text{n}$ evaluates to `true`.
  - The step is skipped and a `budget_limit` event is emitted.

---

## JSON Serialization Compatibility Contract

Because JavaScript's native `JSON.stringify` throws a `TypeError` when encountering raw `BigInt`
primitives, `AssetAmount` provides a documented JSON compatibility contract:

### Structured JSON Object

`AssetAmount.prototype.toJSON()` produces a JSON-safe plain object:

```json
{
  "amount": "0.0500000",
  "baseUnits": "500000",
  "asset": "USDC",
  "precision": 7
}
```

- `amount`: Exact decimal string formatted to asset precision.
- `baseUnits`: Base unit integer represented as a string (preventing 64-bit integer overflow).
- `asset`: Uppercase asset identifier (e.g. `"USDC"`).
- `precision`: Number of decimal places.

### Lossless Round Trips

Deserializing with `AssetAmount.from(parsedJson)` reconstitutes the identical `AssetAmount`:

```javascript
const original = AssetAmount.from('0.0500001', 'USDC')
const json = JSON.stringify(original)
const parsed = JSON.parse(json)
const restored = AssetAmount.from(parsed)

assert.strictEqual(restored.baseUnits, original.baseUnits) // 500001n
assert.strictEqual(restored.equals(original), true)
```

### Orchestrator Response Compatibility

Responses from `POST /api/orchestrate` and run history store records provide both
backwards-compatible values and exact objects:

```json
{
  "task": "Explain why x402 on Stellar matters for AI agents.",
  "budget": 0.15,
  "budgetExact": {
    "amount": "0.1500000",
    "baseUnits": "1500000",
    "asset": "USDC",
    "precision": 7
  },
  "totalSpent": "0.1000",
  "totalSpentExact": {
    "amount": "0.1000000",
    "baseUnits": "1000000",
    "asset": "USDC",
    "precision": 7
  },
  "quotedTotal": "0.1000",
  "quotedTotalExact": {
    "amount": "0.1000000",
    "baseUnits": "1000000",
    "asset": "USDC",
    "precision": 7
  },
  "settledTotals": [
    {
      "asset": "USDC",
      "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "network": "stellar:testnet",
      "amount": "0.0200000",
      "amountExact": {
        "amount": "0.0200000",
        "baseUnits": "200000",
        "asset": "USDC",
        "precision": 7
      },
      "count": 2,
      "txCount": 2
    },
    {
      "asset": "XLM",
      "issuer": null,
      "network": "stellar:testnet",
      "amount": "0.0800000",
      "amountExact": {
        "amount": "0.0800000",
        "baseUnits": "800000",
        "asset": "XLM",
        "precision": 7
      },
      "count": 2,
      "txCount": 2
    }
  ],
  "settledSummary": "0.02 USDC + 0.08 XLM",
  "settlementConversionPolicy": {
    "applied": false,
    "reason": "No USDC/XLM conversion rate is configured. Settled amounts are reported per asset and are never added across assets."
  },
  "budgetExhausted": false,
  "agentsUsed": 4,
  "agentsSkipped": 0
}
```

`totalSpent` / `totalSpentExact` express the **quoted/reserved** cost admitted against the budget
(and remain aliases of `quotedTotal` / `quotedTotalExact`). `settledTotals` reports what actually
moved, grouped per `(asset, issuer, network)` using exact base units. An XLM fallback settlement is
never added to a USDC total: with no configured conversion policy, the two asset totals stay
separate rather than being combined into one number.
