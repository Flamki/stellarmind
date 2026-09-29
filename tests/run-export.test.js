import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'
import {
  buildRunExportJson,
  buildRunExportMarkdown,
  exportFilename,
  RUN_EXPORT_SCHEMA_VERSION,
} from '../src/storage/run-export.js'

console.log('Testing run report export (Issue #167)...\n')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function assertThrows(fn, message) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`Expected to throw: ${message}`)
}

async function seedRun(store) {
  const { runId } = await store.createRun({
    task: 'Summarize the Stellar docs and propose a plan',
    budget: 5,
    source: 'api',
  })

  await store.appendEvent(runId, {
    type: 'orchestrator_plan',
    timestamp: '2026-09-29T10:00:00.000Z',
    reason: 'Three subtasks selected',
  })
  // The same agent twice: an export must show two steps, not one deduplicated
  // step (see Issue #163 for the live-progress half of the same problem).
  await store.appendEvent(runId, {
    type: 'agent_call',
    agent: 'Research Agent',
    agentId: 'research-bot',
    cost: '0.01',
    paidVia: 'x402',
    timestamp: '2026-09-29T10:00:01.000Z',
  })
  await store.appendEvent(runId, {
    type: 'agent_call',
    agent: 'Research Agent',
    agentId: 'research-bot',
    cost: '0.01',
    paidVia: 'x402',
    timestamp: '2026-09-29T10:00:05.000Z',
  })
  await store.appendEvent(runId, {
    type: 'agent_response',
    agent: 'Research Agent',
    agentId: 'research-bot',
    cost: '0.01',
    status: 'ok',
    timestamp: '2026-09-29T10:00:07.000Z',
  })

  await store.completeRun(runId, {
    totalSpent: '0.03',
    budget: 5,
    budgetExhausted: false,
    paymentProtocol: 'x402',
    txCount: 2,
    x402PaymentCount: 2,
    xlmFallbackCount: 0,
    unpaidCount: 0,
    elapsed: 7,
    plan: 'research → summarize',
    results: [{ agent: 'Research Agent', result: 'Docs summarized.' }],
    usage: { entries: [], summary: {} },
    payments: [
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'abc123hash',
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc123hash',
      },
      {
        // Settled without a hash: reported as an unconfirmed receipt, not dropped.
        paymentSuccess: true,
        paidVia: 'xlm-direct',
        txHash: null,
        explorerUrl: null,
      },
      {
        // Failed payment: not a receipt at all.
        paymentSuccess: false,
        paidVia: 'x402',
        txHash: 'never-settled',
      },
    ],
  })

  return runId
}

const store = new InMemoryRunHistoryStore(50, { network: 'testnet' })
const runId = await seedRun(store)
const run = await store.getRun(runId)

// ── JSON export ─────────────────────────────────────────────────────────────

console.log('Test 1: JSON export carries identity, provenance, amounts and receipts')
const doc = buildRunExportJson(run)

assertEqual(doc.schemaVersion, RUN_EXPORT_SCHEMA_VERSION, 'schema version')
assert(typeof doc.exportedAt === 'string' && doc.exportedAt.length > 0, 'exportedAt must be set')

assertEqual(doc.run.id, runId, 'run id')
assertEqual(doc.run.status, 'completed', 'run status')
assertEqual(doc.run.network, 'testnet', 'network comes from the store')
assertEqual(doc.run.createdAt, run.createdAt, 'createdAt is preserved')
assertEqual(doc.run.completedAt, run.completedAt, 'completedAt is preserved')
assertEqual(doc.run.task, run.task, 'task is preserved')

assertEqual(doc.provenance.plan, 'research → summarize', 'plan is part of provenance')
assertEqual(doc.provenance.stepCount, 4, 'all four step events are exported')
assertEqual(
  doc.provenance.confirmedReceiptCount,
  1,
  'only the hashed payment is a confirmed receipt'
)

assertEqual(doc.amounts.asset, 'USDC', 'asset is stated explicitly')
assertEqual(doc.amounts.totalSpent, '0.03', 'actual settled amount is exported')
assertEqual(doc.amounts.budget, 5, 'budget is exported')

assertEqual(doc.steps.length, 4, 'step count')
assertEqual(doc.steps[1].agent, 'Research Agent', 'step agent')
assertEqual(doc.steps[1].index, 1, 'steps are numbered from 0')
assertEqual(doc.steps[2].agent, 'Research Agent', 'the same agent twice stays two steps')

assertEqual(doc.receipts.length, 2, 'failed payments are not receipts')
assertEqual(doc.receipts[0].method, 'x402', 'receipt method')
assertEqual(doc.receipts[0].network, 'testnet', 'receipt carries the network')
assertEqual(doc.receipts[0].txHash, 'abc123hash', 'receipt carries the transaction hash')
assertEqual(doc.receipts[0].confirmed, true, 'hashed receipt is confirmed')
assertEqual(doc.receipts[1].confirmed, false, 'hashless receipt is reported as unconfirmed')

// The document must survive a round-trip through JSON (it is a download).
const roundTripped = JSON.parse(JSON.stringify(doc))
assertEqual(JSON.stringify(roundTripped), JSON.stringify(doc), 'export is JSON-stable')

console.log('Test 2: Markdown export is readable and carries the same facts')
const md = buildRunExportMarkdown(doc)

for (const needle of [
  runId,
  'Summarize the Stellar docs',
  'testnet',
  'Research Agent',
  'abc123hash',
  'https://stellar.expert/explorer/testnet/tx/abc123hash',
  '0.03',
  'Receipts',
  'Steps',
  `report schema v${RUN_EXPORT_SCHEMA_VERSION}`,
]) {
  assert(md.includes(needle), `markdown must mention ${needle}`)
}
assertEqual(md.includes('never-settled'), false, 'failed payments must not appear as receipts')
assert(md.split('# Run report').length === 2, 'markdown has a single title')

console.log('Test 3: exports survive a sparse run (no steps, no receipts, failed)')
const sparseStore = new InMemoryRunHistoryStore(10, { network: 'mainnet' })
const { runId: failedId } = await sparseStore.createRun({ task: 'boom', budget: 1 })
await sparseStore.failRun(
  failedId,
  Object.assign(new Error('provider exploded'), { code: 'PROVIDER_ERROR' })
)
const failedRun = await sparseStore.getRun(failedId)
const failedDoc = buildRunExportJson(failedRun)
assertEqual(failedDoc.run.network, 'mainnet', 'network still reported')
assertEqual(failedDoc.steps.length, 0, 'no steps')
assertEqual(failedDoc.receipts.length, 0, 'no receipts')
assertEqual(failedDoc.error.code, 'PROVIDER_ERROR', 'error is exported')
const failedMd = buildRunExportMarkdown(failedDoc)
assert(failedMd.includes('No step events were recorded'), 'empty steps are called out')
assert(failedMd.includes('PROVIDER_ERROR'), 'error appears in markdown')

console.log('Test 4: invalid input and unsupported shapes are rejected or defaulted')
assertThrows(() => buildRunExportJson(null), 'null run must be rejected')
assertThrows(() => buildRunExportMarkdown({}), 'a document without run must be rejected')
assertEqual(exportFilename('run_1/../etc', 'json'), 'run_1_.._etc.json', 'filename is sanitized')
assertEqual(exportFilename(runId, 'markdown'), `${runId}.md`, 'markdown extension')

// A network taken from the run record is used when the caller does not pass one.
const docWithoutOptions = buildRunExportJson(run)
assertEqual(docWithoutOptions.run.network, 'testnet', 'network falls back to the run record')

console.log('\nAll run-export tests passed.')
