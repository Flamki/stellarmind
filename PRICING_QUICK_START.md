# Pricing Configuration - Quick Start Guide

## 5-Minute Overview

The pricing configuration system provides a centralized, validated way to manage all premium
endpoint pricing in StellarMind.

### Key Files

| File                                | Purpose                           |
| ----------------------------------- | --------------------------------- |
| `src/pricing.config.js`             | Centralized pricing configuration |
| `src/pricing.validator.js`          | Validation logic                  |
| `src/server.js`                     | Updated to use pricing config     |
| `tests/pricing.validator.test.js`   | Unit tests                        |
| `tests/pricing.integration.test.js` | Integration tests                 |

## How It Works

### 1. Configuration

All pricing is defined in one place:

```javascript
// src/pricing.config.js
export const pricingConfig = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
      emoji: '🔬',
    },
    // ... more endpoints
  },
}
```

### 2. Validation

Configuration is validated at startup:

```javascript
// src/server.js
const pricingValidation = validateAll(pricingConfig, {
  network: config.network,
  payTo: config.serverAddress,
})

if (!pricingValidation.valid) {
  console.error('❌ FATAL: Pricing configuration validation failed')
  process.exit(1)
}
```

### 3. Usage

Pricing is used throughout the application:

```javascript
// Get price for endpoint
const price = pricingConfig.getPrice('GET /api/premium/research')

// Generate x402 middleware config
const x402Config = pricingConfig.getX402Config(config)

// Get all pricing info for status endpoint
const allPricing = pricingConfig.getAllPricingInfo()
```

## Common Tasks

### Change a Price

**Before:**

```javascript
// In src/server.js - HARDCODED
'GET /api/premium/research': {
  accepts: {
    scheme: 'exact',
    price: '$0.01',  // ← Change here
    // ...
  },
},
```

**After:**

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.02',  // ← Change here
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

This single change automatically updates:

- ✅ x402 middleware configuration
- ✅ Status endpoint output
- ✅ Broadcast events
- ✅ All pricing lookups

### Add a New Premium Endpoint

1. Add to `src/pricing.config.js`:

```javascript
'GET /api/premium/translate': {
  price: '$0.02',
  agent: 'translator-bot',
  description: 'Translation Agent',
  emoji: '🌐',
},
```

2. Add endpoint handler in `src/server.js`:

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

### Query Pricing Information

```javascript
import { pricingConfig } from './src/pricing.config.js'

// Get price for specific endpoint
pricingConfig.getPrice('GET /api/premium/research')
// '$0.01'

// Get all premium endpoints
pricingConfig.getPremiumEndpoints()
// ['GET /api/premium/research', 'GET /api/premium/summarize', ...]

// Get endpoint info
pricingConfig.getEndpointInfo('GET /api/premium/research')
// { price: '$0.01', agent: 'research-bot', description: '...', emoji: '🔬' }

// Get all pricing info
pricingConfig.getAllPricingInfo()
// [{ endpoint: '...', price: '...', agent: '...', ... }, ...]

// Lookup by agent
pricingConfig.byAgent['research-bot']
// { endpoint: 'GET /api/premium/research', price: '$0.01', ... }

// Lookup by price
pricingConfig.byPrice['$0.01']
// [{ endpoint: 'GET /api/premium/research', agent: 'research-bot' }, ...]
```

## Running Tests

### Unit Tests

```bash
node tests/pricing.validator.test.js
```

**Output:**

```
✅ Price validation tests passed
✅ Endpoint validation tests passed
✅ Endpoint info validation tests passed
✅ Pricing config validation tests passed
✅ x402 compatibility validation tests passed
✅ Comprehensive validation tests passed
✅ Error formatting tests passed
✅ throwIfInvalid tests passed

==================================================
✅ All pricing validator tests passed!
==================================================
```

### Integration Tests

```bash
node tests/pricing.integration.test.js
```

**Output:**

```
✅ Pricing config structure tests passed
✅ Pricing consistency tests passed
✅ Pricing maps tests passed
✅ Getter methods tests passed
✅ x402 configuration generation tests passed
✅ Single source of truth tests passed
✅ Pricing config validation tests passed
✅ Price distribution tests passed
✅ Endpoint naming convention tests passed

==================================================
✅ All pricing integration tests passed!
==================================================

Pricing Summary:
  Total Endpoints: 4
  Unique Agents: 4
  Price Points: 3
  Total Revenue per Call: $0.10
```

## Price Format Rules

Prices must follow the format: `$X.XX`

✅ Valid prices:

- `$0.01` - Minimum price
- `$0.05` - Five cents
- `$1.00` - One dollar
- `$99.99` - Maximum reasonable price

❌ Invalid prices:

- `0.01` - Missing `$`
- `$0.1` - Only 1 decimal place
- `$0.001` - 3 decimal places
- `$-0.01` - Negative price
- `$0.00` - Zero price

## Endpoint Format Rules

Endpoints must follow the format: `METHOD /api/premium/name`

✅ Valid endpoints:

- `GET /api/premium/research`
- `POST /api/premium/analyze`
- `PUT /api/premium/code`
- `DELETE /api/premium/summarize`
- `PATCH /api/premium/translate`

❌ Invalid endpoints:

- `GET /api/research` - Missing `/premium/`
- `GET /premium/research` - Missing `/api/`
- `GET /api/premium/` - Missing name
- `INVALID /api/premium/research` - Invalid HTTP method

## Agent Name Rules

Agent names must be alphanumeric with hyphens.

✅ Valid agent names:

- `research-bot`
- `summary-bot`
- `analyst-bot`
- `code-bot`
- `translator-bot`

❌ Invalid agent names:

- `research bot` - Contains space
- `research_bot` - Contains underscore
- `research.bot` - Contains period
- `ResearchBot` - Contains uppercase (use lowercase)

## Error Handling

### Validation Fails at Startup

If pricing configuration is invalid, the server will fail to start with a clear error message:

```
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price must be in format '$X.XX', got '0.01'
  2. Duplicate agent: 'research-bot' used in multiple endpoints
```

### Common Errors

| Error                             | Solution                                             |
| --------------------------------- | ---------------------------------------------------- |
| `Price must be in format '$X.XX'` | Use `$X.XX` format (e.g., `$0.01`)                   |
| `Price cannot be negative`        | Use positive price (e.g., `$0.01`)                   |
| `Price cannot be zero`            | Use minimum price of `$0.01`                         |
| `Endpoint must match pattern`     | Use `METHOD /api/premium/name` format                |
| `Missing 'agent'`                 | Add `agent` field with agent name                    |
| `Duplicate agent`                 | Use unique agent names                               |
| `Agent name must be alphanumeric` | Use alphanumeric with hyphens (e.g., `research-bot`) |

For more error examples, see `PRICING_ERROR_EXAMPLES.md`.

## Status Endpoint

The `/api/status` endpoint now includes detailed pricing information:

```bash
curl http://localhost:3001/api/status | jq '.x402.pricing'
```

**Output:**

```json
[
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
]
```

## Best Practices

1. **Always validate before deploying** - Run tests to ensure pricing is valid
2. **Use consistent price points** - Stick to common prices like $0.01, $0.05, $0.10
3. **Document price changes** - Keep a changelog of pricing modifications
4. **Review pricing regularly** - Ensure prices reflect actual costs
5. **Test in staging first** - Deploy pricing changes to staging before production
6. **Monitor pricing consistency** - Check logs for validation errors
7. **Use version control** - Track pricing changes in git
8. **Get code review** - Have pricing changes reviewed by another team member

## Troubleshooting

### Server Won't Start

Check the error message for pricing validation failures:

```bash
npm start
# Look for: ❌ FATAL: Pricing configuration validation failed
```

### Pricing Not Updating

1. Verify you edited `src/pricing.config.js` (not `src/server.js`)
2. Restart the server
3. Check `/api/status` endpoint to verify pricing

### Tests Failing

Run tests to identify issues:

```bash
node tests/pricing.validator.test.js
node tests/pricing.integration.test.js
```

## Documentation

- **Full documentation:** `PRICING_REFACTOR.md`
- **Error examples:** `PRICING_ERROR_EXAMPLES.md`
- **Refactoring summary:** `REFACTORING_SUMMARY.md`
- **Unit tests:** `tests/pricing.validator.test.js`
- **Integration tests:** `tests/pricing.integration.test.js`

## Support

For questions or issues:

1. Check `PRICING_ERROR_EXAMPLES.md` for common errors
2. Review `PRICING_REFACTOR.md` for detailed documentation
3. Run tests to verify configuration
4. Check server logs for validation errors

## Next Steps

1. ✅ Review pricing configuration in `src/pricing.config.js`
2. ✅ Run tests to verify everything works
3. ✅ Deploy to staging environment
4. ✅ Test pricing in staging
5. ✅ Deploy to production
6. ✅ Monitor pricing consistency in logs
7. ✅ Update API documentation

---

**Last Updated:** May 26, 2026 **Version:** 1.0.0
