/**
 * SSE Module
 * Handles Server-Sent Events connection, ordered Last-Event-ID resume,
 * client-side deduplication, and expired-cursor resync via run detail.
 */

let evCnt = 0
let lastSeenEventId = null
let currentEventSource = null
let lastResyncedRun = null
const seenEventIds = new Set()
const MAX_SEEN_EVENT_IDS = 1000

function rememberEventId(eventId) {
  if (!eventId || typeof eventId !== 'string') return false
  const normalized = eventId.trim()
  if (!normalized) return false
  if (seenEventIds.has(normalized)) return false
  seenEventIds.add(normalized)
  while (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
    const oldest = seenEventIds.values().next().value
    seenEventIds.delete(oldest)
  }
  lastSeenEventId = normalized
  return true
}

function hasSeenEventId(eventId) {
  if (!eventId || typeof eventId !== 'string') return false
  return seenEventIds.has(eventId.trim())
}

function getLastEventId() {
  return lastSeenEventId
}

function getLastResyncedRun() {
  return lastResyncedRun
}

function resetSSEState() {
  evCnt = 0
  lastSeenEventId = null
  lastResyncedRun = null
  seenEventIds.clear()
  if (currentEventSource && typeof currentEventSource.close === 'function') {
    try {
      currentEventSource.close()
    } catch {}
  }
  currentEventSource = null
}

function buildSSEUrl(basePath = '/api/events', overrideLastEventId = undefined) {
  const cursor = overrideLastEventId !== undefined ? overrideLastEventId : lastSeenEventId
  if (!cursor) return basePath
  const sep = basePath.includes('?') ? '&' : '?'
  return `${basePath}${sep}lastEventId=${encodeURIComponent(cursor)}`
}

async function handleResyncRequired(ev) {
  if (ev?.latestEventId) {
    lastSeenEventId = ev.latestEventId
  }

  const targetUrl =
    ev?.runDetailUrl || ev?.resyncUrl || (ev?.runId ? `/api/runs/${ev.runId}` : null)

  addFeed({
    ...ev,
    type: 'resync_required',
    eventId: null,
    id: null,
  })

  if (!targetUrl || typeof fetch !== 'function') return null

  try {
    const res = await fetch(targetUrl)
    if (!res.ok) return null
    const detail = await res.json()
    lastResyncedRun = detail

    if (Array.isArray(detail?.events)) {
      for (const persistedEvent of detail.events) {
        addFeed(persistedEvent)
      }
    }

    if (detail?.status === 'completed' && typeof showResult === 'function' && detail.result) {
      showResult(detail.result)
    }

    return detail
  } catch {
    return null
  }
}

function handleSSEMessage(e) {
  const ev = typeof e?.data === 'string' ? JSON.parse(e.data) : e
  if (!ev || typeof ev !== 'object') return { status: 'ignored', event: null }

  const eventId = e?.lastEventId || ev.eventId || ev.id || null

  if (ev.type === 'connected') {
    return { status: 'connected', event: ev }
  }

  if (ev.type === 'resync_required') {
    const resyncPromise = handleResyncRequired(ev)
    return { status: 'resync_required', event: ev, resyncPromise }
  }

  if (eventId && hasSeenEventId(eventId)) {
    return { status: 'duplicate', eventId, event: ev }
  }

  const added = addFeed(ev, eventId)
  return {
    status: added ? 'delivered' : 'duplicate',
    eventId,
    event: ev,
  }
}

function connectSSE(overrideLastEventId) {
  if (currentEventSource && typeof currentEventSource.close === 'function') {
    try {
      currentEventSource.close()
    } catch {}
  }
  const url = buildSSEUrl('/api/events', overrideLastEventId)
  const es = new EventSource(url)
  currentEventSource = es
  es.onmessage = (e) => {
    try {
      handleSSEMessage(e)
    } catch {}
  }
  es.onerror = () => {
    try {
      es.close?.()
    } catch {}
    setTimeout(() => connectSSE(), 3000)
  }
  return es
}

function addFeed(ev, explicitEventId = null) {
  if (!ev || typeof ev !== 'object') return false
  const eventId = explicitEventId || ev.eventId || ev.id || null
  if (eventId) {
    if (!rememberEventId(eventId)) {
      return false
    }
  }

  const f = document.getElementById('feed')
  const em = document.getElementById('feed-empty')
  if (em) em.style.display = 'none'

  evCnt++
  const evCntEl = document.getElementById('ev-cnt')
  if (evCntEl) evCntEl.textContent = `${evCnt} Events`

  const el = document.createElement('div')
  el.className = 'fi'
  if (eventId) el.dataset = { ...(el.dataset || {}), eventId }

  let ic = '📡',
    cl = 'agt',
    lb = '',
    sb = ''

  switch (ev.type) {
    case 'orchestrator_start':
      ic = '🎯'
      cl = 'pln'
      lb = 'Orchestrator Started'
      sb = `Task: ${ev.task?.substring(0, 45)}...`
      break
    case 'orchestrator_plan':
      ic = '📋'
      cl = 'pln'
      lb = `Plan: ${ev.plan?.substring(0, 40)}`
      sb = `${ev.subtaskCount} subtasks`
      break
    case 'agent_call':
      ic = '⚡'
      cl = 'agt'
      lb = `${ev.agent} called`
      sb = `${ev.cost} USDC | ${ev.paymentFlow || 'stellar'}`
      highlightAgent(ev.agentId)
      break
    case 'x402_payment':
      ic = '🔐'
      cl = 'x4'
      lb = `x402: ${ev.agent}`
      sb = `${ev.amount} ${ev.asset || ev.currency} via x402${ev.verification === 'unverified' ? ' (header pending)' : ''}`
      break
    case 'x402_retry':
      ic = '🔁'
      cl = 'x4'
      lb = 'x402 retry handled'
      sb = `${ev.agent || 'agent'} | fallback flow active`
      break
    case 'agent_response':
      ic = '✅'
      cl = 'ok'
      lb = `${ev.agent} responded`
      sb = `${ev.paidVia ? '[' + ev.paidVia + '] ' : ''}${(ev.resultPreview || 'Output received').substring(0, 40)}...`
      break
    case 'payment':
      ic = '💸'
      cl = 'pay'
      lb = `${ev.from} -> ${ev.to}`
      // The settled asset/amount, not the quoted price.
      sb = `${ev.amount} ${ev.asset || ev.currency} | ${ev.method || 'stellar'}`
      break
    case 'budget_limit':
      ic = '🛑'
      cl = 'bgt'
      lb = `Budget: ${ev.agent} skipped`
      sb = `Need ${ev.cost}, ${ev.remaining} left`
      break
    case 'orchestrator_complete':
      ic = '🏁'
      cl = 'ok'
      lb = `Done - quoted ${ev.quotedTotal || ev.totalSpent} USDC`
      sb = `Settled: ${ev.settledSummary || 'none'} | ${ev.agentsUsed} agents | ${ev.elapsed}`
      break
    case 'resync_required':
      ic = '🔁'
      cl = 'pln'
      lb = 'Stream Resync Required'
      sb = `Cursor expired -> ${ev.runDetailUrl || ev.resyncUrl || '/api/runs'}`
      break
    case 'error':
      ic = '⚠️'
      cl = 'bgt'
      lb = 'Run Error'
      sb = (ev.message || 'Unknown error').substring(0, 60)
      break
    default:
      lb = ev.type
      sb = JSON.stringify(ev).substring(0, 60)
  }

  const at = ev.timestamp
    ? new Date(ev.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null
  if (at) sb = sb ? `${sb} | ${at}` : at

  const lk = ev.explorerUrl
    ? `<a href="${ev.explorerUrl}" target="_blank" class="fi-link">TX &nearr;</a>`
    : ''

  el.innerHTML = `<div class="fi-icon ${cl}">${ic}</div><div class="fi-info"><div class="fi-l">${lb}</div><div class="fi-s">${sb}</div></div>${lk}`
  if (f) f.prepend(el)

  trackLiveEvent(ev)
  return true
}
