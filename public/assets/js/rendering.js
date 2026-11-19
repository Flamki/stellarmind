/**
 * Rendering Module
 * Handles result display and progress rendering
 */

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
      : `\n--- ${x.agentName} (${x.cost} ${x.currency}) ---\n${x.output}\n`
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
    <div class="chip">Spent: <span class="v">${r.totalSpent || '0'} USDC</span></div>
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
    activeRun.spent = Number.parseFloat(r.totalSpent || activeRun.spent || 0)
  }

  renderLiveChips(activeRun)
  pushLiveLine('Final answer generated')
}

/**
 * Show preview panel with plan details
 */
function showPreview(plan) {
  const previewPanel = document.getElementById('preview-panel')
  if (!previewPanel) return

  // Calculate totals
  const totalQuoted = (plan.steps || []).reduce((sum, step) => {
    return sum + (parseFloat(step.quotedCost) || 0)
  }, 0)

  const asset = plan.steps?.[0]?.quotedAsset || 'USDC'
  const stepCount = plan.steps?.length || 0

  // Build steps HTML
  const stepsHtml = (plan.steps || []).map((step, index) => {
    const stepNum = index + 1
    const agentName = step.agentName || step.agentId || 'Unknown Agent'
    const cost = parseFloat(step.quotedCost || 0).toFixed(3)
    const deps = step.dependencies?.length > 0 
      ? `<span class="preview-deps">Depends on: ${step.dependencies.join(', ')}</span>`
      : ''
    
    return `
      <div class="preview-step">
        <div class="preview-step-header">
          <span class="preview-step-num">${stepNum}</span>
          <span class="preview-step-name">${agentName}</span>
          <span class="preview-step-cost">${cost} ${asset}</span>
        </div>
        ${deps}
      </div>
    `
  }).join('')

  // Update preview content
  document.getElementById('preview-steps').innerHTML = stepsHtml || '<p style="color: var(--text-muted);">No steps planned.</p>'
  document.getElementById('preview-total-cost').textContent = `${totalQuoted.toFixed(3)} ${asset}`
  document.getElementById('preview-step-count').textContent = stepCount
  document.getElementById('preview-budget').textContent = `${lastPreviewParams.budget.toFixed(2)} ${asset}`

  // Show/hide budget warning
  const budgetWarning = document.getElementById('preview-budget-warning')
  if (totalQuoted > lastPreviewParams.budget) {
    budgetWarning.style.display = 'block'
    document.getElementById('preview-confirm-btn').disabled = true
  } else {
    budgetWarning.style.display = 'none'
    document.getElementById('preview-confirm-btn').disabled = false
  }

  // Show the preview panel
  previewPanel.style.display = 'block'
  
  // Hide the submit task card
  const taskCard = document.querySelector('.page.active .card')
  if (taskCard) taskCard.style.opacity = '0.5'

  setResultTag('Preview Ready', 'purple')
}

/**
 * Hide preview panel and return to task input
 */
function hidePreview() {
  const previewPanel = document.getElementById('preview-panel')
  if (previewPanel) {
    previewPanel.style.display = 'none'
  }

  // Restore the submit task card
  const taskCard = document.querySelector('.page.active .card')
  if (taskCard) taskCard.style.opacity = '1'

  setResultTag('Idle', '')
}
