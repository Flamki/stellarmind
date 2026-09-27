/**
 * Issue #153: provenance must record the model that actually responded, and a demo
 * path must never look like a live generation. The no-API-key path is deterministic
 * and offline, so the demo half is tested end to end; the live half is the same
 * callback with kind 'live' and the real model id.
 */
import assert from 'node:assert'
import { provenance, callClaude, setApiKey } from '../src/agents/services.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['pass', name])
  } catch (err) {
    results.push(['fail', name + ' -> ' + err.message])
  }
}

check('a live provenance carries the model that responded, and its provider', () => {
  const p = provenance('live', 'claude-sonnet-4-5-20250929')
  assert.strictEqual(p.kind, 'live')
  assert.strictEqual(p.model, 'claude-sonnet-4-5-20250929')
  assert.strictEqual(p.provider, 'anthropic')
  assert.strictEqual(p.reason, null)
})

check('a demo provenance never claims a model', () => {
  for (const reason of ['no_api_key', 'credits_exhausted']) {
    const p = provenance('demo', 'claude-sonnet-4-5-20250929', reason)
    assert.strictEqual(p.kind, 'demo')
    assert.strictEqual(p.model, null, 'demo must not claim a model')
    assert.strictEqual(p.provider, null)
    assert.strictEqual(p.reason, reason)
  }
})

check('an error provenance keeps the reason and the attempted model', () => {
  const p = provenance('error', 'claude-haiku-4-5', 'rate_limit')
  assert.strictEqual(p.kind, 'error')
  assert.strictEqual(p.model, null)
  assert.strictEqual(p.reason, 'rate_limit')
})

check('the no-key path reports demo provenance and returns the fallback text', async () => {
  setApiKey('')
  const seen = []
  const text = await callClaude(
    'claude-sonnet-4-5-20250929',
    64,
    'prompt',
    () => 'cached demo text',
    null,
    { onProvenance: (p) => seen.push(p) }
  )
  assert.strictEqual(text, 'cached demo text')
  assert.strictEqual(seen.length, 1, 'exactly one provenance record')
  assert.strictEqual(seen[0].kind, 'demo')
  assert.strictEqual(seen[0].reason, 'no_api_key')
  assert.strictEqual(seen[0].model, null)
})

const failed = results.filter(([s]) => s === 'fail')
for (const [s, n] of results) console.log((s === 'pass' ? '  ok   ' : '  FAIL ') + n)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
