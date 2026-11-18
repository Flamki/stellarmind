/**
 * Run Report Generator & Exporter (issue #167)
 * Produces structured versioned JSON and clean Markdown reports from persisted run details.
 */

function sanitizeText(value) {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string') return value
  // Omit local system / deployment paths (e.g. /var/..., /home/..., C:\..., /Users/...)
  let sanitized = value.replace(/(?:\/[a-zA-Z0-9_.-]+){3,}/g, '[PATH_REDACTED]')
  sanitized = sanitized.replace(/[a-zA-Z]:\\[a-zA-Z0-9_.\-\\]+/g, '[PATH_REDACTED]')
  // Omit credentials, tokens, secret keys (e.g. S[A-Z0-9]{55}, ghp_..., eyJ...)
  sanitized = sanitized.replace(/S[A-Z2-7]{55}/g, '[SECRET_KEY_REDACTED]')
  sanitized = sanitized.replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/g, '[TOKEN_REDACTED]')
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
  return sanitized
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') {
    return sanitizeText(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject)
  }
  const clean = {}
  for (const [k, v] of Object.entries(obj)) {
    const lowerKey = k.toLowerCase()
    if (
      lowerKey.includes('secret') ||
      lowerKey.includes('privatekey') ||
      lowerKey.includes('password') ||
      lowerKey.includes('credential') ||
      lowerKey.includes('apikey') ||
      (lowerKey.includes('token') &&
        !lowerKey.includes('tokencount') &&
        !lowerKey.includes('paymenttoken'))
    ) {
      clean[k] = '[REDACTED]'
    } else {
      clean[k] = sanitizeObject(v)
    }
  }
  return clean
}

export function buildRunReportPayload(run) {
  if (!run || typeof run !== 'object') {
    throw new Error('Valid run object is required')
  }

  // Extract receipts
  const receipts = []
  if (Array.isArray(run.paymentAttempts) && run.paymentAttempts.length > 0) {
    for (const pa of run.paymentAttempts) {
      receipts.push({
        method: pa.method || 'unknown',
        status:
          pa.outcome === 'confirmed' ? 'CONFIRMED' : pa.outcome === 'failed' ? 'FAILED' : 'PENDING',
        isSynthetic: Boolean(pa.isSynthetic || pa.synthetic),
        amount: pa.settledAmount ?? pa.amount ?? null,
        asset: pa.settledAsset ?? pa.currency ?? null,
        network: pa.network || run.network || 'stellar:testnet',
        txHash: pa.txHash || null,
        explorerUrl:
          pa.explorerUrl ||
          (pa.txHash ? `https://stellar.expert/explorer/testnet/tx/${pa.txHash}` : null),
        agentId: pa.agentId || null,
        phase: pa.phase || null,
      })
    }
  } else if (Array.isArray(run.auditEvents)) {
    for (const ev of run.auditEvents) {
      if (ev.txHash || ev.type?.includes('payment') || ev.cost) {
        receipts.push({
          method: ev.paidVia || 'x402',
          status: ev.status === 'confirmed' || ev.txHash ? 'CONFIRMED' : 'PENDING',
          isSynthetic: false,
          amount: ev.amount ?? ev.cost ?? null,
          asset: ev.asset || 'USDC',
          network: ev.network || 'stellar:testnet',
          txHash: ev.txHash || null,
          explorerUrl:
            ev.explorerUrl ||
            (ev.txHash ? `https://stellar.expert/explorer/testnet/tx/${ev.txHash}` : null),
          agentId: ev.agentId || ev.agent || null,
          phase: null,
        })
      }
    }
  }

  // Extract step outputs
  const rawOutputs = run.output || run.results || run.result?.output || []
  const steps = (Array.isArray(rawOutputs) ? rawOutputs : [rawOutputs]).map((o, idx) => ({
    stepIndex: idx + 1,
    agent: o?.agent || o?.agentId || `step-${idx + 1}`,
    action: o?.action || o?.phase || 'execute',
    output: sanitizeObject(o),
  }))

  const payload = {
    version: 1,
    runId: run.id,
    task: sanitizeText(run.task),
    status: run.status,
    budget: run.budget,
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    interruptedAt: run.interruptedAt || null,
    interruptedReason: run.interruptedReason || null,
    plan: sanitizeText(run.plan),
    totals: {
      settledTotals: run.settledTotals || [],
      spent: run.spent ?? null,
    },
    receipts,
    steps,
    provenance: {
      engine: 'StellarMind',
      protocol: 'x402-stellar',
      exportedAt: new Date().toISOString(),
    },
  }

  return payload
}

export function generateRunReportMarkdown(payload) {
  const lines = []
  lines.push('# StellarMind Execution Report')
  lines.push(`**Run ID:** \`${payload.runId}\``)
  lines.push(`**Status:** ${payload.status}`)
  lines.push(`**Started:** ${payload.startedAt || 'N/A'}`)
  lines.push(`**Completed:** ${payload.completedAt || 'N/A'}`)
  lines.push(`**Task:** ${payload.task || 'N/A'}`)
  lines.push(`**Budget:** ${payload.budget || 0} USDC`)

  if (Array.isArray(payload.totals.settledTotals) && payload.totals.settledTotals.length > 0) {
    const formatted = payload.totals.settledTotals.map((t) => `${t.amount} ${t.asset}`).join(' + ')
    lines.push(`**Settled Amount:** ${formatted}`)
  } else if (payload.totals.spent != null) {
    lines.push(`**Settled Amount:** ${payload.totals.spent} USDC`)
  }

  if (payload.plan) {
    lines.push(`\n## Plan\n\`\`\`\n${payload.plan}\n\`\`\``)
  }

  lines.push('\n## Verifiable Payment Receipts')
  if (payload.receipts.length === 0) {
    lines.push('_No payment receipts recorded for this run._')
  } else {
    lines.push('| Step / Agent | Status | Amount & Asset | Network | Transaction Hash |')
    lines.push('| :--- | :--- | :--- | :--- | :--- |')
    for (const r of payload.receipts) {
      const label = r.isSynthetic ? `${r.status} (Synthetic)` : r.status
      const amountStr = r.amount != null ? `${r.amount} ${r.asset || ''}`.trim() : 'N/A'
      const hashStr = r.txHash
        ? `[\`${r.txHash.slice(0, 10)}...${r.txHash.slice(-6)}\`](${r.explorerUrl})`
        : '—'
      lines.push(
        `| ${r.agentId || 'default'} | ${label} | ${amountStr} | ${r.network} | ${hashStr} |`
      )
    }
  }

  lines.push('\n## Step Outputs & Outcomes')
  if (payload.steps.length === 0) {
    lines.push('_No step outputs recorded._')
  } else {
    for (const s of payload.steps) {
      lines.push(`\n### Step ${s.stepIndex}: ${s.agent}`)
      const formattedOutput =
        typeof s.output === 'string' ? s.output : JSON.stringify(s.output, null, 2)
      lines.push(`\`\`\`\n${formattedOutput}\n\`\`\``)
    }
  }

  lines.push(
    `\n---\n*Exported by StellarMind on ${payload.provenance.exportedAt} via x402 on Stellar*`
  )
  return lines.join('\n')
}
