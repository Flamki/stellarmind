# Pricing Configuration Error Examples

This document provides real-world examples of common pricing configuration errors and how the
validation system catches them.

## Error Scenario 1: Missing Dollar Sign

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '0.01',  // ❌ Missing '$' prefix
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price must be in format '$X.XX', got '0.01'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',  // ✅ Add '$' prefix
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 2: Wrong Decimal Places

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.1',  // ❌ Only 1 decimal place
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price must be in format '$X.XX', got '$0.1'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.10',  // ✅ Use exactly 2 decimal places
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 3: Negative Price

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$-0.01',  // ❌ Negative price
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price cannot be negative: '$-0.01'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',  // ✅ Use positive price
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 4: Zero Price

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.00',  // ❌ Zero price not allowed
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price cannot be zero: '$0.00'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',  // ✅ Use minimum price of $0.01
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 5: Missing Endpoint Field

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.01',
  // ❌ Missing 'agent' field
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Missing 'agent' for endpoint 'GET /api/premium/research'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',
  agent: 'research-bot',  // ✅ Add required field
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 6: Invalid Endpoint Format

### Problem

```javascript
// In src/pricing.config.js
'GET /api/research': {  // ❌ Missing '/premium/' in path
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid endpoint format: Endpoint must match pattern 'METHOD /api/premium/name', got 'GET /api/research'
```

### Solution

```javascript
'GET /api/premium/research': {  // ✅ Include '/premium/' in path
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 7: Invalid HTTP Method

### Problem

```javascript
// In src/pricing.config.js
'INVALID /api/premium/research': {  // ❌ Invalid HTTP method
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid endpoint format: Endpoint must match pattern 'METHOD /api/premium/name', got 'INVALID /api/premium/research'
```

### Solution

```javascript
'GET /api/premium/research': {  // ✅ Use valid HTTP method
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 8: Duplicate Agent

### Problem

```javascript
// In src/pricing.config.js
export const pricingConfig = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot', // ← Same agent
      description: 'Research Agent',
      emoji: '🔬',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'research-bot', // ❌ Duplicate agent
      description: 'Analysis Agent',
      emoji: '📊',
    },
  },
}
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Duplicate agent: 'research-bot' used in multiple endpoints
```

### Solution

```javascript
export const pricingConfig = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
      emoji: '🔬',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'analyst-bot', // ✅ Use unique agent name
      description: 'Analysis Agent',
      emoji: '📊',
    },
  },
}
```

---

## Error Scenario 9: Invalid Agent Name

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.01',
  agent: 'research bot',  // ❌ Contains space
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Agent name must be alphanumeric with hyphens for 'GET /api/premium/research', got 'research bot'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',
  agent: 'research-bot',  // ✅ Use hyphens instead of spaces
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 10: Empty Endpoints

### Problem

```javascript
// In src/pricing.config.js
export const pricingConfig = {
  endpoints: {}, // ❌ No endpoints defined
}
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Pricing config must have at least one endpoint
```

### Solution

```javascript
export const pricingConfig = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
      emoji: '🔬',
    },
    // ... add more endpoints
  },
}
```

---

## Error Scenario 11: Missing x402 Configuration

### Problem

```javascript
// In src/server.js
const pricingValidation = validateAll(pricingConfig, {
  // ❌ Missing 'network' and 'payTo'
})
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Config must have "network" property for x402 compatibility
  2. Config must have "payTo" property (server address) for x402 compatibility
```

### Solution

```javascript
// In src/server.js
const pricingValidation = validateAll(pricingConfig, {
  network: config.network, // ✅ Add network
  payTo: config.serverAddress, // ✅ Add server address
})
```

---

## Error Scenario 12: Invalid x402 Address

### Problem

```javascript
// In src/server.js
const pricingValidation = validateAll(pricingConfig, {
  network: 'stellar:testnet',
  payTo: 123, // ❌ Should be string
})
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Config "payTo" must be a string, got number
```

### Solution

```javascript
// In src/server.js
const pricingValidation = validateAll(pricingConfig, {
  network: 'stellar:testnet',
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC', // ✅ Use string
})
```

---

## Error Scenario 13: Missing Description

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: '$0.01',
  agent: 'research-bot',
  // ❌ Missing 'description' field
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Missing 'description' for endpoint 'GET /api/premium/research'
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent - Web research and information gathering',  // ✅ Add description
  emoji: '🔬',
},
```

---

## Error Scenario 14: Non-String Price

### Problem

```javascript
// In src/pricing.config.js
'GET /api/premium/research': {
  price: 0.01,  // ❌ Number instead of string
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid price for 'GET /api/premium/research': Price must be a string, got number
```

### Solution

```javascript
'GET /api/premium/research': {
  price: '$0.01',  // ✅ Use string format
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
},
```

---

## Error Scenario 15: Multiple Errors

### Problem

```javascript
// In src/pricing.config.js
export const pricingConfig = {
  endpoints: {
    'GET /api/research': {
      // ❌ Missing '/premium/'
      price: '0.01', // ❌ Missing '$'
      agent: 'research bot', // ❌ Contains space
      // ❌ Missing 'description'
      emoji: '🔬',
    },
  },
}
```

### Error Output

```text
❌ FATAL: Pricing configuration validation failed
❌ Pricing configuration validation failed:

Errors:
  1. Invalid endpoint format: Endpoint must match pattern 'METHOD /api/premium/name', got 'GET /api/research'
  2. Invalid price for 'GET /api/research': Price must be in format '$X.XX', got '0.01'
  3. Agent name must be alphanumeric with hyphens for 'GET /api/research', got 'research bot'
  4. Missing 'description' for endpoint 'GET /api/research'
```

### Solution

```javascript
export const pricingConfig = {
  endpoints: {
    'GET /api/premium/research': {
      // ✅ Add '/premium/'
      price: '$0.01', // ✅ Add '$' and correct format
      agent: 'research-bot', // ✅ Use hyphens
      description: 'Research Agent - Web research and information gathering', // ✅ Add description
      emoji: '🔬',
    },
  },
}
```

---

## Testing Error Scenarios

You can test these error scenarios using the validation functions directly:

```javascript
import {
  validatePrice,
  validateEndpoint,
  validateEndpointInfo,
  validateAll,
} from './src/pricing.validator.js'

// Test invalid price
const priceResult = validatePrice('0.01')
console.log(priceResult)
// { valid: false, error: "Price must be in format '$X.XX', got '0.01'" }

// Test invalid endpoint
const endpointResult = validateEndpoint('GET /api/research')
console.log(endpointResult)
// { valid: false, error: "Endpoint must match pattern 'METHOD /api/premium/name', got 'GET /api/research'" }

// Test invalid endpoint info
const infoResult = validateEndpointInfo('GET /api/premium/research', {
  price: '$0.01',
  agent: 'research bot',
  description: 'Research Agent',
})
console.log(infoResult)
// { valid: false, errors: ["Agent name must be alphanumeric with hyphens..."] }

// Test complete config
const configResult = validateAll(badConfig, appConfig)
console.log(configResult)
// { valid: false, errors: [...], warnings: [] }
```

---

## Prevention Tips

1. **Use TypeScript** - Add type definitions for pricing config to catch errors at compile time
2. **Use a linter** - Configure ESLint to validate pricing config structure
3. **Use a schema validator** - Use JSON Schema to validate pricing config
4. **Run tests before deployment** - Always run `npm test` before deploying
5. **Use version control** - Track pricing changes in git with meaningful commit messages
6. **Code review** - Have pricing changes reviewed by another team member
7. **Staging environment** - Test pricing changes in staging before production
8. **Monitoring** - Monitor pricing consistency in production logs
9. **Alerts** - Set up alerts for pricing validation failures
10. **Documentation** - Keep pricing documentation up to date

---

## Quick Reference

| Error                             | Cause                            | Solution                                             |
| --------------------------------- | -------------------------------- | ---------------------------------------------------- |
| `Price must be in format '$X.XX'` | Wrong format                     | Use `$X.XX` format (e.g., `$0.01`)                   |
| `Price cannot be negative`        | Negative price                   | Use positive price (e.g., `$0.01`)                   |
| `Price cannot be zero`            | Zero price                       | Use minimum price of `$0.01`                         |
| `Price must be a string`          | Non-string price                 | Use string format (e.g., `'$0.01'`)                  |
| `Endpoint must match pattern`     | Invalid endpoint                 | Use `METHOD /api/premium/name` format                |
| `Missing 'agent'`                 | Missing field                    | Add `agent` field with agent name                    |
| `Missing 'description'`           | Missing field                    | Add `description` field                              |
| `Missing 'price'`                 | Missing field                    | Add `price` field in `$X.XX` format                  |
| `Agent name must be alphanumeric` | Invalid agent name               | Use alphanumeric with hyphens (e.g., `research-bot`) |
| `Duplicate agent`                 | Same agent in multiple endpoints | Use unique agent names                               |
| `Config must have "network"`      | Missing network config           | Add `network` to config object                       |
| `Config must have "payTo"`        | Missing server address           | Add `payTo` (server address) to config               |
