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
        `x402 payment settled for ${ev.agent || 'agent'} (${ev.amount || '?'} ${ev.currency || ''})`
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
