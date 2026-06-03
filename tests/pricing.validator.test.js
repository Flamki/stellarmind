/**
 * Unit Tests for Pricing Configuration Validator
 *
 * Tests cover:
 * - Price format validation
 * - Endpoint format validation
 * - Endpoint info validation
 * - Complete pricing config validation
 * - x402 compatibility validation
 * - Error formatting and reporting
 */

import {
  validatePrice,
  validateEndpoint,
  validateEndpointInfo,
  validatePricingConfig,
  validateX402Compatibility,
  validateAll,
  formatValidationErrors,
  throwIfInvalid,
} from '../src/pricing.validator.js'

// ─── Test Utilities ──────────────────────────────────────────
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message}\nExpected: ${expected}\nActual: ${actual}`)
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`
    )
  }
}

function assertArrayIncludes(array, item, message) {
  if (!array.includes(item)) {
    throw new Error(`Assertion failed: ${message}\nArray does not include: ${item}`)
  }
}

// ─── Price Validation Tests ──────────────────────────────────
console.log('\n📋 Testing Price Validation...')

// Valid prices
let result = validatePrice('$0.01')
assert(result.valid, 'Should accept valid price $0.01')
assertEqual(result.value, 0.01, 'Should parse price value correctly')

result = validatePrice('$0.05')
assert(result.valid, 'Should accept valid price $0.05')
assertEqual(result.value, 0.05, 'Should parse price value correctly')

result = validatePrice('$1.00')
assert(result.valid, 'Should accept valid price $1.00')
assertEqual(result.value, 1.0, 'Should parse price value correctly')

result = validatePrice('$99.99')
assert(result.valid, 'Should accept valid price $99.99')
assertEqual(result.value, 99.99, 'Should parse price value correctly')

// Invalid prices
result = validatePrice('0.01')
assert(!result.valid, 'Should reject price without $ sign')
assertArrayIncludes(result.error, '$', 'Error should mention $ sign')

result = validatePrice('$0.1')
assert(!result.valid, 'Should reject price with only 1 decimal place')
assertArrayIncludes(result.error, 'format', 'Error should mention format')

result = validatePrice('$0.001')
assert(!result.valid, 'Should reject price with 3 decimal places')
assertArrayIncludes(result.error, 'format', 'Error should mention format')

result = validatePrice('$-0.01')
assert(!result.valid, 'Should reject negative price')
assertArrayIncludes(result.error, 'negative', 'Error should mention negative')

result = validatePrice('$0.00')
assert(!result.valid, 'Should reject zero price')
assertArrayIncludes(result.error, 'zero', 'Error should mention zero')

result = validatePrice(123)
assert(!result.valid, 'Should reject non-string price')
assertArrayIncludes(result.error, 'string', 'Error should mention type')

console.log('✅ Price validation tests passed')

// ─── Endpoint Validation Tests ───────────────────────────────
console.log('\n📋 Testing Endpoint Validation...')

// Valid endpoints
result = validateEndpoint('GET /api/premium/research')
assert(result.valid, 'Should accept valid GET endpoint')

result = validateEndpoint('POST /api/premium/analyze')
assert(result.valid, 'Should accept valid POST endpoint')

result = validateEndpoint('PUT /api/premium/code')
assert(result.valid, 'Should accept valid PUT endpoint')

result = validateEndpoint('DELETE /api/premium/summarize')
assert(result.valid, 'Should accept valid DELETE endpoint')

result = validateEndpoint('PATCH /api/premium/test')
assert(result.valid, 'Should accept valid PATCH endpoint')

// Invalid endpoints
result = validateEndpoint('GET /api/research')
assert(!result.valid, 'Should reject endpoint without /premium/')
assertArrayIncludes(result.error, 'pattern', 'Error should mention pattern')

result = validateEndpoint('GET /premium/research')
assert(!result.valid, 'Should reject endpoint without /api/')
assertArrayIncludes(result.error, 'pattern', 'Error should mention pattern')

result = validateEndpoint('GET /api/premium/')
assert(!result.valid, 'Should reject endpoint without name')
assertArrayIncludes(result.error, 'pattern', 'Error should mention pattern')

result = validateEndpoint('INVALID /api/premium/research')
assert(!result.valid, 'Should reject invalid HTTP method')
assertArrayIncludes(result.error, 'pattern', 'Error should mention pattern')

result = validateEndpoint(123)
assert(!result.valid, 'Should reject non-string endpoint')
assertArrayIncludes(result.error, 'string', 'Error should mention type')

console.log('✅ Endpoint validation tests passed')

// ─── Endpoint Info Validation Tests ──────────────────────────
console.log('\n📋 Testing Endpoint Info Validation...')

// Valid endpoint info
let info = {
  price: '$0.01',
  agent: 'research-bot',
  description: 'Research Agent',
  emoji: '🔬',
}
result = validateEndpointInfo('GET /api/premium/research', info)
assert(result.valid, 'Should accept valid endpoint info')
assertEqual(result.errors.length, 0, 'Should have no errors')

// Missing price
info = {
  agent: 'research-bot',
  description: 'Research Agent',
}
result = validateEndpointInfo('GET /api/premium/research', info)
assert(!result.valid, 'Should reject missing price')
assertArrayIncludes(result.errors[0], 'price', 'Error should mention price')

// Invalid price
info = {
  price: '0.01',
  agent: 'research-bot',
  description: 'Research Agent',
}
result = validateEndpointInfo('GET /api/premium/research', info)
assert(!result.valid, 'Should reject invalid price')
assertArrayIncludes(result.errors[0], 'price', 'Error should mention price')

// Missing agent
info = {
  price: '$0.01',
  description: 'Research Agent',
}
result = validateEndpointInfo('GET /api/premium/research', info)
assert(!result.valid, 'Should reject missing agent')
assertArrayIncludes(result.errors[0], 'agent', 'Error should mention agent')

// Invalid agent name
info = {
  price: '$0.01',
  agent: 'research bot',
  description: 'Research Agent',
}
result = validateEndpointInfo('GET /api/premium/research', info)
assert(!result.valid, 'Should reject agent with spaces')
assertArrayIncludes(result.errors[0], 'alphanumeric', 'Error should mention alphanumeric')

// Missing description
info = {
  price: '$0.01',
  agent: 'research-bot',
}
result = validateEndpointInfo('GET /api/premium/research', info)
assert(!result.valid, 'Should reject missing description')
assertArrayIncludes(result.errors[0], 'description', 'Error should mention description')

console.log('✅ Endpoint info validation tests passed')

// ─── Pricing Config Validation Tests ─────────────────────────
console.log('\n📋 Testing Pricing Config Validation...')

// Valid config
let config = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
      emoji: '🔬',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'analyst-bot',
      description: 'Analysis Agent',
      emoji: '📊',
    },
  },
}
result = validatePricingConfig(config)
assert(result.valid, 'Should accept valid pricing config')
assertEqual(result.errors.length, 0, 'Should have no errors')

// Empty endpoints
config = { endpoints: {} }
result = validatePricingConfig(config)
assert(!result.valid, 'Should reject empty endpoints')
assertArrayIncludes(result.errors[0], 'at least one', 'Error should mention minimum endpoints')

// Duplicate endpoints - can't actually test this in JS objects since keys are unique
// Instead test that we properly validate all endpoints
config = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'analyst-bot',
      description: 'Analysis Agent',
    },
  },
}
result = validatePricingConfig(config)
assert(result.valid, 'Should accept config with multiple unique endpoints')
assertEqual(result.errors.length, 0, 'Should have no errors')

// Duplicate agents
config = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
    },
    'GET /api/premium/analyze': {
      price: '$0.05',
      agent: 'research-bot',
      description: 'Analysis Agent',
    },
  },
}
result = validatePricingConfig(config)
assert(!result.valid, 'Should reject duplicate agents')
assertArrayIncludes(result.errors[0], 'Duplicate agent', 'Error should mention duplicate agent')

console.log('✅ Pricing config validation tests passed')

// ─── x402 Compatibility Tests ────────────────────────────────
console.log('\n📋 Testing x402 Compatibility Validation...')

// Valid x402 config
let appConfig = {
  network: 'stellar:testnet',
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
}
result = validateX402Compatibility(config, appConfig)
assert(result.valid, 'Should accept valid x402 config')
assertEqual(result.errors.length, 0, 'Should have no errors')

// Missing network
appConfig = {
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
}
result = validateX402Compatibility(config, appConfig)
assert(!result.valid, 'Should reject missing network')
assertArrayIncludes(result.errors[0], 'network', 'Error should mention network')

// Missing payTo
appConfig = {
  network: 'stellar:testnet',
}
result = validateX402Compatibility(config, appConfig)
assert(!result.valid, 'Should reject missing payTo')
assertArrayIncludes(result.errors[0], 'payTo', 'Error should mention payTo')

console.log('✅ x402 compatibility validation tests passed')

// ─── Comprehensive Validation Tests ──────────────────────────
console.log('\n📋 Testing Comprehensive Validation...')

config = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
      emoji: '🔬',
    },
  },
}
appConfig = {
  network: 'stellar:testnet',
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
}
result = validateAll(config, appConfig)
assert(result.valid, 'Should accept valid complete config')
assertEqual(result.errors.length, 0, 'Should have no errors')

console.log('✅ Comprehensive validation tests passed')

// ─── Error Formatting Tests ─────────────────────────────────
console.log('\n📋 Testing Error Formatting...')

result = validateAll(config, appConfig)
let formatted = formatValidationErrors(result)
assertArrayIncludes(formatted, '✅', 'Valid config should show checkmark')

config = { endpoints: {} }
result = validateAll(config, appConfig)
formatted = formatValidationErrors(result)
assertArrayIncludes(formatted, '❌', 'Invalid config should show X mark')
assertArrayIncludes(formatted, 'Errors:', 'Should show errors section')

console.log('✅ Error formatting tests passed')

// ─── throwIfInvalid Tests ───────────────────────────────────
console.log('\n📋 Testing throwIfInvalid...')

config = {
  endpoints: {
    'GET /api/premium/research': {
      price: '$0.01',
      agent: 'research-bot',
      description: 'Research Agent',
    },
  },
}
result = validateAll(config, appConfig)
try {
  throwIfInvalid(result)
  // Should not throw
} catch (err) {
  throw new Error('Should not throw for valid config')
}

config = { endpoints: {} }
result = validateAll(config, appConfig)
try {
  throwIfInvalid(result, 'Test context')
  throw new Error('Should have thrown for invalid config')
} catch (err) {
  assertArrayIncludes(err.message, 'Test context', 'Error should include context')
}

console.log('✅ throwIfInvalid tests passed')

// ─── Summary ────────────────────────────────────────────────
console.log('\n' + '='.repeat(50))
console.log('✅ All pricing validator tests passed!')
console.log('='.repeat(50))
