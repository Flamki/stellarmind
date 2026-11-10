/**
 * Identify demo responses separately from live model results (issue #151).
 */

import assert from 'node:assert'
import {
  AGENT_MODELS,
  DEMO_DISCLAIMER,
  FALLBACKS,
  runAnalysis,
  runResearch,
  runSummary,
} from '../src/agents/services.js'
import { orchestrate } from '../src/agents/orchestrator.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'

async function runTests() {
  // 1. Demo text is explicitly labeled as illustrative and never claims verified sources
  {
    for (const [key, fn] of Object.entries(FALLBACKS)) {
      const sample = fn('test input')
      assert.ok(sample.includes('[DEMO —'), `${key} fallback should carry [DEMO — ...] header`)
      assert.ok(
        sample.includes(DEMO_DISCLAIMER),
        `${key} fallback should include illustrative disclaimer`
      )
      assert.ok(
        !sample.includes('Sources:'),
        `${key} fallback must not imply retrieved or verified sources`
      )
      assert.ok(
        !sample.includes('Powered by Claude'),
        `${key} fallback must not claim live Claude execution`
      )
    }
  }

  // 2. Missing API key fixture emits demo provenance with no_api_key reason
  {
    const res = await runResearch('Stellar micropayments', {
      apiKey: '',
      withProvenance: true,
    })
    assert.ok(res.text.includes('[DEMO —'))
    assert.deepStrictEqual(res.provenance, {
      source: 'demo',
      isDemo: true,
      fallbackReason: 'no_api_key',
      model: 'demo',
      configuredModel: AGENT_MODELS.research,
    })
  }

  // 3. Rate-limited fixture emits demo provenance with rate_limited reason
  {
    let capturedProv = null
    const text = await runSummary('Sample input text for summarization', {
      apiKey: 'live-key',
      createMessage: async () => {
        const err = new Error('rate_limit_error: too many requests')
        err.status = 429
        throw err
      },
      onProvenance: (p) => {
        capturedProv = p
      },
    })
    assert.ok(text.includes('[DEMO —'))
    assert.strictEqual(capturedProv.source, 'demo')
    assert.strictEqual(capturedProv.isDemo, true)
    assert.strictEqual(capturedProv.fallbackReason, 'rate_limited')
    assert.strictEqual(capturedProv.model, 'demo')
  }

  // 4. Live-success and model-fallback fixtures emit non-demo provenance
  {
    let liveProv = null
    const liveOut = await runResearch('Live query', {
      apiKey: 'live-key',
      createMessage: async (payload) => ({
        model: payload.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 25 },
        content: [{ type: 'text', text: 'Live verified response' }],
      }),
      onProvenance: (p) => {
        liveProv = p
      },
    })
    assert.strictEqual(liveOut, 'Live verified response')
    assert.strictEqual(liveProv.source, 'live')
    assert.strictEqual(liveProv.isDemo, false)
    assert.strictEqual(liveProv.fallbackReason, null)
    assert.strictEqual(liveProv.model, AGENT_MODELS.research)

    let modelFallbackProv = null
    await runAnalysis('Model fallback query', {
      apiKey: 'live-key',
      createMessage: async (payload) => {
        if (payload.model === AGENT_MODELS.analysisPrimary) {
          throw new Error('model not found')
        }
        return {
          model: payload.model,
          stop_reason: 'end_turn',
          usage: { input_tokens: 18, output_tokens: 30 },
          content: [{ type: 'text', text: 'Fallback model output' }],
        }
      },
      onProvenance: (p) => {
        modelFallbackProv = p
      },
    })
    assert.strictEqual(modelFallbackProv.source, 'model-fallback')
    assert.strictEqual(modelFallbackProv.isDemo, false)
    assert.strictEqual(modelFallbackProv.fallbackReason, 'primary_model_unavailable')
    assert.strictEqual(modelFallbackProv.model, AGENT_MODELS.analysisFallback)
  }

  // 5. Mixed live/demo orchestration run keeps payment outcome separate from output provenance
  {
    const events = []
    const store = new InMemoryRunHistoryStore()
    const created = await store.createRun({
      task: 'Mixed provenance task',
      budget: 0.1,
      source: 'test',
    })

    const result = await orchestrate(
      'Mixed provenance task',
      0.1,
      (ev) => {
        events.push(ev)
        store.appendEvent(created.runId, ev)
      },
      {
        x402Fetch: null,
        sendPayment: async () => ({ success: true, txHash: 'tx_mixed_151' }),
        plan: {
          plan: 'Mixed live and demo plan',
          subtasks: [
            { stepId: 'step-0', agentId: 'research-bot', input: 'Topic 1', cost: '0.01' },
            { stepId: 'step-1', agentId: 'summary-bot', input: 'Topic 1', cost: '0.01' },
          ],
        },
        serviceMap: {
          'research-bot': (input, opts) =>
            runResearch(input, {
              ...opts,
              apiKey: 'live-key',
              createMessage: async (payload) => ({
                model: payload.model,
                stop_reason: 'end_turn',
                usage: { input_tokens: 12, output_tokens: 24 },
                content: [{ type: 'text', text: 'Live research output' }],
              }),
            }),
          'summary-bot': (input, opts) =>
            runSummary(input, {
              ...opts,
              apiKey: 'live-key',
              createMessage: async () => {
                const err = new Error('rate_limit_error')
                err.status = 429
                throw err
              },
            }),
        },
      }
    )

    await store.completeRun(created.runId, result)
    const saved = await store.getRun(created.runId)

    // Step 0: live output + paid
    assert.strictEqual(result.results[0].outputSource, 'live')
    assert.strictEqual(result.results[0].isDemo, false)
    assert.strictEqual(result.results[0].paymentSuccess, true)

    // Step 1: demo output (rate_limited) + still independently tracks payment settlement
    assert.strictEqual(result.results[1].outputSource, 'demo')
    assert.strictEqual(result.results[1].isDemo, true)
    assert.strictEqual(result.results[1].fallbackReason, 'rate_limited')
    assert.strictEqual(result.results[1].paymentSuccess, true)

    // Run-level provenance summary
    assert.strictEqual(result.provenanceMode, 'mixed')
    assert.strictEqual(result.liveStepCount, 1)
    assert.strictEqual(result.demoStepCount, 1)
    assert.strictEqual(saved.summary.provenanceMode, 'mixed')
    assert.strictEqual(saved.summary.liveStepCount, 1)
    assert.strictEqual(saved.summary.demoStepCount, 1)

    const completeEvent = events.find((e) => e.type === 'orchestrator_complete')
    assert.strictEqual(completeEvent.provenanceMode, 'mixed')
    assert.strictEqual(completeEvent.demoStepCount, 1)
    assert.strictEqual(completeEvent.liveStepCount, 1)
  }

  console.log('✓ All demo response provenance tests passed')
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
