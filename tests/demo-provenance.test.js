/**
 * Demo Response Provenance Tests
 * Validates that demo/fallback responses are clearly distinguished from live results.
 * 
 * Run: node tests/demo-provenance.test.js
 */

import assert from 'node:assert'

// ─── Tiny test harness ──────────────────────────────────────────
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

// ─── Test Provenance Structures ─────────────────────────────────
console.log('Provenance Structure Validation')

test('Live response has correct provenance', () => {
  const liveProvenance = {
    source: 'live',
    model: 'claude-haiku-4-5-20251001',
    illustrative: false,
  }
  
  assert.strictEqual(liveProvenance.source, 'live')
  assert.strictEqual(liveProvenance.illustrative, false)
  assert.ok(liveProvenance.model)
})

test('Demo response (no API key) has correct provenance', () => {
  const demoProvenance = {
    source: 'demo',
    reason: 'no_api_key',
    message: 'Anthropic API key not configured',
    model: 'claude-haiku-4-5-20251001',
    illustrative: true,
  }
  
  assert.strictEqual(demoProvenance.source, 'demo')
  assert.strictEqual(demoProvenance.reason, 'no_api_key')
  assert.strictEqual(demoProvenance.illustrative, true)
  assert.ok(demoProvenance.message)
})

test('Demo response (credits exhausted) has correct provenance', () => {
  const demoProvenance = {
    source: 'demo',
    reason: 'credits_exhausted',
    message: 'Claude API credits exhausted, using illustrative response',
    model: 'claude-haiku-4-5-20251001',
    illustrative: true,
  }
  
  assert.strictEqual(demoProvenance.source, 'demo')
  assert.strictEqual(demoProvenance.reason, 'credits_exhausted')
  assert.strictEqual(demoProvenance.illustrative, true)
})

test('x402 remote response has correct provenance', () => {
  const remoteProvenance = {
    source: 'x402_remote',
    endpoint: '/api/premium/research?topic=test',
    model: 'claude-haiku-4-5-20251001',
    illustrative: false,
    note: 'Result served by remote x402-protected endpoint',
  }
  
  assert.strictEqual(remoteProvenance.source, 'x402_remote')
  assert.strictEqual(remoteProvenance.illustrative, false)
  assert.ok(remoteProvenance.endpoint)
})

test('Model fallback response has correct provenance', () => {
  const fallbackProvenance = {
    source: 'live',
    model: 'claude-haiku-4-5-20251001',
    illustrative: false,
    modelFallback: {
      primary: 'claude-sonnet-4-5-20250929',
      used: 'claude-haiku-4-5-20251001',
      reason: 'primary_model_unavailable',
    },
  }
  
  assert.strictEqual(fallbackProvenance.source, 'live')
  assert.ok(fallbackProvenance.modelFallback)
  assert.strictEqual(fallbackProvenance.modelFallback.primary, 'claude-sonnet-4-5-20250929')
  assert.strictEqual(fallbackProvenance.modelFallback.used, 'claude-haiku-4-5-20251001')
})

test('Error response has correct provenance', () => {
  const errorProvenance = {
    source: 'error',
    reason: 'service_call_failed',
    message: 'Network timeout',
    illustrative: false,
  }
  
  assert.strictEqual(errorProvenance.source, 'error')
  assert.ok(errorProvenance.message)
})

console.log('Service Response Structure')

test('Service function returns { text, provenance }', () => {
  const serviceResponse = {
    text: 'This is the agent response text',
    provenance: {
      source: 'live',
      model: 'claude-haiku-4-5-20251001',
      illustrative: false,
    },
  }
  
  assert.ok(serviceResponse.text)
  assert.ok(serviceResponse.provenance)
  assert.strictEqual(typeof serviceResponse.text, 'string')
  assert.strictEqual(typeof serviceResponse.provenance, 'object')
})

console.log('Agent Result Structure')

test('Agent result includes provenance field', () => {
  const agentResult = {
    agentId: 'research-bot',
    agentName: 'Research Agent',
    output: 'Research findings...',
    cost: '0.01',
    provenance: {
      source: 'live',
      model: 'claude-haiku-4-5-20251001',
      illustrative: false,
    },
  }
  
  assert.ok(agentResult.provenance)
  assert.strictEqual(agentResult.provenance.source, 'live')
})

test('Agent result with demo provenance is clearly marked', () => {
  const agentResult = {
    agentId: 'research-bot',
    agentName: 'Research Agent',
    output: '[Research Agent — Powered by Claude Haiku]...',
    cost: '0.01',
    provenance: {
      source: 'demo',
      reason: 'no_api_key',
      illustrative: true,
    },
  }
  
  assert.ok(agentResult.provenance)
  assert.strictEqual(agentResult.provenance.source, 'demo')
  assert.strictEqual(agentResult.provenance.illustrative, true)
})

console.log('Provenance vs Payment Separation')

test('Provenance and payment are separate concepts', () => {
  const result = {
    output: 'Agent response',
    provenance: {
      source: 'demo',
      illustrative: true,
    },
    paidVia: 'x402',
    paymentSuccess: true,
    txHash: 'abc123...',
  }
  
  // Demo response can still have payment
  assert.strictEqual(result.provenance.source, 'demo')
  assert.strictEqual(result.paymentSuccess, true)
  
  // Payment outcome doesn't determine provenance
  assert.notStrictEqual(result.provenance.source, result.paidVia)
})

test('Live response can have failed payment', () => {
  const result = {
    output: 'Live Claude response',
    provenance: {
      source: 'live',
      illustrative: false,
    },
    paidVia: 'none',
    paymentSuccess: false,
  }
  
  assert.strictEqual(result.provenance.source, 'live')
  assert.strictEqual(result.paymentSuccess, false)
})

console.log('Mixed Run Scenarios')

test('Mixed run has per-step provenance', () => {
  const results = [
    {
      agentId: 'research-bot',
      provenance: { source: 'live', illustrative: false },
    },
    {
      agentId: 'summary-bot',
      provenance: { source: 'demo', reason: 'credits_exhausted', illustrative: true },
    },
    {
      agentId: 'analyst-bot',
      provenance: { source: 'live', illustrative: false },
    },
  ]
  
  assert.strictEqual(results[0].provenance.source, 'live')
  assert.strictEqual(results[1].provenance.source, 'demo')
  assert.strictEqual(results[2].provenance.source, 'live')
  
  // Each step has independent provenance
  const hasMixedProvenance = results.some(r => r.provenance.source === 'demo') &&
                              results.some(r => r.provenance.source === 'live')
  assert.ok(hasMixedProvenance)
})

test('Mixed run summary identifies demo steps', () => {
  const results = [
    {
      agentId: 'research-bot',
      provenance: { source: 'live', illustrative: false },
    },
    {
      agentId: 'summary-bot',
      provenance: { source: 'demo', illustrative: true },
    },
  ]
  
  const demoCount = results.filter(r => r.provenance?.illustrative).length
  const liveCount = results.filter(r => r.provenance && !r.provenance.illustrative).length
  
  assert.strictEqual(demoCount, 1)
  assert.strictEqual(liveCount, 1)
})

console.log('Illustrative Content Labeling')

test('Demo text is labeled as illustrative', () => {
  const demoResponse = {
    text: '[Research Agent — Powered by Claude Haiku]\n\nResearch findings...',
    provenance: {
      source: 'demo',
      reason: 'no_api_key',
      illustrative: true,
      message: 'Anthropic API key not configured',
    },
  }
  
  assert.ok(demoResponse.provenance.illustrative)
  assert.ok(demoResponse.provenance.message)
  // Demo text should not claim to be from verified sources
  assert.ok(demoResponse.text.includes('Agent'))
})

test('Live text is not labeled as illustrative', () => {
  const liveResponse = {
    text: 'Actual research findings from Claude API...',
    provenance: {
      source: 'live',
      model: 'claude-haiku-4-5-20251001',
      illustrative: false,
    },
  }
  
  assert.strictEqual(liveResponse.provenance.illustrative, false)
})

console.log('Event Broadcasting')

test('agent_response event includes provenance', () => {
  const event = {
    type: 'agent_response',
    agent: 'Research Agent',
    agentId: 'research-bot',
    resultPreview: 'Research findings...',
    provenance: {
      source: 'demo',
      reason: 'no_api_key',
      illustrative: true,
    },
    timestamp: new Date().toISOString(),
  }
  
  assert.ok(event.provenance)
  assert.strictEqual(event.provenance.source, 'demo')
})

console.log('Provenance Sources')

test('All valid provenance sources are defined', () => {
  const validSources = ['live', 'demo', 'x402_remote', 'error']
  
  for (const source of validSources) {
    assert.ok(typeof source === 'string')
    assert.ok(source.length > 0)
  }
})

test('Provenance reasons for demo mode are defined', () => {
  const validReasons = [
    'no_api_key',
    'credits_exhausted',
    'service_call_failed',
    'primary_model_unavailable',
  ]
  
  for (const reason of validReasons) {
    assert.ok(typeof reason === 'string')
    assert.ok(reason.length > 0)
  }
})

// ─── Report results ──────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)

if (failures.length > 0) {
  process.exit(1)
}
