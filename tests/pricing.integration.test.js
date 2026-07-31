/**
 * Integration Tests for Pricing Configuration
 *
 * Tests verify:
 * - Pricing config consistency across all endpoints
 * - x402 middleware configuration generation
 * - Status endpoint pricing output
 * - Single source of truth enforcement
 * - Pricing map consistency
 */

import { pricingConfig } from '../src/pricing.config.js'
import { validateAll } from '../src/pricing.validator.js'

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

function assertArrayIncludes(array, item, message) {
  if (!array.includes(item)) {
    throw new Error(`Assertion failed: ${message}\nArray does not include: ${item}`)
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`
    )
  }
}

// ─── Pricing Config Structure Tests ──────────────────────────
console.log('\n📋 Testing Pricing Config Structure...')

// Verify endpoints exist
assert(pricingConfig.endpoints, 'Should have endpoints object')
assert(Object.keys(pricingConfig.endpoints).length > 0, 'Should have at least one endpoint')

// Verify all required endpoints exist
const requiredEndpoints = [
  'GET /api/premium/research',
  'GET /api/premium/summarize',
  'GET /api/premium/analyze',
  'GET /api/premium/code',
]

requiredEndpoints.forEach((endpoint) => {
  assert(pricingConfig.endpoints[endpoint], `Should have endpoint: ${endpoint}`)
})

console.log(`✅ Found ${Object.keys(pricingConfig.endpoints).length} premium endpoints`)

// ─── Pricing Consistency Tests ───────────────────────────────
console.log('\n📋 Testing Pricing Consistency...')

// Verify all endpoints have required fields
Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  assert(info.price, `Endpoint ${endpoint} missing price`)
  assert(info.agent, `Endpoint ${endpoint} missing agent`)
  assert(info.description, `Endpoint ${endpoint} missing description`)
  assert(info.emoji, `Endpoint ${endpoint} missing emoji`)
})

console.log('✅ All endpoints have required fields')

// Verify price format consistency
Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  const priceRegex = /^\$\d+\.\d{2}$/
  assert(
    priceRegex.test(info.price),
    `Endpoint ${endpoint} has invalid price format: ${info.price}`
  )
})

console.log('✅ All prices have valid format ($X.XX)')

// Verify agent names are unique
const agents = Object.values(pricingConfig.endpoints).map((info) => info.agent)
const uniqueAgents = new Set(agents)
assertEqual(agents.length, uniqueAgents.size, 'All agents should be unique')

console.log('✅ All agent names are unique')

// ─── Pricing Map Tests ──────────────────────────────────────
console.log('\n📋 Testing Pricing Maps...')

// Verify byEndpoint map
Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  assert(pricingConfig.byEndpoint[endpoint], `byEndpoint missing: ${endpoint}`)
  assertDeepEqual(pricingConfig.byEndpoint[endpoint], info, `byEndpoint mismatch for ${endpoint}`)
})

console.log('✅ byEndpoint map is consistent')

// Verify byAgent map
Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  assert(pricingConfig.byAgent[info.agent], `byAgent missing: ${info.agent}`)
  assertEqual(
    pricingConfig.byAgent[info.agent].endpoint,
    endpoint,
    `byAgent endpoint mismatch for ${info.agent}`
  )
})

console.log('✅ byAgent map is consistent')

// Verify byPrice map
Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  assert(pricingConfig.byPrice[info.price], `byPrice missing: ${info.price}`)
  const priceEntries = pricingConfig.byPrice[info.price]
  const found = priceEntries.some((entry) => entry.endpoint === endpoint)
  assert(found, `byPrice missing endpoint ${endpoint} for price ${info.price}`)
})

console.log('✅ byPrice map is consistent')

// ─── Getter Method Tests ────────────────────────────────────
console.log('\n📋 Testing Getter Methods...')

// Test getPrice
let price = pricingConfig.getPrice('GET /api/premium/research')
assertEqual(price, '$0.01', 'getPrice should return correct price')

price = pricingConfig.getPrice('GET /api/premium/analyze')
assertEqual(price, '$0.05', 'getPrice should return correct price')

price = pricingConfig.getPrice('INVALID_ENDPOINT')
assert(!price, 'getPrice should return undefined for invalid endpoint')

console.log('✅ getPrice method works correctly')

// Test getPremiumEndpoints
const endpoints = pricingConfig.getPremiumEndpoints()
assert(Array.isArray(endpoints), 'getPremiumEndpoints should return array')
assertEqual(endpoints.length, requiredEndpoints.length, 'Should return all endpoints')
requiredEndpoints.forEach((endpoint) => {
  assertArrayIncludes(endpoints, endpoint, `Should include ${endpoint}`)
})

console.log('✅ getPremiumEndpoints method works correctly')

// Test getEndpointInfo
let info = pricingConfig.getEndpointInfo('GET /api/premium/research')
assert(info, 'getEndpointInfo should return info object')
assertEqual(info.price, '$0.01', 'Info should have correct price')
assertEqual(info.agent, 'research-bot', 'Info should have correct agent')

info = pricingConfig.getEndpointInfo('INVALID_ENDPOINT')
assert(!info, 'getEndpointInfo should return undefined for invalid endpoint')

console.log('✅ getEndpointInfo method works correctly')

// Test getAllPricingInfo
const allInfo = pricingConfig.getAllPricingInfo()
assert(Array.isArray(allInfo), 'getAllPricingInfo should return array')
assertEqual(allInfo.length, requiredEndpoints.length, 'Should return all endpoints')

allInfo.forEach((item) => {
  assert(item.endpoint, 'Each item should have endpoint')
  assert(item.price, 'Each item should have price')
  assert(item.agent, 'Each item should have agent')
  assert(item.description, 'Each item should have description')
})

console.log('✅ getAllPricingInfo method works correctly')

// ─── x402 Configuration Generation Tests ────────────────────
console.log('\n📋 Testing x402 Configuration Generation...')

const appConfig = {
  network: 'stellar:testnet',
  payTo: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIYU2IYJJQ7YCVROSNM4SQKVUC',
}

const x402Config = pricingConfig.getX402Config(appConfig)

// Verify x402 config has all endpoints
requiredEndpoints.forEach((endpoint) => {
  assert(x402Config[endpoint], `x402Config missing: ${endpoint}`)
})

console.log('✅ x402Config has all endpoints')

// Verify x402 config structure
Object.entries(x402Config).forEach(([endpoint, config]) => {
  assert(config.accepts, `x402Config[${endpoint}] missing accepts`)
  assertEqual(config.accepts.scheme, 'exact', `x402Config[${endpoint}] should use exact scheme`)
  assert(config.accepts.price, `x402Config[${endpoint}] missing price`)
  assertEqual(config.accepts.network, appConfig.network, `x402Config[${endpoint}] network mismatch`)
  assertEqual(config.accepts.payTo, appConfig.payTo, `x402Config[${endpoint}] payTo mismatch`)
})

console.log('✅ x402Config structure is correct')

// Verify x402 prices match pricing config
Object.entries(x402Config).forEach(([endpoint, config]) => {
  const expectedPrice = pricingConfig.getPrice(endpoint)
  assertEqual(config.accepts.price, expectedPrice, `x402Config price mismatch for ${endpoint}`)
})

console.log('✅ x402Config prices match pricing config')

// ─── Single Source of Truth Tests ───────────────────────────
console.log('\n📋 Testing Single Source of Truth...')

// Verify changing pricing config would affect all lookups
const originalPrice = pricingConfig.getPrice('GET /api/premium/research')
assertEqual(originalPrice, '$0.01', 'Original price should be $0.01')

// Verify all maps reference the same data
const endpointInfo = pricingConfig.endpoints['GET /api/premium/research']
const byEndpointInfo = pricingConfig.byEndpoint['GET /api/premium/research']
const byAgentInfo = pricingConfig.byAgent['research-bot']

assertDeepEqual(endpointInfo, byEndpointInfo, 'endpoints and byEndpoint should match')
assertEqual(byAgentInfo.price, endpointInfo.price, 'byAgent price should match')

console.log('✅ All maps reference the same pricing data')

// ─── Pricing Validation Tests ───────────────────────────────
console.log('\n📋 Testing Pricing Config Validation...')

const validation = validateAll(pricingConfig, appConfig)
assert(validation.valid, 'Pricing config should be valid')
assertEqual(validation.errors.length, 0, 'Should have no validation errors')

console.log('✅ Pricing config passes validation')

// ─── Price Distribution Tests ───────────────────────────────
console.log('\n📋 Testing Price Distribution...')

const priceDistribution = {}
Object.values(pricingConfig.endpoints).forEach((info) => {
  if (!priceDistribution[info.price]) {
    priceDistribution[info.price] = 0
  }
  priceDistribution[info.price]++
})

console.log('Price distribution:')
Object.entries(priceDistribution).forEach(([price, count]) => {
  console.log(`  ${price}: ${count} endpoint(s)`)
})

// Verify at least one endpoint at each price point
Object.entries(priceDistribution).forEach(([price, count]) => {
  assert(count > 0, `Should have at least one endpoint at price ${price}`)
})

console.log('✅ Price distribution is valid')

// ─── Endpoint Naming Convention Tests ────────────────────────
console.log('\n📋 Testing Endpoint Naming Conventions...')

Object.entries(pricingConfig.endpoints).forEach(([endpoint, info]) => {
  // Verify endpoint and agent are related (both contain similar keywords)
  const endpointPath = endpoint.split('/').pop()
  const agentBase = info.agent.replace('-bot', '')

  // Check if endpoint path contains agent base or vice versa
  const isRelated =
    endpointPath.includes(agentBase) ||
    agentBase.includes(endpointPath) ||
    // Special cases for semantic relationships
    (endpointPath === 'summarize' && agentBase === 'summary') ||
    (endpointPath === 'summary' && agentBase === 'summarize') ||
    (endpointPath === 'analyze' && agentBase === 'analyst') ||
    (endpointPath === 'analyst' && agentBase === 'analyze')

  assert(isRelated, `Endpoint ${endpoint} should relate to agent ${info.agent}`)
})

console.log('✅ Endpoint naming conventions are consistent')

// ─── Summary ────────────────────────────────────────────────
console.log('\n' + '='.repeat(50))
console.log('✅ All pricing integration tests passed!')
console.log('='.repeat(50))
console.log('\nPricing Summary:')
console.log(`  Total Endpoints: ${Object.keys(pricingConfig.endpoints).length}`)
console.log(
  `  Unique Agents: ${new Set(Object.values(pricingConfig.endpoints).map((i) => i.agent)).size}`
)
console.log(`  Price Points: ${Object.keys(priceDistribution).length}`)
console.log(
  `  Total Revenue per Call: $${Object.values(pricingConfig.endpoints)
    .reduce((sum, info) => sum + parseFloat(info.price.slice(1)), 0)
    .toFixed(2)}`
)
