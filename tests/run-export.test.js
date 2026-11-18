import assert from 'node:assert'
import {
  buildRunReportPayload,
  generateRunReportMarkdown,
} from '../src/reports/runReportGenerator.js'

console.log('Testing Run Report Export (#167)...')

// Test 1: Basic payload construction and versioning
{
  const mockRun = {
    id: 'run_test_12345',
    status: 'completed',
    task: 'Analyze market volatility',
    budget: 5,
    startedAt: '2026-11-18T10:00:00.000Z',
    completedAt: '2026-11-18T10:00:05.000Z',
    plan: '1. Fetch prices\n2. Compute variance',
    spent: 0.15,
    settledTotals: [{ amount: '0.15', asset: 'USDC' }],
    paymentAttempts: [
      {
        method: 'x402',
        outcome: 'confirmed',
        settledAmount: '0.15',
        settledAsset: 'USDC',
        network: 'stellar:testnet',
        txHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        agentId: 'market-analyst',
      },
      {
        method: 'demo',
        outcome: 'confirmed',
        isSynthetic: true,
        settledAmount: '0.00',
        settledAsset: 'USDC',
        network: 'stellar:testnet',
        txHash: null,
        agentId: 'demo-agent',
      },
    ],
    output: [
      {
        agent: 'market-analyst',
        content: { summary: 'Market is stable', confidence: 0.95 },
      },
    ],
  }

  const payload = buildRunReportPayload(mockRun)
  assert.strictEqual(payload.version, 1, 'Version must be 1')
  assert.strictEqual(payload.runId, 'run_test_12345')
  assert.strictEqual(payload.status, 'completed')
  assert.strictEqual(payload.receipts.length, 2)
  assert.strictEqual(payload.receipts[0].status, 'CONFIRMED')
  assert.strictEqual(payload.receipts[0].isSynthetic, false)
  assert.strictEqual(payload.receipts[1].isSynthetic, true)
  assert.strictEqual(payload.steps.length, 1)
  assert.strictEqual(payload.steps[0].agent, 'market-analyst')
  console.log('  ✓ Versioned payload matches run detail')
}

// Test 2: Sanitization of credentials and local filesystem paths
{
  const sensitiveRun = {
    id: 'run_secret_999',
    status: 'failed',
    task: 'Deploy secret to /var/app/deploy/secrets/config.json',
    budget: 1,
    plan: 'Load key from C:\\Users\\Administrator\\keys\\deploy.key',
    output: [
      {
        agent: 'deployer',
        apiKey: 'sk-secret-key-12345678',
        stellarSecret: 'SB765432101234567890123456789012345678901234567890123456',
        result: 'Connected with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      },
    ],
  }

  const payload = buildRunReportPayload(sensitiveRun)
  assert(!payload.task.includes('/var/app/deploy'), 'Deployment paths must be redacted')
  assert(!payload.plan.includes('C:\\Users'), 'Local filesystem paths must be redacted')
  assert.strictEqual(payload.steps[0].output.apiKey, '[REDACTED]', 'API keys must be redacted')
  assert.strictEqual(
    payload.steps[0].output.stellarSecret,
    '[REDACTED]',
    'Stellar private keys must be redacted'
  )
  assert(!payload.steps[0].output.result.includes('eyJhb'), 'JWT Bearer tokens must be redacted')
  console.log('  ✓ Sensitive paths, private keys, and tokens are scrubbed')
}

// Test 3: Markdown generation
{
  const mockRun = {
    id: 'run_md_test',
    status: 'completed',
    task: 'Execute financial projection',
    budget: 10,
    startedAt: '2026-11-18T12:00:00.000Z',
    completedAt: '2026-11-18T12:00:10.000Z',
    settledTotals: [{ amount: '1.50', asset: 'USDC' }],
    paymentAttempts: [
      {
        method: 'x402',
        outcome: 'confirmed',
        settledAmount: '1.50',
        settledAsset: 'USDC',
        network: 'stellar:testnet',
        txHash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      },
    ],
    output: [{ agent: 'financial-model', content: 'ROI estimated at 24%' }],
  }

  const payload = buildRunReportPayload(mockRun)
  const md = generateRunReportMarkdown(payload)
  assert(md.includes('# StellarMind Execution Report'), 'Markdown has title')
  assert(md.includes('run_md_test'), 'Markdown includes run ID')
  assert(md.includes('Verifiable Payment Receipts'), 'Markdown includes receipts table')
  assert(md.includes('1234567890...abcdef'), 'Markdown includes shortened txHash link')
  assert(md.includes('ROI estimated at 24%'), 'Markdown includes step output')
  console.log('  ✓ Markdown export formatting verified')
}

console.log('All export report tests passed! ✓')
