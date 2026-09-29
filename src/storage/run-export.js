/**
 * Run report export (Issue #167)
 *
 * Turns a persisted run record into a stable, versioned artifact that can be
 * shared or reconciled outside the app:
 *
 *   - `buildRunExportJson(run, opts)`  → the versioned JSON document
 *   - `buildRunExportMarkdown(doc)`    → the same content, readable
 *
 * Everything is derived from what the run history store already persisted
 * (`run.events` for step outcomes, `run.txProofs` for receipts, `run.summary`
 * for the settled totals), so an export can be produced for any run that is
 * still in history — including runs from before this feature existed.
 *
 * The JSON shape is versioned by `RUN_EXPORT_SCHEMA_VERSION`; additive changes
 * bump it and consumers are expected to tolerate unknown fields.
 */

export const RUN_EXPORT_SCHEMA_VERSION = 1

/** Assets the marketplace settles in; kept explicit so an export never implies one. */
const DEFAULT_EXPORT_ASSET = 'USDC'

function toStep(event, index) {
  return {
    index,
    type: event.type || 'unknown',
    timestamp: event.timestamp || null,
    agentId: event.agentId || null,
    agent: event.agent || null,
    status: event.status || null,
    cost: event.cost ?? null,
    paidVia: event.paidVia || null,
    txHash: event.txHash || null,
    explorerUrl: event.explorerUrl || null,
    reason: event.reason || null,
    totalSpent: event.totalSpent ?? null,
  }
}

/**
 * Receipts are the payments the run actually settled. A proof without a
 * transaction hash is not a receipt yet, so it is reported as unconfirmed
 * instead of being silently dropped — reconciliation needs to see both.
 */
function toReceipt(proof) {
  const txHash = proof.txHash || null
  return {
    method: proof.method || 'unknown',
    network: proof.network || null,
    txHash,
    explorerUrl: proof.explorerUrl || null,
    confirmed: Boolean(txHash),
  }
}

export function buildRunExportJson(run, options = {}) {
  if (!run || typeof run !== 'object') {
    throw new TypeError('buildRunExportJson requires a run record')
  }

  const exportedAt = options.exportedAt || new Date().toISOString()
  const network = options.network ?? run.network ?? null
  const events = Array.isArray(run.events) ? run.events : []
  const proofs = Array.isArray(run.txProofs) ? run.txProofs : []

  return {
    schemaVersion: RUN_EXPORT_SCHEMA_VERSION,
    exportedAt,
    run: {
      id: run.id || run.runId || null,
      task: run.task ?? null,
      source: run.source || null,
      status: run.status || null,
      network,
      createdAt: run.createdAt || null,
      updatedAt: run.updatedAt || null,
      completedAt: run.completedAt || null,
    },
    provenance: {
      plan: run.plan ?? null,
      stepCount: events.length,
      confirmedReceiptCount: proofs.filter((proof) => proof.txHash).length,
      recordedBy: 'stellar-mind-run-history',
    },
    amounts: {
      asset: options.asset || DEFAULT_EXPORT_ASSET,
      totalSpent: run.summary?.totalSpent ?? null,
      budget: run.summary?.budget ?? run.budget ?? null,
      budgetExhausted: run.summary?.budgetExhausted ?? null,
      paymentProtocol: run.summary?.paymentProtocol ?? null,
      txCount: run.summary?.txCount ?? null,
      elapsed: run.summary?.elapsed ?? null,
    },
    steps: events.map(toStep),
    receipts: proofs.map(toReceipt),
    usage: run.usage || null,
    error: run.error || null,
    output: run.output ?? run.results ?? null,
  }
}

function renderSteps(steps) {
  if (steps.length === 0) return '_No step events were recorded for this run._\n'
  const rows = steps.map((step) => {
    const parts = [
      step.agent || step.agentId || '—',
      step.type,
      step.status ? `status=${step.status}` : null,
      step.cost != null ? `cost=${step.cost}` : null,
      step.paidVia ? `via=${step.paidVia}` : null,
      step.timestamp || null,
    ].filter(Boolean)
    return `| ${step.index} | ${parts.join(' · ')} |`
  })
  return ['| # | step |', '| --- | --- |', ...rows].join('\n') + '\n'
}

function renderReceipts(receipts) {
  if (receipts.length === 0) return '_No settled payments were recorded for this run._\n'
  const rows = receipts.map((receipt, i) => {
    const link = receipt.explorerUrl
      ? `[${receipt.txHash}](${receipt.explorerUrl})`
      : receipt.txHash
    return `| ${i + 1} | ${receipt.method} | ${receipt.network || '—'} | ${link || '—'} | ${
      receipt.confirmed ? 'yes' : 'no'
    } |`
  })
  return (
    [
      '| # | method | network | transaction | confirmed |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n') + '\n'
  )
}

export function buildRunExportMarkdown(doc) {
  if (!doc || typeof doc !== 'object' || !doc.run) {
    throw new TypeError('buildRunExportMarkdown requires an export document')
  }

  const { run, provenance, amounts, steps, receipts } = doc
  const lines = []

  lines.push(`# Run report — ${run.id || 'unknown run'}`)
  lines.push('')
  lines.push(`- **Task:** ${run.task || '—'}`)
  lines.push(`- **Status:** ${run.status || 'unknown'}`)
  lines.push(`- **Source:** ${run.source || '—'}`)
  lines.push(`- **Network:** ${run.network || '—'}`)
  lines.push(`- **Started:** ${run.createdAt || '—'}`)
  lines.push(`- **Finished:** ${run.completedAt || '—'}`)
  lines.push(`- **Exported:** ${doc.exportedAt} (report schema v${doc.schemaVersion})`)
  lines.push('')

  lines.push('## Amounts')
  lines.push('')
  lines.push(`- **Asset:** ${amounts.asset}`)
  lines.push(`- **Spent:** ${amounts.totalSpent ?? '—'}`)
  lines.push(`- **Budget:** ${amounts.budget ?? '—'}`)
  lines.push(
    `- **Budget exhausted:** ${amounts.budgetExhausted === null ? '—' : amounts.budgetExhausted}`
  )
  lines.push(`- **Payment protocol:** ${amounts.paymentProtocol || '—'}`)
  lines.push(`- **Transactions:** ${amounts.txCount ?? '—'}`)
  lines.push('')

  lines.push('## Provenance')
  lines.push('')
  lines.push(`- **Plan:** ${provenance.plan || '—'}`)
  lines.push(`- **Steps recorded:** ${provenance.stepCount}`)
  lines.push(`- **Confirmed receipts:** ${provenance.confirmedReceiptCount}`)
  lines.push('')

  lines.push('## Steps')
  lines.push('')
  lines.push(renderSteps(steps).trimEnd())
  lines.push('')

  lines.push('## Receipts')
  lines.push('')
  lines.push(renderReceipts(receipts).trimEnd())
  lines.push('')

  if (doc.error) {
    lines.push('## Error')
    lines.push('')
    lines.push(`- **${doc.error.code || 'ERROR'}:** ${doc.error.message || 'unknown error'}`)
    lines.push('')
  }

  if (Array.isArray(doc.output) && doc.output.length > 0) {
    lines.push('## Outputs')
    lines.push('')
    doc.output.forEach((entry, i) => {
      const agent = entry?.agent || entry?.agentId || `step ${i + 1}`
      const text = entry?.result ?? entry?.output ?? entry?.resultPreview ?? ''
      lines.push(`### ${agent}`)
      lines.push('')
      lines.push('```text')
      lines.push(String(text).trim())
      lines.push('```')
      lines.push('')
    })
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Suggested filename for a download, e.g. `run_123_ab.json`. */
export function exportFilename(runId, format = 'json') {
  const safeId = String(runId || 'run').replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safeId}.${format === 'md' || format === 'markdown' ? 'md' : 'json'}`
}
