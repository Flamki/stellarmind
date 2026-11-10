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
  if (!r) {
    return {
      planned: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      terminal: 0,
      percent: 0,
      status: 'Idle',
      label: '0/0 steps complete',
    }
  }
  const completed = Math.max(Number(r.completed || 0), 0)
  const failed = Math.max(Number(r.failed || 0), 0)
  const skipped = Math.max(Number(r.skipped || 0), 0)
  const rawTerminal = completed + failed + skipped
  const planned = Math.max(Number(r.planned || 0), rawTerminal, 0)
  const terminal = planned > 0 ? Math.min(rawTerminal, planned) : rawTerminal

  let percent = 0
  if (!planned) {
    percent = r.running ? 5 : 100
  } else {
    const raw = (terminal / planned) * 100
    const visible = r.running && terminal === 0 ? 8 : raw
    const bounded = r.running ? Math.min(visible, 98) : 100
    percent = Math.max(0, Math.min(100, bounded))
  }

  const progress = planned > 0 ? `${terminal}/${planned}` : `${terminal}`
  const status = r.running
    ? 'Running'
    : failed > 0 && completed === 0
      ? 'Failed'
      : failed > 0
        ? 'Partial'
        : 'Complete'

  let label
  if (failed > 0 || skipped > 0) {
    const parts = [`${completed} completed`]
    if (failed > 0) parts.push(`${failed} failed`)
    if (skipped > 0) parts.push(`${skipped} skipped`)
    const prefix = r.running ? 'Running' : failed > 0 && completed === 0 ? 'Failed' : 'Completed'
    label = `${prefix} · ${progress} steps (${parts.join(', ')})`
  } else {
    label = r.running
      ? `Running · ${progress} steps complete`
      : `Completed · ${progress} steps complete`
  }

  return {
    planned,
    completed,
    failed,
    skipped,
    terminal,
    percent,
    status,
    label,
  }
}

function renderLiveChips(r = activeRun) {
  if (!r) return
  const elapsedMs = Math.max(0, Date.now() - (r.startedAt || Date.now()))
  const elapsedSec = (elapsedMs / 1000).toFixed(1)
  const { planned, completed, failed, skipped, terminal, percent, status, label } =
    getRunProgressInfo(r)
  const progress = planned > 0 ? `${terminal}/${planned}` : `${terminal}`
  const spent = Number(r.spent || 0)
  const budget = Number(r.budget || 0)

  document.getElementById('result-chips').innerHTML = `
    <div class="chip">Status: <span class="v">${status}</span></div>
    <div class="chip">Progress: <span class="v">${progress}</span></div>
    <div class="chip">Completed: <span class="v">${completed}</span></div>
    ${failed > 0 ? `<div class="chip">Failed: <span class="v">${failed}</span></div>` : ''}
    ${skipped > 0 ? `<div class="chip">Skipped: <span class="v">${skipped}</span></div>` : ''}
    <div class="chip">Spent: <span class="v">${spent.toFixed(2)} / ${budget.toFixed(2)} USDC</span></div>
    <div class="chip">Time: <span class="v">${elapsedSec}s</span></div>
  `

  document.getElementById('progress-fill').style.width = `${percent.toFixed(1)}%`
  document.getElementById('progress-percent').textContent = `${Math.round(percent)}%`
  document.getElementById('progress-label').textContent = label
}

function normalizeFinalAnswer(text) {
  if (!text) return 'No final answer returned.'
  let out = String(text).trim()
  out = out.replace(/^```[a-zA-Z]*\n?/g, '').replace(/```$/g, '')
  out = out.replace(/^#{1,6}\s*/gm, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

function isStepResultFailed(x) {
  return Boolean(
    x &&
    !x.skipped &&
    (x.failed ||
      x.status === 'failed' ||
      x.outcome === 'failed' ||
      x.error ||
      (typeof x.output === 'string' && x.output.startsWith('Error:')))
  )
}

function showResult(r) {
  const p = document.getElementById('result-panel')
  const out = document.getElementById('result-out')
  const ch = document.getElementById('result-chips')

  const resultsList = Array.isArray(r.results) ? r.results : []
  const skippedResults = resultsList.filter((x) => x && x.skipped)
  const failedResults = resultsList.filter((x) => isStepResultFailed(x))
  const completedResults = resultsList.filter((x) => x && !x.skipped && !isStepResultFailed(x))

  const failedCount =
    resultsList.length > 0 ? failedResults.length : Number(r.agentsFailed || activeRun?.failed || 0)
  const skippedCount =
    resultsList.length > 0
      ? skippedResults.length
      : Number(r.agentsSkipped || activeRun?.skipped || 0)
  const completedCount =
    resultsList.length > 0
      ? completedResults.length
      : Math.max(0, Number(r.agentsUsed || activeRun?.completed || 0) - failedCount)

  p.classList.add('visible')
  p.classList.remove('running')
  if (failedCount > 0 && completedCount === 0) {
    setResultTag('Failed', 'amber')
  } else {
    setResultTag('Complete', 'green')
  }
  stopRunHeartbeat()

  document.getElementById('result-status-line').textContent =
    'Execution complete. Final answer and per-agent outputs are shown below.'

  const preferred =
    completedResults.find((x) => x.agentId === 'summary-bot') ||
    completedResults.find((x) => x.agentId === 'analyst-bot') ||
    completedResults[0]
  const finalAnswer = normalizeFinalAnswer(preferred?.output || 'No final answer returned.')

  let details = ''
  for (const x of resultsList) {
    if (x.skipped) {
      details += `\n[SKIPPED] ${x.agentId}: ${x.reason}\n`
    } else if (isStepResultFailed(x)) {
      details += `\n[FAILED] ${x.agentName || x.agentId}: ${x.error || x.output || 'Step failed'}\n`
    } else {
      details += `\n--- ${x.agentName} (quoted ${x.cost} ${x.currency}; settled ${formatSettlementLabel(x)}) ---\n${x.output}\n`
    }
  }

  out.textContent = `FINAL ANSWER\n${finalAnswer}\n\nAGENT DETAILS${details}`

  if (activeRun) {
    activeRun.running = false
    activeRun.completed = completedCount
    activeRun.failed = failedCount
    activeRun.skipped = skippedCount
    activeRun.terminal = completedCount + failedCount + skippedCount
    activeRun.planned = Math.max(
      activeRun.planned || 0,
      resultsList.length,
      activeRun.terminal,
      Number(r.agentsUsed || 0) + Number(r.agentsSkipped || 0)
    )
    activeRun.spent = Number.parseFloat(r.quotedTotal || r.totalSpent || activeRun.spent || 0)
  }

  renderLiveChips(activeRun)

  const summaryProgress = getRunProgressInfo(
    activeRun || {
      running: false,
      planned: Math.max(
        resultsList.length,
        completedCount + failedCount + skippedCount,
        Number(r.agentsUsed || 0) + Number(r.agentsSkipped || 0)
      ),
      completed: completedCount,
      failed: failedCount,
      skipped: skippedCount,
    }
  )
  document.getElementById('progress-fill').style.width = `${summaryProgress.percent.toFixed(1)}%`
  document.getElementById('progress-percent').textContent =
    `${Math.round(summaryProgress.percent)}%`
  document.getElementById('progress-label').textContent = summaryProgress.label

  const txL = (r.payments || [])
    .map(
      (p) =>
        `<a href="${p.explorerUrl}" target="_blank" class="fi-link">${p.txHash?.slice(0, 8)} &nearr;</a>`
    )
    .join(' ')

  ch.innerHTML = `
    <div class="chip">Agents: <span class="v">${r.agentsUsed ?? completedCount}</span></div>
    ${failedCount > 0 ? `<div class="chip">Failed: <span class="v">${failedCount}</span></div>` : ''}
    ${skippedCount > 0 ? `<div class="chip">Skipped: <span class="v">${skippedCount}</span></div>` : ''}
    <div class="chip">Quoted: <span class="v">${r.quotedTotal || r.totalSpent || '0'} USDC</span></div>
    <div class="chip">Settled: <span class="v">${formatAssetTotals(r.settledTotals)}</span></div>
    <div class="chip">TXs: <span class="v">${r.txCount || 0}</span></div>
    <div class="chip">Protocol: <span class="v">${r.paymentProtocol || 'stellar'}</span></div>
    <div class="chip">Time: <span class="v">${r.elapsed || '-'}</span></div>
    ${r.budgetExhausted ? '<div class="chip" style="color:var(--amber)">Budget Used</div>' : ''}
    ${txL ? `<div class="chip" style="flex-wrap:wrap;gap:4px;">Verify: ${txL}</div>` : ''}
  `

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
  if (run.txProofs && Array.isArray(run.txProofs) && run.txProofs.length > 0) {
    payments.push(...run.txProofs)
  }
  if (run.paymentAttempts && Array.isArray(run.paymentAttempts)) {
    for (const pa of run.paymentAttempts) {
      // Attempts are confirmed/unknown/failed, not `settled`.
      if (pa?.outcome === 'confirmed' && pa.txHash) {
        payments.push({
          method: pa.method,
          txHash: pa.txHash,
          explorerUrl: pa.explorerUrl,
          amount: pa.settledAmount ?? pa.amount,
          asset: pa.settledAsset ?? pa.currency,
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
        const settled =
          p.amount !== undefined && p.amount !== null
            ? `${p.amount} ${p.asset || ''}`.trim()
            : 'amount not recorded'
        return `<div class="payment-item">
          <span>${escapeHtml(settled)}</span>
          <span>${escapeHtml(p.method || 'unknown')}</span>
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(hash.slice(0, 12))}...${escapeHtml(hash.slice(-8))}</a>
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
