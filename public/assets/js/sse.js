/**
 * SSE Module
 * Handles Server-Sent Events connection, bounded live event feed retention,
 * and display-only pause, clear, and event-type filter controls.
 */

const DEFAULT_FEED_MAX_EVENTS = 100
const MIN_FEED_MAX_EVENTS = 10
const MAX_FEED_MAX_EVENTS = 500

const FEED_FILTER_GROUPS = {
  'group:orchestration': ['orchestrator_start', 'orchestrator_plan', 'orchestrator_complete'],
  orchestration: ['orchestrator_start', 'orchestrator_plan', 'orchestrator_complete'],
  orchestrator: ['orchestrator_start', 'orchestrator_plan', 'orchestrator_complete'],
  'group:agent': ['agent_call', 'agent_response'],
  agent: ['agent_call', 'agent_response'],
  agents: ['agent_call', 'agent_response'],
  'group:payment': ['payment', 'x402_payment', 'x402_retry'],
  payments: ['payment', 'x402_payment', 'x402_retry'],
  'group:error': ['budget_limit', 'error'],
  alerts: ['budget_limit', 'error'],
  errors: ['budget_limit', 'error'],
}

let evCnt = 0
let clearedAtCnt = 0
let feedRetentionLimit = DEFAULT_FEED_MAX_EVENTS
let feedEvents = []
let pausedSnapshotEvents = null
let isFeedPaused = false
let pausedBufferedCount = 0
let activeFeedFilter = 'all'
let nextFeedSeq = 1

function normalizeRetentionLimit(limit) {
  const parsed = Number.parseInt(limit, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FEED_MAX_EVENTS
  return Math.max(MIN_FEED_MAX_EVENTS, Math.min(MAX_FEED_MAX_EVENTS, parsed))
}

function matchesFeedFilter(ev, filter = activeFeedFilter) {
  if (!ev || typeof ev !== 'object') return false
  const norm = typeof filter === 'string' ? filter.trim() : 'all'
  if (!norm || norm === 'all') return true
  if (Object.prototype.hasOwnProperty.call(FEED_FILTER_GROUPS, norm)) {
    return FEED_FILTER_GROUPS[norm].includes(ev.type)
  }
  return ev.type === norm
}

function describeFeedEvent(ev) {
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

  return { ic, cl, lb, sb, lk }
}

function createFeedElement(entry) {
  const { ev, seq } = entry
  const { ic, cl, lb, sb, lk } = describeFeedEvent(ev)
  const el = document.createElement('div')
  el.className = 'fi'
  if (el.setAttribute) {
    el.setAttribute('data-event-type', ev.type || 'unknown')
    el.setAttribute('data-event-seq', String(seq))
  }
  if (el.dataset) {
    el.dataset.eventType = ev.type || 'unknown'
    el.dataset.eventSeq = String(seq)
  }
  el.innerHTML = `<div class="fi-icon ${cl}">${ic}</div><div class="fi-info"><div class="fi-l">${lb}</div><div class="fi-s">${sb}</div></div>${lk}`
  return el
}

function getDisplayedSourceEntries() {
  return isFeedPaused && Array.isArray(pausedSnapshotEvents) ? pausedSnapshotEvents : feedEvents
}

function getVisibleFeedEntries() {
  const source = getDisplayedSourceEntries()
  // Return newest-first while preserving exact relative arrival order
  const matching = []
  for (let i = source.length - 1; i >= 0; i -= 1) {
    if (matchesFeedFilter(source[i].ev, activeFeedFilter)) {
      matching.push(source[i])
    }
  }
  return matching
}

function updateFeedCountersAndControls() {
  if (typeof document === 'undefined') return

  const visibleEntries = getVisibleFeedEntries()
  const visibleCount = visibleEntries.length
  const sourceCount = getDisplayedSourceEntries().length

  const cntEl = document.getElementById('ev-cnt')
  if (cntEl) {
    if (evCnt === 0) {
      cntEl.textContent = '0 Events'
    } else {
      const parts = []
      if (activeFeedFilter !== 'all') {
        parts.push(`${visibleCount}/${sourceCount} shown`)
      } else if (evCnt > feedRetentionLimit && sourceCount === feedRetentionLimit) {
        parts.push(`${visibleCount} shown (max ${feedRetentionLimit})`)
      } else {
        parts.push(`${visibleCount} shown`)
      }
      if (isFeedPaused) {
        parts.push(`paused +${pausedBufferedCount}`)
      }
      parts.push(`${evCnt} total Events`)
      cntEl.textContent = parts.join(' · ')
    }
  }

  const pauseBtn = document.getElementById('feed-pause-btn')
  if (pauseBtn) {
    pauseBtn.textContent = isFeedPaused
      ? pausedBufferedCount > 0
        ? `▶ Resume Display (${pausedBufferedCount})`
        : '▶ Resume Display'
      : '⏸ Pause Display'
    if (pauseBtn.setAttribute) {
      pauseBtn.setAttribute('aria-pressed', isFeedPaused ? 'true' : 'false')
    }
  }

  const pauseBanner = document.getElementById('feed-pause-banner')
  if (pauseBanner) {
    if (isFeedPaused) {
      pauseBanner.style.display = 'block'
      pauseBanner.textContent =
        pausedBufferedCount > 0
          ? `Feed display paused (${pausedBufferedCount} new event${pausedBufferedCount === 1 ? '' : 's'} buffered). Server execution and live run progress continue.`
          : 'Feed display paused. Server execution and live run progress continue.'
    } else {
      pauseBanner.style.display = 'none'
      pauseBanner.textContent = ''
    }
  }

  const filterSelect = document.getElementById('feed-filter')
  if (filterSelect && filterSelect.value !== activeFeedFilter) {
    filterSelect.value = activeFeedFilter
  }

  const limitSelect = document.getElementById('feed-limit')
  if (limitSelect && String(limitSelect.value) !== String(feedRetentionLimit)) {
    limitSelect.value = String(feedRetentionLimit)
  }
}

function ensureEmptyStateElement(feedContainer) {
  if (!feedContainer) return null
  let em = document.getElementById('feed-empty')
  if (!em && feedContainer.querySelector) {
    em = feedContainer.querySelector('#feed-empty, .empty-state')
  }
  if (!em && typeof document !== 'undefined' && document.createElement) {
    em = document.createElement('div')
    em.className = 'empty-state'
    em.id = 'feed-empty'
    feedContainer.appendChild(em)
  }
  return em
}

function updateEmptyStateDisplay(feedContainer, visibleCount) {
  const em = ensureEmptyStateElement(feedContainer)
  if (!em) return

  if (visibleCount > 0) {
    em.style.display = 'none'
    return
  }

  em.style.display = ''
  const sourceCount = getDisplayedSourceEntries().length
  if (sourceCount > 0 && activeFeedFilter !== 'all') {
    em.innerHTML = '<div class="es-icon">🔎</div><p>No retained events match the active filter.</p>'
  } else if (clearedAtCnt > 0 && evCnt > 0) {
    em.innerHTML = `<div class="es-icon">🧹</div><p>Feed cleared (${evCnt} session events received).<br />New events will appear here automatically.</p>`
  } else {
    em.innerHTML =
      '<div class="es-icon">📡</div><p>Waiting for agent activity...<br />Submit a task to see real-time events</p>'
  }
}

function trimRenderedFeedNodes(feedContainer) {
  if (!feedContainer || !feedContainer.children) return
  const children = Array.from(feedContainer.children).filter(
    (child) => child.id !== 'feed-empty' && !child.classList?.contains('empty-state')
  )
  for (let i = children.length - 1; i >= feedRetentionLimit; i -= 1) {
    const node = children[i]
    if (feedContainer.removeChild) {
      feedContainer.removeChild(node)
    } else if (node.remove) {
      node.remove()
    }
  }
}

/**
 * Re-render the visible feed from the retained window (or paused snapshot)
 * preserving newest-first ordering.
 */
function renderFeed() {
  if (typeof document === 'undefined') return
  const f = document.getElementById('feed')
  if (!f) return

  const em = ensureEmptyStateElement(f)
  if (Array.isArray(f.children)) {
    f.children = em ? [em] : []
  } else {
    f.innerHTML = ''
    if (em && f.appendChild) f.appendChild(em)
  }

  const visibleEntries = getVisibleFeedEntries()
  updateEmptyStateDisplay(f, visibleEntries.length)

  // Append in newest-first order (or prepend from oldest to newest)
  for (let i = visibleEntries.length - 1; i >= 0; i -= 1) {
    const el = createFeedElement(visibleEntries[i])
    f.prepend(el)
  }

  trimRenderedFeedNodes(f)
  updateFeedCountersAndControls()
}

function connectSSE() {
  const es = new EventSource('/api/events')
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data)
      if (ev.type !== 'connected') addFeed(ev)
    } catch {}
  }
  es.onerror = () => setTimeout(connectSSE, 3000)
}

function addFeed(ev) {
  if (!ev || typeof ev !== 'object') return

  evCnt += 1
  const entry = { seq: nextFeedSeq++, ev }
  feedEvents.push(entry)
  if (feedEvents.length > feedRetentionLimit) {
    feedEvents.splice(0, feedEvents.length - feedRetentionLimit)
  }

  // Always keep sidebar agent pulse and live run progress active even if feed display is paused
  if (ev.type === 'agent_call' && typeof highlightAgent === 'function') {
    highlightAgent(ev.agentId)
  }
  if (typeof trackLiveEvent === 'function') {
    trackLiveEvent(ev)
  }

  if (isFeedPaused) {
    pausedBufferedCount += 1
    updateFeedCountersAndControls()
    return
  }

  const f = typeof document !== 'undefined' ? document.getElementById('feed') : null
  if (f && matchesFeedFilter(ev, activeFeedFilter)) {
    const em = document.getElementById('feed-empty')
    if (em) em.style.display = 'none'
    const el = createFeedElement(entry)
    f.prepend(el)
    trimRenderedFeedNodes(f)
  } else if (f) {
    updateEmptyStateDisplay(f, getVisibleFeedEntries().length)
  }

  updateFeedCountersAndControls()
}

function setFeedPaused(paused) {
  const nextPaused = Boolean(paused)
  if (nextPaused === isFeedPaused) return isFeedPaused

  isFeedPaused = nextPaused
  if (isFeedPaused) {
    pausedSnapshotEvents = feedEvents.slice()
    pausedBufferedCount = 0
    updateFeedCountersAndControls()
  } else {
    pausedSnapshotEvents = null
    pausedBufferedCount = 0
    renderFeed()
  }
  return isFeedPaused
}

function toggleFeedPause() {
  return setFeedPaused(!isFeedPaused)
}

function clearFeed() {
  feedEvents = []
  pausedBufferedCount = 0
  clearedAtCnt = evCnt
  if (isFeedPaused) {
    pausedSnapshotEvents = []
  } else {
    pausedSnapshotEvents = null
  }
  renderFeed()
}

function setFeedFilter(filterValue) {
  activeFeedFilter =
    typeof filterValue === 'string' && filterValue.trim() ? filterValue.trim() : 'all'
  renderFeed()
  return activeFeedFilter
}

function setFeedRetentionLimit(limit) {
  feedRetentionLimit = normalizeRetentionLimit(limit)
  if (feedEvents.length > feedRetentionLimit) {
    feedEvents = feedEvents.slice(-feedRetentionLimit)
  }
  if (Array.isArray(pausedSnapshotEvents) && pausedSnapshotEvents.length > feedRetentionLimit) {
    pausedSnapshotEvents = pausedSnapshotEvents.slice(-feedRetentionLimit)
  }
  renderFeed()
  return feedRetentionLimit
}

function getFeedState() {
  const visibleEntries = getVisibleFeedEntries()
  return {
    totalReceived: evCnt,
    clearedAtCount: clearedAtCnt,
    retainedCount: feedEvents.length,
    visibleCount: visibleEntries.length,
    retentionLimit: feedRetentionLimit,
    paused: isFeedPaused,
    pausedBufferedCount,
    filter: activeFeedFilter,
  }
}

function resetFeedStateForTest() {
  evCnt = 0
  clearedAtCnt = 0
  feedRetentionLimit = DEFAULT_FEED_MAX_EVENTS
  feedEvents = []
  pausedSnapshotEvents = null
  isFeedPaused = false
  pausedBufferedCount = 0
  activeFeedFilter = 'all'
  nextFeedSeq = 1
  renderFeed()
}
