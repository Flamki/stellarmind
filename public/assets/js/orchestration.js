/**
 * Orchestration Module
 * Handles task execution and live run tracking
 */

let isRunning = false
let activeRun = null

function stopRunHeartbeat() {
  if (!activeRun?.heartbeatTimer) return
  clearInterval(activeRun.heartbeatTimer)
  activeRun.heartbeatTimer = null
}

function setActiveRunId(runId) {
  if (!activeRun || !runId) return
  activeRun.runId = String(runId).trim()
  activeRun.explicitRunId = true
}

function resolveStepKey(ev) {
  if (ev?.stepId !== undefined && ev?.stepId !== null && String(ev.stepId).trim() !== '') {
    return String(ev.stepId).trim()
  }
  if (ev?.stepIndex !== undefined && ev?.stepIndex !== null) {
    return `step-${ev.stepIndex}`
  }
  const agentKey = ev?.agentId || ev?.agent || 'unknown-agent'
  return `agent:${agentKey}`
}

function isFailedStepEvent(ev) {
  if (!ev || typeof ev !== 'object') return false
  if (ev.type === 'agent_failed' || ev.type === 'step_failed') return true
  if (ev.failed === true) return true
  if (ev.status === 'failed' || ev.status === 'error') return true
  if (ev.outcome === 'failed' || ev.outcome === 'error') return true
  if (ev.error) return true
  if (typeof ev.resultPreview === 'string' && ev.resultPreview.startsWith('Error:')) return true
  if (typeof ev.result === 'string' && ev.result.startsWith('Error:')) return true
  return false
}

function isSkippedStepEvent(ev) {
  if (!ev || typeof ev !== 'object') return false
  if (ev.type === 'budget_limit' || ev.type === 'agent_skipped' || ev.type === 'step_skipped') {
    return true
  }
  if (ev.skipped === true || ev.status === 'skipped' || ev.outcome === 'skipped') return true
  return false
}

function matchesActiveRun(ev, run = activeRun) {
  if (!run || !ev || typeof ev !== 'object') return false
  if (ev.runId !== undefined && ev.runId !== null && String(ev.runId).trim() !== '') {
    const incomingRunId = String(ev.runId).trim()
    if (run.runId) {
      return incomingRunId === run.runId
    }
    if (ev.task && run.task && ev.task !== run.task) {
      return false
    }
    run.runId = incomingRunId
    return true
  }
  if (run.explicitRunId && run.runId) {
    return false
  }
  if (Object.prototype.hasOwnProperty.call(ev, 'runId') && ev.runId !== run.runId) {
    return false
  }
  if (ev.task && run.task && ev.task !== run.task) {
    return false
  }
  return true
}

function startLiveRun(task, budget, runId = null) {
  stopRunHeartbeat()
  const normalizedRunId =
    runId !== undefined && runId !== null && String(runId).trim() !== ''
      ? String(runId).trim()
      : null
  activeRun = {
    runId: normalizedRunId,
    explicitRunId: Boolean(normalizedRunId),
    task,
    budget,
    startedAt: Date.now(),
    lastUpdateAt: Date.now(),
    planned: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    terminal: 0,
    spent: 0,
    running: true,
    startedSteps: new Set(),
    completedSteps: new Set(),
    failedSteps: new Set(),
    skippedSteps: new Set(),
    terminalSteps: new Set(),
    stepCosts: new Map(),
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
  return activeRun
}

function trackLiveEvent(ev) {
  if (!activeRun || !activeRun.running) return false
  if (!matchesActiveRun(ev, activeRun)) return false
  activeRun.lastUpdateAt = Date.now()

  switch (ev.type) {
    case 'orchestrator_start':
      if (ev.runId && !activeRun.runId) {
        activeRun.runId = String(ev.runId).trim()
      }
      break

    case 'orchestrator_plan': {
      const plannedCount = Number(ev.subtaskCount ?? ev.steps?.length)
      if (Number.isFinite(plannedCount) && plannedCount > 0) {
        activeRun.planned = plannedCount
      }
      pushLiveLine(`Plan ready: ${activeRun.planned} subtasks`)
      appendResultLog(`Plan created: ${ev.plan || 'Multi-agent flow selected.'}`)
      document.getElementById('result-status-line').textContent =
        `Plan ready. Executing ${activeRun.planned || 'multiple'} agent tasks now.`
      break
    }

    case 'agent_call': {
      const stepKey = resolveStepKey(ev)
      if (activeRun.startedSteps.has(stepKey) || activeRun.terminalSteps.has(stepKey)) {
        return false
      }
      activeRun.startedSteps.add(stepKey)
      if (ev.agentId || ev.agent) {
        activeRun.startedAgents.add(ev.agentId || ev.agent)
      }
      pushLiveLine(`${ev.agent || 'Agent'} started`)
      appendResultLog(`Calling ${ev.agent || ev.agentId} (${ev.cost || 'n/a'} USDC)`)
      document.getElementById('result-status-line').textContent =
        `${ev.agent || 'Agent'} is running now...`
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
      const stepKey = resolveStepKey(ev)
      if (activeRun.terminalSteps.has(stepKey)) {
        return false
      }
      activeRun.terminalSteps.add(stepKey)
      activeRun.startedSteps.add(stepKey)

      if (isSkippedStepEvent(ev)) {
        activeRun.skippedSteps.add(stepKey)
        activeRun.skipped += 1
        activeRun.terminal = activeRun.completed + activeRun.failed + activeRun.skipped
        pushLiveLine(`${ev.agent || 'Agent'} skipped`)
        appendResultLog(
          `Budget limit reached: ${ev.reason || ev.message || `${ev.agent || ev.agentId || 'Agent'} skipped`}`
        )
        document.getElementById('result-status-line').textContent =
          'Budget limit reached for one of the planned agents.'
      } else if (isFailedStepEvent(ev)) {
        activeRun.failedSteps.add(stepKey)
        activeRun.failed += 1
        activeRun.terminal = activeRun.completed + activeRun.failed + activeRun.skipped
        const errText = ev.error || ev.resultPreview || 'Step execution failed.'
        pushLiveLine(`${ev.agent || 'Agent'} failed`)
        appendResultLog(`${ev.agent || 'Agent'} failed: ${errText}`)
        document.getElementById('result-status-line').textContent =
          `${ev.agent || 'Agent'} step failed.`
      } else {
        activeRun.completedSteps.add(stepKey)
        if (ev.agentId || ev.agent) {
          activeRun.completedAgents.add(ev.agentId || ev.agent)
        }
        activeRun.completed += 1
        activeRun.terminal = activeRun.completed + activeRun.failed + activeRun.skipped
        const stepCost = Number.parseFloat(ev.cost || '0') || 0
        activeRun.spent += stepCost
        activeRun.stepCosts.set(stepKey, stepCost)
        pushLiveLine(`${ev.agent || 'Agent'} finished`)
        appendResultLog(`${ev.agent || 'Agent'} output: ${ev.resultPreview || 'Result received.'}`)
      }
      break
    }

    case 'agent_failed':
    case 'step_failed': {
      const stepKey = resolveStepKey(ev)
      if (activeRun.terminalSteps.has(stepKey)) {
        return false
      }
      activeRun.terminalSteps.add(stepKey)
      activeRun.failedSteps.add(stepKey)
      activeRun.failed += 1
      activeRun.terminal = activeRun.completed + activeRun.failed + activeRun.skipped
      const errText = ev.error || ev.message || 'Step execution failed.'
      pushLiveLine(`${ev.agent || ev.agentId || 'Agent'} failed`)
      appendResultLog(`${ev.agent || ev.agentId || 'Agent'} failed: ${errText}`)
      document.getElementById('result-status-line').textContent =
        `${ev.agent || ev.agentId || 'Agent'} step failed.`
      break
    }

    case 'budget_limit':
    case 'agent_skipped':
    case 'step_skipped': {
      const stepKey = resolveStepKey(ev)
      if (activeRun.terminalSteps.has(stepKey)) {
        return false
      }
      activeRun.terminalSteps.add(stepKey)
      activeRun.skippedSteps.add(stepKey)
      activeRun.skipped += 1
      activeRun.terminal = activeRun.completed + activeRun.failed + activeRun.skipped
      pushLiveLine(`${ev.agent || ev.agentId || 'Agent'} skipped`)
      appendResultLog(`Budget limit reached: ${ev.message || `${ev.agent} skipped`}`)
      document.getElementById('result-status-line').textContent =
        'Budget limit reached for one of the planned agents.'
      break
    }

    case 'orchestrator_complete':
      activeRun.running = false
      stopRunHeartbeat()
      pushLiveLine('Run completed')
      break

    default:
      break
  }

  renderLiveChips(activeRun)
  return true
}

async function runOrchestration() {
  if (isRunning) return
  isRunning = true

  const task = document.getElementById('task-input').value.trim()
  if (!task) {
    document.getElementById('task-input').focus()
    isRunning = false
    return
  }

  const budget = parseFloat(document.getElementById('budget-slider').value)
  const btn = document.getElementById('btn-run')

  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Running Agents...'

  startLiveRun(task, budget)

  try {
    const r = await (
      await fetch('/api/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, budget }),
      })
    ).json()

    if (r?.runId) {
      setActiveRunId(r.runId)
    }
    showResult(r)
    loadWallets()
  } catch (e) {
    addFeed({ type: 'error', message: e.message })
    if (activeRun) activeRun.running = false
    stopRunHeartbeat()
    setResultTag('Error', 'amber')
    document.getElementById('result-status-line').textContent = `Run failed: ${e.message}`
    renderLiveChips(activeRun)
  } finally {
    isRunning = false
    btn.disabled = false
    btn.innerHTML = 'Run Agents'
  }
}
