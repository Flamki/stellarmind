/**
 * Orchestration Module
 * Handles task execution and live run tracking
 */

let isRunning = false
let isPreviewing = false
let activeRun = null
let currentPreview = null
let reviewState = 'idle'

function getReviewState() {
  return {
    state: reviewState,
    preview: currentPreview,
    isRunning,
    isPreviewing,
  }
}

function stopRunHeartbeat() {
  if (!activeRun?.heartbeatTimer) return
  clearInterval(activeRun.heartbeatTimer)
  activeRun.heartbeatTimer = null
}

function startLiveRun(task, budget) {
  stopRunHeartbeat()
  activeRun = {
    task,
    budget,
    startedAt: Date.now(),
    lastUpdateAt: Date.now(),
    planned: 0,
    completed: 0,
    spent: 0,
    running: true,
    startedAgents: new Set(),
    completedAgents: new Set(),
    heartbeatTimer: null,
  }

  const panel = ensureResultPanelVisible()
  panel.classList.add('running')
  setResultTag('Running', 'amber')

  document.getElementById('result-status-line').textContent =
    `Working on: "${task}". Live updates will appear below as each agent responds.`
  document.getElementById('result-live').innerHTML = ''
  document.getElementById('result-out').textContent = 'Starting orchestrator...'

  pushLiveLine('Orchestrator started')

  activeRun.heartbeatTimer = setInterval(() => {
    if (!activeRun?.running) return
    const idleMs = Date.now() - (activeRun.lastUpdateAt || activeRun.startedAt)
    if (idleMs >= 8000) {
      appendResultLog('Still processing... waiting for the next agent response.')
      activeRun.lastUpdateAt = Date.now()
    }
  }, 3000)

  renderLiveChips(activeRun)
}

function trackLiveEvent(ev) {
  if (!activeRun || !activeRun.running) return
  activeRun.lastUpdateAt = Date.now()

  switch (ev.type) {
    case 'orchestrator_plan':
      activeRun.planned = Number(ev.subtaskCount) || activeRun.planned
      pushLiveLine(`Plan ready: ${activeRun.planned} subtasks`)
      appendResultLog(`Plan created: ${ev.plan || 'Multi-agent flow selected.'}`)
      document.getElementById('result-status-line').textContent =
        `Plan ready. Executing ${activeRun.planned || 'multiple'} agent tasks now.`
      break

    case 'agent_call': {
      const agentKey = ev.agentId || ev.agent || 'unknown-agent'
      if (!activeRun.startedAgents.has(agentKey)) {
        activeRun.startedAgents.add(agentKey)
        pushLiveLine(`${ev.agent || 'Agent'} started`)
        appendResultLog(`Calling ${ev.agent || ev.agentId} (${ev.cost || 'n/a'} USDC)`)
        document.getElementById('result-status-line').textContent =
          `${ev.agent || 'Agent'} is running now...`
      }
      break
    }

    case 'x402_payment':
      appendResultLog(
        `x402 payment settled for ${ev.agent || 'agent'} (${ev.amount || '?'} ${ev.asset || ev.currency || ''})`
      )
      break

    case 'x402_retry':
      appendResultLog(`x402 retry for ${ev.agent || 'agent'}; fallback path engaged`)
      break

    case 'agent_response': {
      const agentKey = ev.agentId || ev.agent || `agent-${activeRun.completed + 1}`
      if (!activeRun.completedAgents.has(agentKey)) {
        activeRun.completedAgents.add(agentKey)
        activeRun.completed += 1
        activeRun.spent += Number.parseFloat(ev.cost || '0') || 0
        pushLiveLine(`${ev.agent || 'Agent'} finished`)
        appendResultLog(`${ev.agent || 'Agent'} output: ${ev.resultPreview || 'Result received.'}`)
      }
      break
    }

    case 'budget_limit':
      appendResultLog(`Budget limit reached: ${ev.message || `${ev.agent} skipped`}`)
      document.getElementById('result-status-line').textContent =
        'Budget limit reached for one of the planned agents.'
      break

    case 'orchestrator_complete':
      activeRun.running = false
      stopRunHeartbeat()
      pushLiveLine('Run completed')
      break

    default:
      break
  }

  renderLiveChips(activeRun)
}

function invalidatePlanPreview(reason) {
  if (!currentPreview) return
  currentPreview = {
    ...currentPreview,
    valid: false,
    invalidated: true,
    invalidationCode: 'TASK_OR_BUDGET_EDITED',
    invalidationReason:
      reason || 'Task or budget changed. Request a new preview before starting agents.',
  }
  reviewState = 'idle'
  if (typeof renderPlanPreviewInvalidated === 'function') {
    renderPlanPreviewInvalidated(currentPreview.invalidationReason)
  }
}

function handleTaskOrBudgetEdit() {
  if (!currentPreview || currentPreview.invalidated) return
  const taskEl = document.getElementById('task-input')
  const budgetEl = document.getElementById('budget-slider')
  const currentTask = taskEl ? taskEl.value.trim() : currentPreview.task
  const currentBudget = budgetEl ? parseFloat(budgetEl.value) : currentPreview.budget
  if (
    currentTask !== currentPreview.task ||
    Math.abs(Number(currentBudget) - Number(currentPreview.budget)) > 1e-9
  ) {
    invalidatePlanPreview('Task or budget changed. Request a new preview before starting agents.')
  }
}

function editTaskFromPreview() {
  invalidatePlanPreview('Editing task or budget. Request a new preview to see updated quotes.')
  const taskEl = document.getElementById('task-input')
  if (taskEl && typeof taskEl.focus === 'function') {
    taskEl.focus()
  }
}

async function previewPlan() {
  if (isPreviewing || isRunning) return null
  isPreviewing = true

  const taskEl = document.getElementById('task-input')
  const task = taskEl ? taskEl.value.trim() : ''
  if (!task) {
    if (taskEl && typeof taskEl.focus === 'function') taskEl.focus()
    isPreviewing = false
    return null
  }

  const budgetEl = document.getElementById('budget-slider')
  const budget = budgetEl ? parseFloat(budgetEl.value) : 0.15
  const btn = document.getElementById('btn-run')
  const confirmBtn = document.getElementById('btn-confirm-plan')

  reviewState = 'previewing'
  if (btn) {
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span>Previewing Plan...'
  }
  if (confirmBtn) {
    confirmBtn.disabled = true
  }

  try {
    const res = await fetch('/api/orchestrate/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, budget }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.message || data.error || `Failed to preview plan (${res.status})`)
    }

    const rawSteps = Array.isArray(data.steps) ? data.steps : []
    const steps = rawSteps.map((step, idx) => ({
      ...step,
      stepId: step.stepId || `step-${idx}`,
      order: idx + 1,
      asset: step.currency || step.asset || 'USDC',
      currency: step.currency || step.asset || 'USDC',
      quote: String(step.quote ?? step.cost ?? '0.0000'),
      dependsOn:
        idx === 0
          ? 'Step 1 (initial task input)'
          : `Step ${idx + 1} (depends on Step ${idx}: ${rawSteps[idx - 1].agentName || rawSteps[idx - 1].agentId})`,
    }))

    const totalAsset = steps[0]?.asset || 'USDC'
    const totalQuote = String(data.totalQuote ?? '0.0000')
    const insufficientBudget =
      steps.length === 0 || Number.parseFloat(totalQuote) > Number.parseFloat(budget)

    currentPreview = {
      ...data,
      task,
      budget,
      steps,
      totalQuote,
      totalAsset,
      insufficientBudget,
      valid: !insufficientBudget,
      invalidated: false,
      invalidationCode: insufficientBudget ? 'INSUFFICIENT_BUDGET' : null,
      invalidationReason: insufficientBudget
        ? `Quoted total (${totalQuote} ${totalAsset}) exceeds budget (${Number(budget).toFixed(2)} ${totalAsset}).`
        : null,
    }

    reviewState = 'review'
    if (typeof renderPlanPreview === 'function') {
      renderPlanPreview(currentPreview)
    }
    return currentPreview
  } catch (e) {
    reviewState = 'error'
    currentPreview = null
    if (typeof addFeed === 'function') {
      addFeed({ type: 'error', message: e.message })
    }
    if (typeof setResultTag === 'function') {
      setResultTag('Error', 'amber')
    }
    const statusLine = document.getElementById('result-status-line')
    if (statusLine) {
      statusLine.textContent = `Preview failed: ${e.message}`
    }
    return null
  } finally {
    isPreviewing = false
    if (btn) {
      btn.disabled = false
      btn.innerHTML = 'Preview Plan'
    }
  }
}

async function confirmPlanExecution() {
  if (isRunning || isPreviewing) return null
  if (!currentPreview || !currentPreview.planId || currentPreview.invalidated) {
    return null
  }

  // Re-check current inputs in case they were modified without firing input events
  handleTaskOrBudgetEdit()
  if (!currentPreview || currentPreview.invalidated) {
    return null
  }

  if (currentPreview.insufficientBudget) {
    if (typeof renderPlanPreview === 'function') {
      renderPlanPreview(currentPreview)
    }
    return null
  }

  if (currentPreview.expiresAt && Date.now() > new Date(currentPreview.expiresAt).getTime()) {
    currentPreview = {
      ...currentPreview,
      valid: false,
      invalidated: true,
      expired: true,
      invalidationCode: 'QUOTE_EXPIRED',
      invalidationReason: `Plan quote expired at ${currentPreview.expiresAt}. Request a new preview to continue.`,
    }
    reviewState = 'review'
    if (typeof renderPlanReviewError === 'function') {
      renderPlanReviewError(currentPreview)
    }
    return null
  }

  const planToExecute = currentPreview
  isRunning = true
  reviewState = 'executing'
  // Mark consumed immediately so repeated clicks cannot trigger a second run
  currentPreview = {
    ...planToExecute,
    valid: false,
    invalidated: true,
    consumed: true,
  }

  const btn = document.getElementById('btn-run')
  const confirmBtn = document.getElementById('btn-confirm-plan')
  if (btn) {
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span>Running Agents...'
  }
  if (confirmBtn) {
    confirmBtn.disabled = true
    confirmBtn.innerHTML = '<span class="spinner"></span>Executing...'
  }

  startLiveRun(planToExecute.task, planToExecute.budget)

  try {
    const res = await fetch('/api/orchestrate/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: planToExecute.planId,
        idempotencyKey: `exec_${planToExecute.planId}`,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const code = data.code || ''
      if (
        code === 'QUOTE_EXPIRED' ||
        code === 'QUOTE_CHANGED' ||
        code === 'PLAN_NOT_FOUND' ||
        res.status === 409
      ) {
        if (activeRun) activeRun.running = false
        stopRunHeartbeat()
        const resultPanel = document.getElementById('result-panel')
        if (resultPanel) resultPanel.classList.remove('running')
        setResultTag('Review Needed', 'amber')
        const statusLine = document.getElementById('result-status-line')
        if (statusLine) {
          statusLine.textContent =
            data.message || 'Quote expired or changed before execution. Please review and re-quote.'
        }

        currentPreview = {
          ...planToExecute,
          valid: false,
          invalidated: true,
          expired: code === 'QUOTE_EXPIRED',
          quoteChanged: code === 'QUOTE_CHANGED',
          invalidationCode: code || 'QUOTE_INVALID',
          invalidationReason:
            data.message || 'Quote expired or changed. Please request a new preview.',
        }
        reviewState = 'review'
        if (typeof renderPlanReviewError === 'function') {
          renderPlanReviewError(currentPreview)
        }
        return null
      }

      throw new Error(data.message || data.error || `Run failed (${res.status})`)
    }

    currentPreview = null
    reviewState = 'completed'
    if (typeof hidePlanPreview === 'function') {
      hidePlanPreview()
    }
    showResult(data)
    if (typeof loadWallets === 'function') {
      loadWallets()
    }
    return data
  } catch (e) {
    reviewState = 'error'
    if (typeof addFeed === 'function') {
      addFeed({ type: 'error', message: e.message })
    }
    if (activeRun) activeRun.running = false
    stopRunHeartbeat()
    setResultTag('Error', 'amber')
    document.getElementById('result-status-line').textContent = `Run failed: ${e.message}`
    renderLiveChips(activeRun)
    return null
  } finally {
    isRunning = false
    if (btn) {
      btn.disabled = false
      btn.innerHTML = 'Preview Plan'
    }
    if (confirmBtn) {
      confirmBtn.innerHTML = 'Confirm & Run Agents'
      confirmBtn.disabled = Boolean(!currentPreview || currentPreview.invalidated)
    }
  }
}

async function runOrchestration() {
  return previewPlan()
}
