/**
 * Rendering Module
 * Handles result display and progress rendering
 */

/**
 * Per-asset settled totals for display (issue #130).
 * Amounts of different assets are shown separately and never added together.
 */
function formatAssetTotals(totals) {
  if (!Array.isArray(totals) || totals.length === 0) return 'none'
  return totals.map((total) => `${total.amount} ${total.asset}`).join(' + ')
}

/** What a single step actually settled, in its own asset. */
function formatSettlementLabel(item) {
  if (item?.settlement?.success) return `${item.settlement.amount} ${item.settlement.asset}`
  if (item?.settledAsset && item?.settledAmount) return `${item.settledAmount} ${item.settledAsset}`
  return 'unsettled'
}

function setResultTag(text, tone = '') {
  const tag = document.getElementById('result-tag')
  tag.textContent = text
  tag.className = tone ? `tag ${tone}` : 'tag'
}

function ensureResultPanelVisible() {
  const p = document.getElementById('result-panel')
  p.classList.add('visible')
  return p
}

function appendResultLog(line) {
  const out = document.getElementById('result-out')
  const stamp = new Date().toLocaleTimeString()
  const next =
    `${out.textContent === 'No run yet.' ? '' : out.textContent}\n[${stamp}] ${line}`.trim()
  const lines = next.split('\n')
  out.textContent = lines.slice(-160).join('\n')
  out.scrollTop = out.scrollHeight
}

function pushLiveLine(line) {
  const box = document.getElementById('result-live')
  const item = document.createElement('div')
  item.className = 'live-line'
  item.textContent = line
  box.prepend(item)
  while (box.children.length > 6) box.removeChild(box.lastChild)
}

function getRunProgressInfo(r = activeRun) {
  if (!r) return { planned: 0, completed: 0, percent: 0 }
  const planned = Math.max(Number(r.planned || 0), Number(r.completed || 0), 0)
  const completed = Math.min(Number(r.completed || 0), planned || Number(r.completed || 0))
  if (!planned) return { planned, completed, percent: r.running ? 5 : 100 }
  const raw = (completed / planned) * 100
  const visible = r.running && completed === 0 ? 8 : raw
  const bounded = r.running ? Math.min(visible, 98) : 100
  return { planned, completed, percent: Math.max(0, Math.min(100, bounded)) }
}

function renderLiveChips(r = activeRun) {
  if (!r) return
  const elapsedMs = Date.now() - r.startedAt
  const elapsedSec = (elapsedMs / 1000).toFixed(1)
  const { planned, completed, percent } = getRunProgressInfo(r)
  const progress = planned > 0 ? `${completed}/${planned}` : `${completed}`
  const status = r.running ? 'Running' : 'Complete'

  document.getElementById('result-chips').innerHTML = `
    <div class="chip">Status: <span class="v">${status}</span></div>
    <div class="chip">Progress: <span class="v">${progress}</span></div>
    <div class="chip">Spent: <span class="v">${r.spent.toFixed(2)} / ${r.budget.toFixed(2)} USDC</span></div>
    <div class="chip">Time: <span class="v">${elapsedSec}s</span></div>
  `

  document.getElementById('progress-fill').style.width = `${percent.toFixed(1)}%`
  document.getElementById('progress-percent').textContent = `${Math.round(percent)}%`
  document.getElementById('progress-label').textContent = r.running
    ? `Running · ${progress} agents complete`
    : `Completed · ${progress} agents complete`
}

function normalizeFinalAnswer(text) {
  if (!text) return 'No final answer returned.'
  let out = String(text).trim()
  out = out.replace(/^```[a-zA-Z]*\n?/g, '').replace(/```$/g, '')
  out = out.replace(/^#{1,6}\s*/gm, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

function showResult(r) {
  const p = document.getElementById('result-panel')
  const out = document.getElementById('result-out')
  const ch = document.getElementById('result-chips')

  p.classList.add('visible')
  p.classList.remove('running')
  setResultTag('Complete', 'green')
  stopRunHeartbeat()

  document.getElementById('result-status-line').textContent =
    'Execution complete. Final answer and per-agent outputs are shown below.'

  const successful = (r.results || []).filter((x) => !x.skipped)
  const preferred =
    successful.find((x) => x.agentId === 'summary-bot') ||
    successful.find((x) => x.agentId === 'analyst-bot') ||
    successful[0]
  const finalAnswer = normalizeFinalAnswer(preferred?.output || 'No final answer returned.')

  let details = ''
  for (const x of r.results || []) {
    details += x.skipped
      ? `\n[SKIPPED] ${x.agentId}: ${x.reason}\n`
      : `\n--- ${x.agentName} (quoted ${x.cost} ${x.currency}; settled ${formatSettlementLabel(x)}) ---\n${x.output}\n`
  }

  out.textContent = `FINAL ANSWER\n${finalAnswer}\n\nAGENT DETAILS${details}`

  const txL = (r.payments || [])
    .map(
      (p) =>
        `<a href="${p.explorerUrl}" target="_blank" class="fi-link">${p.txHash?.slice(0, 8)} &nearr;</a>`
    )
    .join(' ')

  const runId = r.runId || r.id || null
  const exportActions = runId
    ? `<div class="chip" id="result-export-actions" style="gap:6px;">Export: <a href="${buildRunExportUrl(runId, 'json')}" download="run-${runId}-report.json" class="fi-link" onclick="exportRunReport('${runId}', 'json'); return false;">JSON</a> <a href="${buildRunExportUrl(runId, 'markdown')}" download="run-${runId}-report.md" class="fi-link" onclick="exportRunReport('${runId}', 'markdown'); return false;">Markdown</a></div>`
    : ''

  ch.innerHTML = `
    <div class="chip">Agents: <span class="v">${r.agentsUsed || 0}</span></div>
    <div class="chip">Quoted: <span class="v">${r.quotedTotal || r.totalSpent || '0'} USDC</span></div>
    <div class="chip">Settled: <span class="v">${formatAssetTotals(r.settledTotals)}</span></div>
    <div class="chip">TXs: <span class="v">${r.txCount || 0}</span></div>
    <div class="chip">Protocol: <span class="v">${r.paymentProtocol || 'stellar'}</span></div>
    <div class="chip">Time: <span class="v">${r.elapsed || '-'}</span></div>
    ${r.budgetExhausted ? '<div class="chip" style="color:var(--amber)">Budget Used</div>' : ''}
    ${txL ? `<div class="chip" style="flex-wrap:wrap;gap:4px;">Verify: ${txL}</div>` : ''}
    ${exportActions}
  `

  if (activeRun) {
    activeRun.running = false
    activeRun.completed = Number(r.agentsUsed || activeRun.completed || 0)
    activeRun.planned = Math.max(
      activeRun.planned || 0,
      Number(r.agentsUsed || 0) + Number(r.agentsSkipped || 0)
    )
    activeRun.spent = Number.parseFloat(r.quotedTotal || r.totalSpent || activeRun.spent || 0)
  }

  renderLiveChips(activeRun)
  pushLiveLine('Final answer generated')
}

async function openRunDetail(runId) {
  const modal = document.getElementById('history-detail-modal')
  const loading = document.getElementById('history-detail-loading')
  const content = document.getElementById('history-detail-content')
  const errorEl = document.getElementById('history-detail-error')

  modal.style.display = 'flex'
  loading.style.display = 'block'
  content.style.display = 'none'
  errorEl.style.display = 'none'

  try {
    const res = await fetch(`/api/runs/${runId}`)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || `Failed to load run ${runId}`)
    }
    const run = await res.json()
    loading.style.display = 'none'
    content.style.display = 'block'
    renderRunDetail(run)
  } catch (err) {
    loading.style.display = 'none'
    errorEl.style.display = 'block'
    errorEl.innerHTML = `<p style="color: var(--red);">Error: ${escapeHtml(err.message)}</p>`
  }
}

function closeRunDetail() {
  const modal = document.getElementById('history-detail-modal')
  modal.style.display = 'none'
}

function buildRunExportUrl(runId, format = 'json') {
  const normalized = format === 'md' || format === 'markdown' ? 'markdown' : 'json'
  return `/api/runs/${encodeURIComponent(runId)}/export?format=${normalized}`
}

async function exportRunReport(runId, format = 'json') {
  const normalized = format === 'md' || format === 'markdown' ? 'markdown' : 'json'
  const ext = normalized === 'markdown' ? 'md' : 'json'
  const url = buildRunExportUrl(runId, normalized)
  const res = await fetch(url)
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.message || errData.error || `Failed to export run ${runId}`)
  }
  const body = await res.text()
  const filename = `run-${runId}-report.${ext}`
  const contentType =
    res.headers?.get?.('content-type') ||
    (normalized === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8')

  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    const blob = new Blob([body], { type: contentType })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = filename
    if (document.body?.appendChild) {
      document.body.appendChild(link)
      link.click?.()
      document.body.removeChild?.(link)
    } else {
      link.click?.()
    }
    URL.revokeObjectURL?.(objectUrl)
  }

  return {
    format: normalized,
    filename,
    contentType,
    body,
    data: normalized === 'json' ? JSON.parse(body) : null,
  }
}

function renderRunDetail(run) {
  const runId = run.id || run.runId || 'unknown'
  const status = run.status || 'unknown'
  const statusClass = `status-${status}`
  const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'
  const completed = run.completedAt ? new Date(run.completedAt).toLocaleString() : '—'
  const updated = run.updatedAt ? new Date(run.updatedAt).toLocaleString() : '—'
  const interrupted = run.interruptedAt ? new Date(run.interruptedAt).toLocaleString() : null
  // Quoted/reserved cost and the settled totals are different figures. The
  // dashboard labels them separately instead of presenting the quote as spend.
  const spent =
    run.quotedTotal !== undefined && run.quotedTotal !== null
      ? run.quotedTotal
      : run.totalSpent !== undefined && run.totalSpent !== null
        ? run.totalSpent
        : (run.summary?.quotedTotal ?? run.summary?.totalSpent ?? '0')
  const settled =
    run.summary?.settledSummary ||
    formatAssetTotals(run.settledTotals ?? run.summary?.settledTotals)
  const budget =
    run.budget !== undefined && run.budget !== null ? run.budget : (run.summary?.budget ?? '—')
  const task = run.task || '—'

  document.getElementById('detail-run-id').innerHTML = `<code>${escapeHtml(runId)}</code>`
  document.getElementById('detail-status').textContent = status
  document.getElementById('detail-status').className = `history-status ${statusClass}`
  document.getElementById('detail-task').textContent = task
  document.getElementById('detail-created').textContent = created
  document.getElementById('detail-completed').textContent = completed
  document.getElementById('detail-updated').textContent = updated
  document.getElementById('detail-spent').textContent = spent
  document.getElementById('detail-budget').textContent = budget
  const settledEl = document.getElementById('detail-settled')
  if (settledEl) settledEl.textContent = settled

  const exportEl = document.getElementById('detail-export-actions')
  if (exportEl) {
    exportEl.innerHTML = `
      <a href="${escapeHtml(buildRunExportUrl(runId, 'json'))}" download="run-${escapeHtml(runId)}-report.json" class="btn" id="btn-export-json" onclick="exportRunReport('${escapeHtml(runId)}', 'json'); return false;" style="padding: 6px 12px; font-size: 12px; text-decoration: none;">Export JSON</a>
      <a href="${escapeHtml(buildRunExportUrl(runId, 'markdown'))}" download="run-${escapeHtml(runId)}-report.md" class="btn" id="btn-export-markdown" onclick="exportRunReport('${escapeHtml(runId)}', 'markdown'); return false;" style="padding: 6px 12px; font-size: 12px; text-decoration: none;">Export Markdown</a>
    `
  }

  const interruptedSection = document.getElementById('detail-interrupted-section')
  if (interrupted) {
    interruptedSection.style.display = 'block'
    document.getElementById('detail-interrupted').textContent = interrupted
    document.getElementById('detail-interrupted-reason').textContent = run.interruptedReason || '—'
  } else {
    interruptedSection.style.display = 'none'
  }

  // Render error if failed
  const errorSection = document.getElementById('detail-error-section')
  if (run.status === 'failed' && run.error) {
    errorSection.style.display = 'block'
    document.getElementById('detail-error-message').textContent =
      run.error.message || 'Unknown error'
  } else {
    errorSection.style.display = 'none'
  }

  // Render payment info
  const paymentSection = document.getElementById('detail-payment-section')
  const payments = []
  const seenPaymentKeys = new Set()
  const pushPayment = (p) => {
    const key =
      p.id || p.txHash || `${p.method || ''}:${p.amount || ''}:${p.asset || ''}:${p.status || ''}`
    if (seenPaymentKeys.has(key)) return
    if (p.txHash && seenPaymentKeys.has(`tx:${p.txHash}`)) return
    seenPaymentKeys.add(key)
    if (p.txHash) seenPaymentKeys.add(`tx:${p.txHash}`)
    payments.push(p)
  }

  if (run.txProofs && Array.isArray(run.txProofs) && run.txProofs.length > 0) {
    for (const proof of run.txProofs) {
      pushPayment({
        ...proof,
        status: proof.synthetic ? 'synthetic' : proof.status || 'confirmed',
      })
    }
  }
  if (run.paymentAttempts && Array.isArray(run.paymentAttempts)) {
    for (const pa of run.paymentAttempts) {
      if (pa?.outcome === 'confirmed' && pa.txHash) {
        pushPayment({
          id: pa.id,
          method: pa.method,
          txHash: pa.txHash,
          explorerUrl: pa.explorerUrl,
          amount: pa.settledAmount ?? pa.amount,
          asset: pa.settledAsset ?? pa.currency,
          network: pa.settledNetwork ?? pa.network,
          status: pa.synthetic ? 'synthetic' : 'confirmed',
        })
      } else if (pa?.outcome === 'unknown' || pa?.outcome === 'pending') {
        pushPayment({
          id: pa.id,
          method: pa.method || 'x402',
          txHash: pa.txHash || null,
          explorerUrl: null,
          amount: pa.settledAmount ?? pa.amount,
          asset: pa.settledAsset ?? pa.currency,
          network: pa.settledNetwork ?? pa.network,
          status: 'pending',
        })
      }
    }
  }
  if (payments.length > 0) {
    paymentSection.style.display = 'block'
    document.getElementById('detail-payments').innerHTML = payments
      .map((p) => {
        const hash = p.txHash || '—'
        const isSynthetic =
          p.status === 'synthetic' ||
          p.synthetic === true ||
          /^(?:stub|demo|synthetic|mock)[_-]/i.test(String(p.txHash || ''))
        const isPending = p.status === 'pending' || p.outcome === 'unknown'
        const statusLabel = isSynthetic ? 'synthetic' : isPending ? 'pending' : 'confirmed'
        const url =
          !isSynthetic && !isPending && p.txHash
            ? p.explorerUrl || `https://stellar.expert/explorer/testnet/tx/${hash}`
            : null
        const settled =
          p.amount !== undefined && p.amount !== null
            ? `${p.amount} ${p.asset || ''}`.trim()
            : 'amount not recorded'
        const linkOrHash = url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(hash.slice(0, 12))}...${escapeHtml(hash.slice(-8))}</a>`
          : `<span>${escapeHtml(hash)}</span>`
        return `<div class="payment-item" data-receipt-status="${escapeHtml(statusLabel)}">
          <span>${escapeHtml(settled)}</span>
          <span>${escapeHtml(p.method || 'unknown')} (${escapeHtml(statusLabel)})</span>
          ${linkOrHash}
        </div>`
      })
      .join('')
  } else {
    paymentSection.style.display = 'none'
  }

  // Render outputs/steps
  const outputSection = document.getElementById('detail-output-section')
  const outputs = run.output || run.results || run.result?.output || []
  if (Array.isArray(outputs) && outputs.length > 0) {
    outputSection.style.display = 'block'
    document.getElementById('detail-outputs').innerHTML = outputs
      .map((o, i) => {
        const agent = o.agent || o.agentId || `step-${i + 1}`
        const outcome = o.skipped ? 'skipped' : o.error ? 'failed' : o.outcome || 'completed'
        const content =
          o.output ||
          o.content ||
          o.result ||
          o.response ||
          o.text ||
          (o.skipped
            ? `[SKIPPED] ${o.reason || 'budget limit'}`
            : o.error || JSON.stringify(o, null, 2))
        return `<div class="output-item" data-step-outcome="${escapeHtml(outcome)}">
          <div class="output-header">${i + 1}. ${escapeHtml(agent)} [${escapeHtml(outcome)}]</div>
          <pre class="output-content">${escapeHtml(content)}</pre>
        </div>`
      })
      .join('')
  } else if (run.outputAvailable) {
    // Output available but empty - still show
    outputSection.style.display = 'block'
    document.getElementById('detail-outputs').innerHTML =
      '<div style="padding: 12px; color: var(--text-muted);">Output available but empty</div>'
  } else {
    outputSection.style.display = 'block'
    document.getElementById('detail-outputs').innerHTML =
      '<div style="padding: 12px; color: var(--text-muted);">No output stored for this run</div>'
  }

  // Render plan if exists
  const planSection = document.getElementById('detail-plan-section')
  if (run.plan) {
    planSection.style.display = 'block'
    document.getElementById('detail-plan').textContent = run.plan
  } else {
    planSection.style.display = 'none'
  }
}
