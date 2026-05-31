# Pricing Configuration Refactoring Guide

## Overview

This document describes the refactoring of hardcoded pricing configuration in StellarMind to use a
centralized, validated pricing configuration system. This ensures a single source of truth for all
premium endpoint pricing.

## Problem Statement

**Before Refactoring:**

- Premium endpoint prices were hardcoded in `src/server.js` in the x402 middleware configuration
- Changes required code modifications and re-deployment
- Risk of inconsistencies between middleware config, status endpoint, and broadcast events
- No validation of pricing configuration at startup
- Difficult to maintain and audit pricing changes

**After Refactoring:**

- All pricing defined in `src/pricing.config.js`
- Automatic validation at application startup
- Single source of truth for all pricing
- Consistent pricing across middleware, status endpoint, and events
- Easy to audit and modify pricing

## Architecture

### Files Created

1. **`src/pricing.config.js`** - Centralized pricing configuration
2. **`src/pricing.validator.js`** - Configuration validation logic
3. **`tests/pricing.validator.test.js`** - Unit tests for validation
4. **`tests/pricing.integration.test.js`** - Integration tests for consistency

### Files Modified

1. **`src/server.js`** - Updated to use pricing config and validation

## Configuration Structure

### `src/pricing.config.js`

The pricing configuration is a JavaScript object with the following structure:

```javascript
export const pricingConfig = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent - Web research and information gathering',
      emoji: '🔬',
    },
    'GET /api/premium/summarize': {
      price: '$0.01',
      agent: 'summary-bot',
      description: 'Summary Agent - Text summarization and condensing',
      emoji: '📝',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'analyst-bot',
      description: 'Analysis Agent - Deep analysis and insights',
      emoji: '📊',
    },
    'GET /api/premium/code': {
      price: '$0.03',
      agent: 'code-bot',
      description: 'Code Agent - Code generation and debugging',
      emoji: '💻',
    },
  },
  // ... lookup maps and methods
}
```

### Field Descriptions

- **endpoint** (key): HTTP method and path, e.g., `'GET /api/premium/research'`
- **price**: Price in USD format `$X.XX` (e.g., `'$0.01'`)
- **agent**: Agent identifier (alphanumeric with hyphens, e.g., `'research-bot'`)
- **description**: Human-readable description of the agent
- **emoji**: Unicode emoji for visual identification

## Validation System

### Validation Functions

The `src/pricing.validator.js` module provides comprehensive validation:

#### `validatePrice(price)`

Validates individual price strings.

```javascript
import { validatePrice } from './src/pricing.validator.js'

// Valid
validatePrice('$0.01') // { valid: true, value: 0.01 }

// Invalid
validatePrice('0.01') // { valid: false, error: "Price must be in format '$X.XX'..." }
validatePrice('$0.1') // { valid: false, error: "Price must be in format '$X.XX'..." }
validatePrice('$-0.01') // { valid: false, error: "Price cannot be negative..." }
validatePrice('$0.00') // { valid: false, error: "Price cannot be zero..." }
```

#### `validateEndpoint(endpoint)`

Validates endpoint format.

```javascript
import { validateEndpoint } from './src/pricing.validator.js'

// Valid
validateEndpoint('GET /api/premium/research') // { valid: true }
validateEndpoint('POST /api/premium/analyze') // { valid: true }

// Invalid
validateEndpoint('GET /api/research') // { valid: false, error: "..." }
validateEndpoint('GET /premium/research') // { valid: false, error: "..." }
```

#### `validateEndpointInfo(endpoint, info)`

Validates endpoint configuration object.

```javascript
import { validateEndpointInfo } from './src/pricing.validator.js'

const info = {
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
}

validateEndpointInfo('GET /api/premium/research', info)
// { valid: true, errors: [] }
```

#### `validatePricingConfig(pricingConfig)`

Validates entire pricing configuration.

```javascript
import { validatePricingConfig } from './src/pricing.validator.js'

validatePricingConfig(pricingConfig)
// { valid: true, errors: [] }
```

#### `validateX402Compatibility(pricingConfig, config)`

Validates x402 middleware compatibility.

```javascript
import { validateX402Compatibility } from './src/pricing.validator.js'

const appConfig = {
  network: 'stellar:testnet',
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
}

validateX402Compatibility(pricingConfig, appConfig)
// { valid: true, errors: [] }
```

#### `validateAll(pricingConfig, config)`

Comprehensive validation combining all checks.

```javascript
import { validateAll } from './src/pricing.validator.js'

const validation = validateAll(pricingConfig, appConfig)
// { valid: true, errors: [], warnings: [] }
```

#### `throwIfInvalid(validation, context)`

Throws an error if validation failed.

```javascript
import { throwIfInvalid } from './src/pricing.validator.js'

const validation = validateAll(pricingConfig, appConfig)
throwIfInvalid(validation, 'Pricing configuration')
// Throws if invalid, otherwise returns silently
```

### Startup Validation

The server validates pricing configuration at startup:

```javascript
// In src/server.js
const pricingValidation = validateAll(pricingConfig, {
  network: config.network,
  payTo: config.serverAddress,
})

if (!pricingValidation.valid) {
  console.error('❌ FATAL: Pricing configuration validation failed')
  console.error(formatValidationErrors(pricingValidation))
  process.exit(1)
}
console.log('✅ Pricing configuration validated successfully')
```

## Usage Examples

### Changing a Price

To change the price of the research endpoint from `$0.01` to `$0.02`:

**Before (hardcoded in server.js):**

```javascript
// In src/server.js - HARDCODED
'GET /api/premium/research': {
  accepts: {
    scheme: 'exact',
    price: '$0.01',  // ← Change here
    network: config.network,
    payTo: config.serverAddress,
  },
},
```

**After (centralized config):**

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.02',  // ← Change here
  agent: 'research-bot',
  description: 'Research Agent - Web research and information gathering',
  emoji: '🔬',
},
```

This single change automatically updates:

- x402 middleware configuration
- Status endpoint output
- Broadcast events
- All pricing lookups

### Adding a New Premium Endpoint

To add a new premium endpoint for a "translation" agent at `$0.02`:

```javascript
// In src/pricing.config.js
export const pricingConfig = {
  endpoints: {
    // ... existing endpoints ...
    'GET /api/premium/translate': {
      price: '$0.02',
      agent: 'translator-bot',
      description: 'Translation Agent - Multi-language translation',
      emoji: '🌐',
    },
  },
  // ... rest of config ...
}
```

Then add the endpoint handler in `src/server.js`:

```javascript
app.get('/api/premium/translate', async (req, res) => {
  try {
    const text = req.query.text || ''
    const priceInfo = pricingConfig.getEndpointInfo('GET /api/premium/translate')
    const cost = priceInfo.price.slice(1)
    broadcast({
      type: 'agent_call',
      agent: `${priceInfo.emoji} Translator Agent`,
      agentId: 'translator-bot',
      input: text.substring(0, 100),
      cost,
      timestamp: new Date().toISOString(),
    })
    const result = await runTranslate(text)
    broadcast({
      type: 'agent_response',
      agent: `${priceInfo.emoji} Translator Agent`,
      agentId: 'translator-bot',
      resultPreview: result.substring(0, 150),
      cost,
      timestamp: new Date().toISOString(),
    })
    res.json({
      agent: 'translator-bot',
      result,
      model: MODEL_LABELS.translate,
      cost: `${cost} USDC`,
      paidVia: 'x402',
    })
  } catch (err) {
    res
      .status(500)
      .json({ error: 'Translator agent temporarily unavailable', details: err.message })
  }
})
```

The x402 middleware will automatically protect this endpoint with the configured price.

### Querying Pricing Information

```javascript
import { pricingConfig } from './src/pricing.config.js'

// Get price for specific endpoint
const price = pricingConfig.getPrice('GET /api/premium/research')
// '$0.01'

// Get all premium endpoints
const endpoints = pricingConfig.getPremiumEndpoints()
// ['GET /api/premium/research', 'GET /api/premium/summarize', ...]

// Get endpoint info
const info = pricingConfig.getEndpointInfo('GET /api/premium/research')
// { price: '$0.01', agent: 'research-bot', description: '...', emoji: '🔬' }

// Get all pricing info (for status endpoint)
const allInfo = pricingConfig.getAllPricingInfo()
// [{ endpoint: '...', price: '...', agent: '...', ... }, ...]

// Get x402 middleware configuration
const x402Config = pricingConfig.getX402Config({
  network: 'stellar:testnet',
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
})
// { 'GET /api/premium/research': { accepts: { ... } }, ... }

// Lookup by agent
const agentInfo = pricingConfig.byAgent['research-bot']
// { endpoint: 'GET /api/premium/research', price: '$0.01', ... }

// Lookup by price
const endpointsAt001 = pricingConfig.byPrice['$0.01']
// [{ endpoint: 'GET /api/premium/research', agent: 'research-bot' }, ...]
```

## Error Scenarios

### Invalid Price Format

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '0.01',  // ❌ Missing '$'
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

**Error at startup:**

```
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price must be in format '$X.XX', got '0.01'
```

### Invalid Endpoint Format

```javascript
// In src/pricing.config.js
'GET /api/research': {  // ❌ Missing '/premium/'
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

**Error at startup:**

```
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid endpoint format: Endpoint must match pattern 'METHOD /api/premium/name', got 'GET /api/research'
```

### Duplicate Agent

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
'GET /api/premium/analyze': {
  price: '$0.05',
  agent: 'research-bot',  // ❌ Duplicate agent
  description: 'Analysis Agent',
  emoji: '📊',
},
```

**Error at startup:**

```
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Duplicate agent: 'research-bot' used in multiple endpoints
```

### Missing Required Field

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.01',
  // ❌ Missing 'agent' field
  description: 'Research Agent',
  emoji: '🔬',
},
```

**Error at startup:**

```
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Missing 'agent' for endpoint 'GET /api/premium/research'
```

### Invalid Price Value

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.00',  // ❌ Zero price not allowed
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

**Error at startup:**

```
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price cannot be zero: '$0.00'
```

## Testing

### Running Unit Tests

```bash
node tests/pricing.validator.test.js
```

**Output:**

```
📋 Testing Price Validation...
✅ Price validation tests passed

📋 Testing Endpoint Validation...
✅ Endpoint validation tests passed

📋 Testing Endpoint Info Validation...
✅ Endpoint info validation tests passed

📋 Testing Pricing Config Validation...
✅ Pricing config validation tests passed

📋 Testing x402 Compatibility Validation...
✅ x402 compatibility validation tests passed

📋 Testing Comprehensive Validation...
✅ Comprehensive validation tests passed

📋 Testing Error Formatting...
✅ Error formatting tests passed

📋 Testing throwIfInvalid...
✅ throwIfInvalid tests passed

==================================================
✅ All pricing validator tests passed!
==================================================
```

### Running Integration Tests

```bash
node tests/pricing.integration.test.js
```

**Output:**

```
📋 Testing Pricing Config Structure...
✅ Found 4 premium endpoints

📋 Testing Pricing Consistency...
✅ All endpoints have required fields
✅ All prices have valid format ($X.XX)
✅ All agent names are unique

📋 Testing Pricing Maps...
✅ byEndpoint map is consistent
✅ byAgent map is consistent
✅ byPrice map is consistent

📋 Testing Getter Methods...
✅ getPrice method works correctly
✅ getPremiumEndpoints method works correctly
✅ getEndpointInfo method works correctly
✅ getAllPricingInfo method works correctly

📋 Testing x402 Configuration Generation...
✅ x402Config has all endpoints
✅ x402Config structure is correct
✅ x402Config prices match pricing config

📋 Testing Single Source of Truth...
✅ All maps reference the same pricing data

📋 Testing Pricing Config Validation...
✅ Pricing config passes validation

📋 Testing Price Distribution...
Price distribution:
  $0.01: 2 endpoint(s)
  $0.05: 1 endpoint(s)
  $0.03: 1 endpoint(s)
✅ Price distribution is valid

📋 Testing Endpoint Naming Conventions...
✅ Endpoint naming conventions are consistent

==================================================
✅ All pricing integration tests passed!
==================================================

Pricing Summary:
  Total Endpoints: 4
  Unique Agents: 4
  Price Points: 3
  Total Revenue per Call: $0.10
```

## Status Endpoint Output

The `/api/status` endpoint now includes detailed pricing information:

```json
{
  "name": "StellarMind",
  "version": "1.0.0",
  "description": "AI Agent Marketplace with x402 Micropayments on Stellar",
  "status": "online",
  "network": "stellar:testnet",
  "facilitator": "https://www.x402.org/facilitator",
  "agents": 4,
  "x402": {
    "enabled": true,
    "middleware": "@x402/express (paymentMiddlewareFromConfig)",
    "client": "@x402/fetch (wrapFetchWithPayment + ExactStellarScheme)",
    "premiumEndpoints": [
      "GET /api/premium/research ($0.01)",
      "GET /api/premium/summarize ($0.01)",
      "GET /api/premium/analyze ($0.05)",
      "GET /api/premium/code ($0.03)"
    ],
    "pricing": [
      {
        "endpoint": "GET /api/premium/research",
        "price": "$0.01",
        "agent": "research-bot",
        "description": "Research Agent - Web research and information gathering",
        "emoji": "🔬"
      },
      {
        "endpoint": "GET /api/premium/summarize",
        "price": "$0.01",
        "agent": "summary-bot",
        "description": "Summary Agent - Text summarization and condensing",
        "emoji": "📝"
      },
      {
        "endpoint": "GET /api/premium/analyze",
        "price": "$0.05",
        "agent": "analyst-bot",
        "description": "Analysis Agent - Deep analysis and insights",
        "emoji": "📊"
      },
      {
        "endpoint": "GET /api/premium/code",
        "price": "$0.03",
        "agent": "code-bot",
        "description": "Code Agent - Code generation and debugging",
        "emoji": "💻"
      }
    ],
    "flow": "402 → wrapFetchWithPayment signs USDC tx → retry with X-PAYMENT → facilitator settles on-chain → 200"
  },
  "wallets": {
    "server": "GBUQWP3...",
    "orchestrator": "GBUQWP3...",
    "buyer": "GBUQWP3..."
  },
  "claudeEnabled": true
}
```

## Migration Checklist

- [x] Create `src/pricing.config.js` with centralized pricing
- [x] Create `src/pricing.validator.js` with validation logic
- [x] Update `src/server.js` to use pricing config
- [x] Add startup validation to `src/server.js`
- [x] Update premium endpoints to use pricing config
- [x] Update status endpoint to include pricing info
- [x] Create unit tests for validation
- [x] Create integration tests for consistency
- [x] Document pricing configuration system
- [ ] Deploy to production
- [ ] Monitor pricing consistency in logs
- [ ] Update API documentation

## Best Practices

1. **Always validate at startup** - Catch configuration errors before serving requests
2. **Use the pricing config for all pricing references** - Never hardcode prices elsewhere
3. **Keep prices in `$X.XX` format** - Ensures consistency and clarity
4. **Use descriptive agent names** - Makes pricing audits easier
5. **Include emojis for visual identification** - Improves UX in logs and dashboards
6. **Run tests after any pricing changes** - Verify consistency across all systems
7. **Document pricing changes** - Keep audit trail of pricing modifications
8. **Review pricing regularly** - Ensure prices reflect actual costs and market conditions

## Future Enhancements

1. **Environment-based pricing** - Different prices for dev/staging/production
2. **Time-based pricing** - Seasonal or time-of-day pricing variations
3. **Volume discounts** - Reduced prices for high-volume users
4. **Pricing history** - Track pricing changes over time
5. **A/B testing** - Test different pricing strategies
6. **Dynamic pricing** - Adjust prices based on demand
7. **Pricing analytics** - Track revenue by endpoint and agent
8. **Pricing alerts** - Notify on pricing anomalies

## Support

For questions or issues with the pricing configuration system, please refer to:

- Unit tests: `tests/pricing.validator.test.js`
- Integration tests: `tests/pricing.integration.test.js`
- Configuration: `src/pricing.config.js`
- Validation: `src/pricing.validator.js`
