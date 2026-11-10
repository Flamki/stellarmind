/**
 * Persist actual model and prompt version for each step (issue #153).
 */

import assert from 'node:assert'
import { AGENT_MODELS, runAnalysis, runResearch } from '../src/agents/services.js'
import { orchestrate } from '../src/agents/orchestrator.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import { buildPromptRevision, computePromptDigest } from '../src/prompts/index.js'

async function runTests() {
  // 1. Primary model success records actual model, provider, and prompt revision
  {
    let meta = null
    const output = await runAnalysis('Stellar x402 adoption', {
      apiKey: 'test-key-not-persisted',
      createMessage: async (payload) => ({
        model: payload.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 42, output_tokens: 84 },
        content: [{ type: 'text', text: 'Structured analysis output' }],
      }),
      onExecutionMeta: (m) => {
        meta = m
      },
    })

    assert.strictEqual(output, 'Structured analysis output')
    assert.ok(meta, 'execution metadata should be emitted')
    assert.strictEqual(meta.provider, 'anthropic')
    assert.strictEqual(meta.actualModel, AGENT_MODELS.analysisPrimary)
    assert.strictEqual(meta.fallbackUsed, false)
    assert.strictEqual(meta.isDemo, false)
    assert.ok(meta.promptVersion.startsWith('analyst-bot@1.0.0#sha256:'))
    assert.ok(meta.promptDigest.startsWith('sha256:'))
    assert.ok(!JSON.stringify(meta).includes('test-key-not-persisted'))
  }

  // 2. Model fallback records the fallback model that actually responded
  {
    let meta = null
    let attempts = 0
    const output = await runAnalysis('Fallback analysis topic', {
      apiKey: 'test-key',
      createMessage: async (payload) => {
        attempts += 1
        if (payload.model === AGENT_MODELS.analysisPrimary) {
          const err = new Error(`model ${payload.model} not found`)
          err.status = 404
          throw err
        }
        return {
          model: payload.model,
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 30 },
          content: [{ type: 'text', text: 'Fallback model analysis' }],
        }
      },
      onExecutionMeta: (m) => {
        meta = m
      },
    })

    assert.strictEqual(attempts, 2)
    assert.strictEqual(output, 'Fallback model analysis')
    assert.strictEqual(meta.provider, 'anthropic')
    assert.strictEqual(meta.actualModel, AGENT_MODELS.analysisFallback)
    assert.strictEqual(meta.fallbackUsed, true)
    assert.strictEqual(meta.fallbackReason, 'primary_model_unavailable')
    assert.strictEqual(meta.isDemo, false)
  }

  // 3. Demo fallback records explicit demo provenance rather than claiming a live model
  {
    let meta = null
    const output = await runResearch('Demo topic', {
      apiKey: '',
      onExecutionMeta: (m) => {
        meta = m
      },
    })

    assert.ok(output.length > 0)
    assert.strictEqual(meta.provider, 'demo')
    assert.strictEqual(meta.actualModel, 'demo')
    assert.strictEqual(meta.isDemo, true)
    assert.strictEqual(meta.fallbackReason, 'no_api_key')
    assert.ok(meta.promptVersion.startsWith('research-bot@1.0.0#sha256:'))
  }

  // 4. Differing prompt content produces a different prompt revision/digest
  {
    let metaV1 = null
    let metaV2 = null
    await runResearch('Topic A', {
      apiKey: '',
      promptTemplate: 'Prompt version one: {topic}',
      onExecutionMeta: (m) => {
        metaV1 = m
      },
    })
    await runResearch('Topic A', {
      apiKey: '',
      promptTemplate: 'Prompt version two (revised): {topic}',
      onExecutionMeta: (m) => {
        metaV2 = m
      },
    })

    assert.notStrictEqual(metaV1.promptDigest, metaV2.promptDigest)
    assert.notStrictEqual(metaV1.promptVersion, metaV2.promptVersion)
    assert.strictEqual(
      computePromptDigest('Prompt version one: {topic}'),
      buildPromptRevision('research-bot', 'Prompt version one: {topic}').digest
    )
  }

  // 5. Orchestrator and RunHistoryStore persist per-step model & prompt version metadata
  {
    const store = new InMemoryRunHistoryStore()
    const created = await store.createRun({
      task: 'Evaluate Stellar payment channels',
      budget: 0.1,
      source: 'test',
    })

    const result = await orchestrate('Evaluate Stellar payment channels', 0.1, null, {
      x402Fetch: null,
      sendPayment: async () => ({ success: true, txHash: 'tx_153' }),
      plan: {
        plan: 'Two-step test plan',
        subtasks: [
          { stepId: 'step-0', agentId: 'research-bot', input: 'Stellar channels', cost: '0.01' },
          { stepId: 'step-1', agentId: 'analyst-bot', input: 'Stellar channels', cost: '0.05' },
        ],
      },
      serviceMap: {
        'research-bot': (input, opts) =>
          runResearch(input, {
            ...opts,
            apiKey: 'k',
            createMessage: async (payload) => ({
              model: payload.model,
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 20 },
              content: [{ type: 'text', text: 'Live research findings' }],
            }),
          }),
        'analyst-bot': (input, opts) =>
          runAnalysis(input, {
            ...opts,
            apiKey: 'k',
            createMessage: async (payload) => {
              if (payload.model === AGENT_MODELS.analysisPrimary) {
                throw new Error('model not found')
              }
              return {
                model: payload.model,
                stop_reason: 'end_turn',
                usage: { input_tokens: 15, output_tokens: 25 },
                content: [{ type: 'text', text: 'Fallback analysis findings' }],
              }
            },
          }),
      },
    })

    await store.completeRun(created.runId, result)
    const saved = await store.getRun(created.runId)

    assert.strictEqual(saved.results.length, 2)
    assert.strictEqual(saved.results[0].provider, 'anthropic')
    assert.strictEqual(saved.results[0].actualModel, AGENT_MODELS.research)
    assert.ok(saved.results[0].promptVersion.startsWith('research-bot@1.0.0#sha256:'))

    assert.strictEqual(saved.results[1].provider, 'anthropic')
    assert.strictEqual(saved.results[1].actualModel, AGENT_MODELS.analysisFallback)
    assert.strictEqual(saved.results[1].executionMeta.fallbackUsed, true)

    assert.strictEqual(saved.executionMetadata.length, 2)
    assert.strictEqual(saved.executionMetadata[1].actualModel, AGENT_MODELS.analysisFallback)
    assert.strictEqual(saved.executionMetadata[1].promptDigest, saved.results[1].promptDigest)
  }

  console.log('✓ All step model and prompt version tests passed')
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
