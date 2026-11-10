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

function isStepResultFailed(step) {
  if (!step || typeof step !== 'object') return true
  if (step.skipped) return false
  if (step.failed === true || step.status === 'failed' || Boolean(step.error)) return true
  if (step.responseMeta && step.responseMeta.empty) return true
  const raw = step.output ?? step.result ?? step.content ?? step.text
  if (raw === undefined || raw === null) return true
  const text = typeof raw === 'string' ? raw.trim() : String(raw).trim()
  if (!text) return true
  if (/^Error:/i.test(text)) return true
  return false
}

function resolveRunFinalOutput(r) {
  const direct = r?.finalOutput || r?.summary?.finalOutput || r?.result?.finalOutput
  if (direct && typeof direct === 'object' && typeof direct.available === 'boolean') {
    return direct
  }

  const rawSteps = Array.isArray(r?.results)
    ? r.results
    : Array.isArray(r?.output)
      ? r.output
      : Array.isArray(r?.result?.results)
        ? r.result.results
        : Array.isArray(r?.result?.output)
          ? r.result.output
          : []

  const steps = rawSteps.map((step, idx) => ({
    ...step,
    stepId:
      typeof step?.stepId === 'string' && step.stepId.trim().length > 0
        ? step.stepId.trim()
        : `step-${idx}`,
  }))

  const completedSteps = steps.filter((s) => !s.skipped && !isStepResultFailed(s))
  const completedStepCount = completedSteps.length

  if (steps.length === 0) {
    return {
      available: false,
      status: 'empty_plan',
      stepId: null,
      agentId: null,
      agentName: null,
      output: null,
      reason: 'Plan contained no executable steps.',
      partialResultsAvailable: false,
      completedStepCount: 0,
    }
  }

  const configuredFinalStepId =
    r?.finalStepId ?? r?.summary?.finalStepId ?? r?.result?.finalStepId ?? null
  const finalStepId =
    typeof configuredFinalStepId === 'string' && configuredFinalStepId.trim().length > 0
      ? configuredFinalStepId.trim()
      : steps[steps.length - 1].stepId

  const target = steps.find((s) => s.stepId === finalStepId) || null
  if (!target) {
    return {
      available: false,
      status: 'invalid_final_step',
      stepId: finalStepId,
      agentId: null,
      agentName: null,
      output: null,
      reason: `Configured final step '${finalStepId}' does not exist in the plan.`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  const agentId = target.agentId || target.agent || null
  const agentName = target.agentName || agentId || null

  if (target.skipped) {
    return {
      available: false,
      status: 'skipped',
      stepId: finalStepId,
      agentId,
      agentName,
      output: null,
      reason: target.reason || `Final step ${finalStepId} (${agentId || 'agent'}) was skipped.`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  if (isStepResultFailed(target)) {
    const rawText = String(target.output ?? target.result ?? '').trim()
    const detail =
      (typeof target.error === 'string' && target.error) ||
      target.error?.message ||
      (/^Error:/i.test(rawText) ? rawText.replace(/^Error:\s*/i, '') : '') ||
      'Final step execution failed'
    return {
      available: false,
      status: 'failed',
      stepId: finalStepId,
      agentId,
      agentName,
      output: null,
      reason: `Final step ${finalStepId} (${agentId || 'agent'}) failed: ${detail}`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  const rawOut = target.output ?? target.result ?? target.content ?? target.text
  const output = typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut)

  return {
    available: true,
    status: 'completed',
    stepId: finalStepId,
    agentId,
    agentName,
    output,
    reason: null,
    partialResultsAvailable: completedStepCount > 1,
    completedStepCount,
  }
}

function formatRunExport(run) {
  const finalOutput = resolveRunFinalOutput(run)
  return {
    id: run?.id || run?.runId || null,
    runId: run?.runId || run?.id || null,
    task: run?.task || null,
    budget: run?.budget ?? run?.summary?.budget ?? null,
    status: run?.status || (finalOutput.available ? 'completed' : 'partial'),
    plan: run?.plan || null,
    finalStepId: finalOutput.stepId,
    finalOutput,
    results: Array.isArray(run?.results)
      ? run.results
      : Array.isArray(run?.output)
        ? run.output
        : [],
    settledTotals: run?.settledTotals || run?.summary?.settledTotals || [],
    txProofs: run?.txProofs || [],
  }
}

function showResult(r) {
  const p = document.getElementById('result-panel')
  const out = document.getElementById('result-out')
  const ch = document.getElementById('result-chips')

  p.classList.add('visible')
  p.classList.remove('running')
  stopRunHeartbeat()

  const finalInfo = resolveRunFinalOutput(r)
  let finalSection = ''

  if (finalInfo.available) {
    setResultTag('Complete', 'green')
    document.getElementById('result-status-line').textContent =
      `Execution complete. Final output from ${finalInfo.agentName || finalInfo.agentId || 'final step'} (${finalInfo.stepId}) and per-agent outputs are shown below.`
    const finalAnswer = normalizeFinalAnswer(finalInfo.output)
    finalSection = `FINAL ANSWER (${finalInfo.stepId} · ${finalInfo.agentName || finalInfo.agentId})\n${finalAnswer}`
  } else if (finalInfo.partialResultsAvailable) {
    setResultTag('Partial', 'amber')
    document.getElementById('result-status-line').textContent =
      `Partial results only — ${finalInfo.reason}`
    finalSection =
      `FINAL ANSWER (UNAVAILABLE — PARTIAL RESULTS BELOW)\n` +
      `No final output available (${finalInfo.status}): ${finalInfo.reason}\n` +
      `Completed intermediate steps (${finalInfo.completedStepCount}) are shown below as partial results.`
  } else {
    setResultTag('Incomplete', 'amber')
    document.getElementById('result-status-line').textContent =
      `No final output available — ${finalInfo.reason}`
    finalSection =
      `FINAL ANSWER (UNAVAILABLE)\n` +
      `No final output available (${finalInfo.status}): ${finalInfo.reason}`
  }

  let details = ''
  const stepList = Array.isArray(r.results) ? r.results : []
  for (let i = 0; i < stepList.length; i++) {
    const x = stepList[i]
    const stepLabel = x.stepId || `step-${i}`
    const finalBadge = finalInfo.stepId && stepLabel === finalInfo.stepId ? ' [FINAL STEP]' : ''
    if (x.skipped) {
      details += `\n[SKIPPED] ${stepLabel}${finalBadge} ${x.agentId}: ${x.reason}\n`
    } else if (isStepResultFailed(x)) {
      details += `\n[FAILED] ${stepLabel}${finalBadge} ${x.agentName || x.agentId}: ${x.error || x.output || 'Step execution failed'}\n`
    } else {
      details += `\n--- ${stepLabel}${finalBadge} ${x.agentName || x.agentId} (quoted ${x.cost} ${x.currency}; settled ${formatSettlementLabel(x)}) ---\n${x.output}\n`
    }
  }

  out.textContent = `${finalSection}\n\nAGENT DETAILS${details || '\nNo agent steps executed.'}`

  const txL = (r.payments || [])
    .map(
      (p) =>
        `<a href="${p.explorerUrl}" target="_blank" class="fi-link">${p.txHash?.slice(0, 8)} &nearr;</a>`
    )
    .join(' ')

  ch.innerHTML = `
    <div class="chip">Agents: <span class="v">${r.agentsUsed || 0}</span></div>
    <div class="chip">Final Step: <span class="v">${finalInfo.stepId || 'none'} (${finalInfo.status})</span></div>
    <div class="chip">Quoted: <span class="v">${r.quotedTotal || r.totalSpent || '0'} USDC</span></div>
    <div class="chip">Settled: <span class="v">${formatAssetTotals(r.settledTotals)}</span></div>
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
  pushLiveLine(finalInfo.available ? 'Final answer generated' : `Final output ${finalInfo.status}`)
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

  // Render outputs/steps and explicit final output contract (Issue #173)
  const outputSection = document.getElementById('detail-output-section')
  const outputs = run.results || run.output || run.result?.results || run.result?.output || []
  const finalInfo = resolveRunFinalOutput(run)
  const finalBannerHtml = finalInfo.available
    ? `<div class="output-item final-output-banner" data-final-status="completed" data-final-step-id="${escapeHtml(finalInfo.stepId || '')}">
        <div class="output-header">Final Output · ${escapeHtml(finalInfo.stepId || '')} (${escapeHtml(finalInfo.agentName || finalInfo.agentId || 'final agent')})</div>
        <pre class="output-content">${escapeHtml(finalInfo.output || '')}</pre>
      </div>`
    : `<div class="output-item final-output-banner" data-final-status="${escapeHtml(finalInfo.status || 'unavailable')}" data-final-step-id="${escapeHtml(finalInfo.stepId || '')}">
        <div class="output-header">Final Output Unavailable (${escapeHtml(finalInfo.status || 'unavailable')})</div>
        <pre class="output-content">${escapeHtml(finalInfo.reason || 'No final output available.')}${
          finalInfo.partialResultsAvailable
            ? `\nPartial results from ${finalInfo.completedStepCount} completed step(s) are shown below.`
            : ''
        }</pre>
      </div>`

  if (Array.isArray(outputs) && outputs.length > 0) {
    outputSection.style.display = 'block'
    const stepsHtml = outputs
      .map((o, i) => {
        const stepId = o.stepId || `step-${i}`
        const agent = o.agentName || o.agent || o.agentId || stepId
        const isFinal = finalInfo.stepId && stepId === finalInfo.stepId
        const finalTag = isFinal ? ' [Final Step]' : ''
        const statusTag = o.skipped
          ? ' [Skipped]'
          : isStepResultFailed(o)
            ? ' [Failed]'
            : ' [Completed]'
        const content = o.skipped
          ? `Skipped: ${o.reason || 'Budget limit'}`
          : isStepResultFailed(o)
            ? `Failed: ${o.error || o.output || o.result || 'Step execution failed'}`
            : o.output ||
              o.content ||
              o.result ||
              o.response ||
              o.text ||
              JSON.stringify(o, null, 2)
        return `<div class="output-item" data-step-id="${escapeHtml(stepId)}">
          <div class="output-header">${i + 1}. ${escapeHtml(stepId)}${escapeHtml(finalTag)}${escapeHtml(statusTag)} · ${escapeHtml(agent)}</div>
          <pre class="output-content">${escapeHtml(content)}</pre>
        </div>`
      })
      .join('')
    document.getElementById('detail-outputs').innerHTML = `${finalBannerHtml}${stepsHtml}`
  } else if (run.outputAvailable) {
    outputSection.style.display = 'block'
    document.getElementById('detail-outputs').innerHTML =
      `${finalBannerHtml}<div style="padding: 12px; color: var(--text-muted);">Output available but empty</div>`
  } else {
    outputSection.style.display = 'block'
    document.getElementById('detail-outputs').innerHTML =
      `${finalBannerHtml}<div style="padding: 12px; color: var(--text-muted);">No output stored for this run</div>`
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
