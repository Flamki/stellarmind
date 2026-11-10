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

/**
 * Convert an integer stroops value to an exact XLM decimal string (1 XLM = 10,000,000 stroops)
 * without rounding small values to zero (#161).
 */
function stroopsToXlmDisplay(stroops) {
  if (stroops === null || stroops === undefined || stroops === '') return null
  const s = String(stroops).trim()
  if (!/^\d+$/.test(s)) return null
  const units = BigInt(s)
  const scale = 10_000_000n
  const intPart = units / scale
  const fracPart = units % scale
  if (fracPart === 0n) return intPart.toString()
  const fracStr = fracPart.toString().padStart(7, '0').replace(/0+$/, '')
  return `${intPart}.${fracStr}`
}

/**
 * Format an XLM decimal string or number while preserving up to 7 fractional
 * decimal places so small XLM fees never round to `0.00`.
 */
function formatXlmAmount(value, options = {}) {
  const minDecimals = options.minDecimals ?? 0
  const maxDecimals = options.maxDecimals ?? 7
  const includeAsset = options.includeAsset !== false
  const asset = options.asset || 'XLM'

  if (value === null || value === undefined || value === '') return '—'

  let raw = String(value).trim()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    raw = value.toFixed(maxDecimals)
  } else if (/e/i.test(raw)) {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return `${raw}${includeAsset ? ` ${asset}` : ''}`
    raw = parsed.toFixed(maxDecimals)
  }

  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/)
  if (!match) {
    return includeAsset ? `${raw} ${asset}` : raw
  }

  const sign = match[1] === '-' ? '-' : ''
  const intPart = match[2]
  const fracRaw = (match[3] || '').slice(0, maxDecimals)
  const trimmedFrac = fracRaw.replace(/0+$/, '')
  const finalFrac =
    trimmedFrac.length >= minDecimals ? trimmedFrac : trimmedFrac.padEnd(minDecimals, '0')

  const formatted = finalFrac.length > 0 ? `${sign}${intPart}.${finalFrac}` : `${sign}${intPart}`
  return includeAsset ? `${formatted} ${asset}` : formatted
}

/**
 * Format a step or payment receipt's Stellar network fee, explicitly marking
 * unknown or pending fees (#161).
 */
function formatNetworkFeeLabel(item) {
  if (!item || typeof item !== 'object') return 'unknown'
  const fee =
    item.networkFee ||
    item.receipt?.networkFee ||
    item.settlement?.networkFee ||
    item.paymentAttempt?.networkFee ||
    item

  const status =
    fee?.status ||
    item.feeStatus ||
    (item.paymentReconciliationRequired || item.outcome === 'pending' || item.outcome === 'unknown'
      ? 'pending'
      : null)

  if (status === 'not_applicable') return 'none'
  if (status === 'pending') return 'pending'
  if (status === 'unknown') return 'unknown'

  const stroops =
    fee?.stroops ?? item.feeChargedStroops ?? item.feeCharged ?? item.fee_charged ?? null
  if (stroops !== null && stroops !== undefined && /^\d+$/.test(String(stroops).trim())) {
    const stroopsStr = String(stroops).trim()
    const xlm = fee?.amount || item.feeChargedXlm || stroopsToXlmDisplay(stroopsStr)
    return `${formatXlmAmount(xlm, { minDecimals: 0, maxDecimals: 7, includeAsset: true })} (${stroopsStr} stroops)`
  }

  const xlmAmount = fee?.amount ?? item.feeChargedXlm ?? item.feeXlm ?? null
  if (xlmAmount !== null && xlmAmount !== undefined && String(xlmAmount).trim() !== '') {
    return formatXlmAmount(xlmAmount, { minDecimals: 0, maxDecimals: 7, includeAsset: true })
  }

  const settled =
    Boolean(item?.settlement?.success) ||
    Boolean(item?.settledAsset && item?.settledAmount) ||
    item?.outcome === 'confirmed'
  return settled ? 'unknown' : 'none'
}

/**
 * Format the run-level network fee summary separately from service charges (#161).
 */
function formatNetworkFeeSummary(runOrSummary) {
  if (!runOrSummary) return 'none'
  if (typeof runOrSummary === 'string') return runOrSummary
  if (typeof runOrSummary.networkFeeSummary === 'string') return runOrSummary.networkFeeSummary
  if (typeof runOrSummary.summary?.networkFeeSummary === 'string') {
    return runOrSummary.summary.networkFeeSummary
  }
  const nf = runOrSummary.networkFees || runOrSummary.summary?.networkFees || runOrSummary
  if (nf && typeof nf.summary === 'string') return nf.summary
  if (nf && nf.status === 'confirmed' && nf.amount) {
    return nf.stroops
      ? `${formatXlmAmount(nf.amount, { minDecimals: 0, maxDecimals: 7, includeAsset: true })} (${nf.stroops} stroops)`
      : formatXlmAmount(nf.amount, { minDecimals: 0, maxDecimals: 7, includeAsset: true })
  }
  if (nf && nf.status === 'pending') return 'pending'
  if (nf && nf.status === 'unknown') return 'unknown'
  return 'none'
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
      : `\n--- ${x.agentName} (quoted ${x.cost} ${x.currency}; settled ${formatSettlementLabel(x)}; network fee ${formatNetworkFeeLabel(x)}) ---\n${x.output}\n`
  }

  out.textContent = `FINAL ANSWER\n${finalAnswer}\n\nAGENT DETAILS${details}`

  const txL = (r.payments || [])
    .map(
      (p) =>
        `<a href="${p.explorerUrl}" target="_blank" class="fi-link">${p.txHash?.slice(0, 8)} &nearr;</a>`
    )
    .join(' ')

  ch.innerHTML = `
    <div class="chip">Agents: <span class="v">${r.agentsUsed || 0}</span></div>
    <div class="chip">Quoted: <span class="v">${r.quotedTotal || r.totalSpent || '0'} USDC</span></div>
    <div class="chip">Settled: <span class="v">${formatAssetTotals(r.settledTotals)}</span></div>
    <div class="chip">Network Fee: <span class="v">${formatNetworkFeeSummary(r)}</span></div>
    <div class="chip">TXs: <span class="v">${r.txCount || 0}</span></div>
    <div class="chip">Protocol: <span class="v">${r.paymentProtocol || 'stellar'}</span></div>
    <div class="chip">Time: <span class="v">${r.elapsed || '-'}</span></div>
    ${r.budgetExhausted ? '<div class="chip" style="color:var(--amber)">Budget Used</div>' : ''}
    ${txL ? `<div class="chip" style="flex-wrap:wrap;gap:4px;">Verify: ${txL}</div>` : ''}
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

function renderRunDetail(run) {
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

  document.getElementById('detail-run-id').innerHTML = `<code>${escapeHtml(run.id)}</code>`
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
  const networkFeeEl = document.getElementById('detail-network-fee')
  if (networkFeeEl) networkFeeEl.textContent = formatNetworkFeeSummary(run)

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
  const seenTxHashes = new Set()
  if (run.txProofs && Array.isArray(run.txProofs) && run.txProofs.length > 0) {
    for (const proof of run.txProofs) {
      payments.push(proof)
      if (proof?.txHash) seenTxHashes.add(proof.txHash)
    }
  }
  if (run.paymentAttempts && Array.isArray(run.paymentAttempts)) {
    for (const pa of run.paymentAttempts) {
      // Attempts are confirmed/unknown/failed, not `settled`.
      if (pa?.outcome === 'confirmed' && pa.txHash && !seenTxHashes.has(pa.txHash)) {
        payments.push({
          method: pa.method,
          txHash: pa.txHash,
          explorerUrl: pa.explorerUrl,
          amount: pa.settledAmount ?? pa.amount,
          asset: pa.settledAsset ?? pa.currency,
          quotedAmount: pa.quotedAmount ?? pa.amount,
          quotedAsset: pa.quotedAsset ?? pa.currency,
          networkFee: pa.networkFee || null,
          outcome: 'confirmed',
        })
        seenTxHashes.add(pa.txHash)
      } else if (pa?.outcome === 'pending' || pa?.outcome === 'unknown') {
        payments.push({
          method: pa.method,
          txHash: pa.txHash || null,
          explorerUrl: pa.explorerUrl || null,
          amount: null,
          asset: null,
          quotedAmount: pa.quotedAmount ?? pa.amount,
          quotedAsset: pa.quotedAsset ?? pa.currency,
          networkFee: pa.networkFee || { status: 'pending', asset: 'XLM' },
          outcome: pa.outcome,
        })
      }
    }
  }
  if (payments.length > 0) {
    paymentSection.style.display = 'block'
    document.getElementById('detail-payments').innerHTML = payments
      .map((p) => {
        const hash = p.txHash || '—'
        const url = p.explorerUrl || `https://stellar.expert/explorer/testnet/tx/${hash}`
        const quoted =
          p.quotedAmount !== undefined && p.quotedAmount !== null
            ? `quoted ${p.quotedAmount} ${p.quotedAsset || 'USDC'}`.trim()
            : null
        const settled =
          p.outcome === 'pending' || p.outcome === 'unknown'
            ? 'settlement pending'
            : p.amount !== undefined && p.amount !== null
              ? `${p.amount} ${p.asset || ''}`.trim()
              : 'amount not recorded'
        const feeLabel = formatNetworkFeeLabel(p)
        const txLink =
          p.txHash && p.txHash !== '—'
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(hash.slice(0, 12))}...${escapeHtml(hash.slice(-8))}</a>`
            : `<span style="color:var(--amber);">pending reconciliation</span>`
        return `<div class="payment-item">
          ${quoted ? `<span>${escapeHtml(quoted)}</span>` : ''}
          <span>${escapeHtml(settled)}</span>
          <span>network fee: ${escapeHtml(feeLabel)}</span>
          <span>${escapeHtml(p.method || 'unknown')}</span>
          ${txLink}
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
        const content = o.content || o.result || o.response || o.text || JSON.stringify(o, null, 2)
        return `<div class="output-item">
          <div class="output-header">${i + 1}. ${escapeHtml(agent)}</div>
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
