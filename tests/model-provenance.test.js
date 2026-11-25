/**
 * Model + prompt provenance tests (issue #153).
 * Covers the live, model-fallback and demo paths of the agent services.
 *
 * Run: node tests/model-provenance.test.js
 */
import assert from 'node:assert'
import { config } from '../src/config.js'
import {
  anthropic,
  AGENT_MODELS,
  PROMPT_TEMPLATES,
  runResearch,
  runAnalysis,
  runCode,
} from '../src/agents/services.js'
import { promptDigest, renderPromptTemplate } from '../src/agents/provenance.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'

const failures = []
let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

function okMessage(model, id = 'msg_test_1') {
  return {
    id,
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  }
}

const realCreate = anthropic.messages.create
const realKey = config.anthropicApiKey
function stub(fn) {
  anthropic.messages.create = fn
}

console.log('Model and prompt provenance')

await test('live success records provider, actual model and prompt revision', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  let sent
  stub(async (payload) => {
    sent = payload
    return okMessage(`${payload.model}`)
  })
  const { provenance } = await runResearch('stellar fees')
  assert.strictEqual(provenance.source, 'live')
  assert.strictEqual(provenance.provider, 'anthropic')
  assert.strictEqual(provenance.model, AGENT_MODELS.research)
  assert.strictEqual(provenance.requestedModel, AGENT_MODELS.research)
  assert.strictEqual(provenance.responseId, 'msg_test_1')
  assert.strictEqual(provenance.promptId, 'research')
  assert.strictEqual(provenance.promptRevision, promptDigest(PROMPT_TEMPLATES.research))
  assert.strictEqual(provenance.promptDigest, promptDigest(sent.messages[0].content))
  assert.match(provenance.promptRevision, /^sha256:[0-9a-f]{16}$/)
  assert.strictEqual(provenance.illustrative, false)
})

await test('recorded model is what the API reported, not the requested one', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  stub(async () => okMessage('claude-haiku-4-5-snapshot-x'))
  const { provenance } = await runResearch('x')
  assert.strictEqual(provenance.model, 'claude-haiku-4-5-snapshot-x')
  assert.strictEqual(provenance.requestedModel, AGENT_MODELS.research)
})

await test('model fallback records the model that actually responded', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  const calls = []
  stub(async (payload) => {
    calls.push(payload.model)
    if (payload.model === AGENT_MODELS.analysisPrimary) {
      const err = new Error(`model: ${payload.model} not_found_error`)
      err.status = 404
      throw err
    }
    return okMessage(payload.model)
  })
  const { provenance } = await runAnalysis('market')
  assert.deepStrictEqual(calls, [AGENT_MODELS.analysisPrimary, AGENT_MODELS.analysisFallback])
  assert.strictEqual(provenance.model, AGENT_MODELS.analysisFallback)
  assert.strictEqual(provenance.requestedModel, AGENT_MODELS.analysisFallback)
  assert.strictEqual(provenance.modelFallback.primary, AGENT_MODELS.analysisPrimary)
  assert.strictEqual(provenance.modelFallback.used, AGENT_MODELS.analysisFallback)
  assert.strictEqual(provenance.promptId, 'analysis')
  assert.ok(provenance.promptRevision)
})

await test('primary success on the analysis agent has no fallback marker', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  stub(async (payload) => okMessage(payload.model))
  const { provenance } = await runAnalysis('market')
  assert.strictEqual(provenance.model, AGENT_MODELS.analysisPrimary)
  assert.strictEqual(provenance.modelFallback, undefined)
})

await test('demo output claims no live model, provider or prompt', async () => {
  config.anthropicApiKey = ''
  stub(async () => {
    throw new Error('must not be called')
  })
  const { provenance } = await runCode('write fn')
  assert.strictEqual(provenance.source, 'demo')
  assert.strictEqual(provenance.illustrative, true)
  assert.strictEqual(provenance.model, null)
  assert.strictEqual(provenance.provider, null)
  assert.strictEqual(provenance.promptRevision, null)
  assert.strictEqual(provenance.promptDigest, null)
  assert.strictEqual(provenance.intendedModel, AGENT_MODELS.code)
})

await test('credits-exhausted demo output is also explicit demo provenance', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  stub(async () => {
    const err = new Error('rate_limit')
    err.status = 429
    throw err
  })
  const { provenance } = await runResearch('x')
  assert.strictEqual(provenance.source, 'demo')
  assert.strictEqual(provenance.reason, 'credits_exhausted')
  assert.strictEqual(provenance.model, null)
})

await test('different prompt content changes the recorded revision', () => {
  const a = promptDigest('You are a research agent. {input}')
  const b = promptDigest('You are a research agent! {input}')
  assert.notStrictEqual(a, b)
  assert.strictEqual(a, promptDigest('You are a research agent. {input}'))
})

await test('prompt digest follows the input; revision does not', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  stub(async (payload) => okMessage(payload.model))
  const one = (await runResearch('topic one')).provenance
  const two = (await runResearch('topic two')).provenance
  assert.strictEqual(one.promptRevision, two.promptRevision)
  assert.notStrictEqual(one.promptDigest, two.promptDigest)
})

await test('every agent template has a distinct revision', () => {
  const revisions = Object.values(PROMPT_TEMPLATES).map(promptDigest)
  assert.strictEqual(new Set(revisions).size, revisions.length)
})

await test('rendering inserts input literally and keeps the prompt text unchanged', () => {
  assert.strictEqual(renderPromptTemplate('A {input} B', "$& $1 $'"), "A $& $1 $' B")
  assert.ok(
    renderPromptTemplate(PROMPT_TEMPLATES.research, 'T').endsWith(
      '(4-5 sentences with key facts and data points): T'
    )
  )
})

await test('provenance never contains credentials', async () => {
  config.anthropicApiKey = 'sk-secret-value-123'
  stub(async (payload) => okMessage(payload.model))
  const { provenance } = await runResearch('x')
  assert.ok(!JSON.stringify(provenance).includes('sk-secret-value-123'))
})

await test('stored run keeps provenance so the fixture can be selected later', async () => {
  config.anthropicApiKey = 'sk-test-not-real'
  stub(async (payload) => okMessage(payload.model))
  const live = await runResearch('persist me')
  config.anthropicApiKey = ''
  const demo = await runCode('persist me')
  const store = new InMemoryRunHistoryStore()
  const run = await store.createRun({ task: 't', budget: 1 })
  await store.completeRun(run.id, {
    results: [
      { agentId: 'research-bot', provenance: live.provenance },
      { agentId: 'code-bot', provenance: demo.provenance },
    ],
  })
  const saved = await store.getRun(run.id)
  const [a, b] = saved.results.map((r) => r.provenance)
  assert.deepStrictEqual(a, live.provenance)
  assert.strictEqual(a.promptId, 'research')
  assert.ok(a.model && a.provider && a.promptRevision)
  assert.strictEqual(b.source, 'demo')
  assert.strictEqual(b.model, null)
})

anthropic.messages.create = realCreate
config.anthropicApiKey = realKey

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
