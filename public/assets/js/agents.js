/**
 * Agents Module
 * Handles agent registry loading, search, filtering, price sorting, and selection state
 */

const AGENT_PRICE_DECIMALS = 7
const DEFAULT_AGENT_CONTROLS = {
  query: '',
  status: 'all',
  capability: 'all',
  sort: 'default',
}

let agentCatalog = []
let selectedAgentId = null
let agentCatalogControls = { ...DEFAULT_AGENT_CONTROLS }

function escapeAgentHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Parse a decimal price string or number into exact 7-decimal-place BigInt units
 * so price sorting compares normalized numeric amounts rather than display strings.
 */
function parseNormalizedPriceUnits(priceRaw) {
  const cleaned = String(priceRaw ?? '0')
    .trim()
    .replace(/^\$/, '')
    .replace(/,/g, '')

  const match = cleaned.match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) {
    const fallback = Number.parseFloat(cleaned)
    if (!Number.isFinite(fallback) || fallback < 0) return 0n
    const fixed = fallback.toFixed(AGENT_PRICE_DECIMALS)
    const [w, f = ''] = fixed.split('.')
    return (
      BigInt(w) * 10n ** BigInt(AGENT_PRICE_DECIMALS) +
      BigInt(f.padEnd(AGENT_PRICE_DECIMALS, '0').slice(0, AGENT_PRICE_DECIMALS))
    )
  }

  const whole = BigInt(match[1])
  const fracRaw = (match[2] || '').slice(0, AGENT_PRICE_DECIMALS).padEnd(AGENT_PRICE_DECIMALS, '0')
  const frac = BigInt(fracRaw || '0')
  return whole * 10n ** BigInt(AGENT_PRICE_DECIMALS) + frac
}

function stripLeadingSymbols(text) {
  return String(text || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
}

/**
 * Compare two agents by normalized numeric price within an asset.
 * Agents with different assets are grouped deterministically by asset code (USDC first),
 * then ordered by exact numeric price within the same asset.
 */
function compareAgentsByPrice(a, b, direction = 'asc') {
  const assetA = String(a?.currency || 'USDC')
    .trim()
    .toUpperCase()
  const assetB = String(b?.currency || 'USDC')
    .trim()
    .toUpperCase()

  if (assetA !== assetB) {
    if (assetA === 'USDC') return -1
    if (assetB === 'USDC') return 1
    return assetA.localeCompare(assetB)
  }

  const unitsA = parseNormalizedPriceUnits(a?.price)
  const unitsB = parseNormalizedPriceUnits(b?.price)

  if (unitsA !== unitsB) {
    const cmp = unitsA < unitsB ? -1 : 1
    return direction === 'desc' ? -cmp : cmp
  }

  const nameCmp = stripLeadingSymbols(a?.name).localeCompare(stripLeadingSymbols(b?.name))
  if (nameCmp !== 0) return nameCmp
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function getAgentCapabilityLabel(agent) {
  if (!agent || typeof agent !== 'object') return ''
  if (typeof agent.category === 'string' && agent.category.trim()) {
    return agent.category.trim()
  }
  if (Array.isArray(agent.capabilities) && agent.capabilities.length > 0) {
    return String(agent.capabilities[0]).trim()
  }
  const cap = String(agent.capability || '').trim()
  if (!cap) return ''
  const lower = cap.toLowerCase()
  if (lower.includes('research')) return 'Research'
  if (lower.includes('summar')) return 'Summarization'
  if (lower.includes('analy')) return 'Analysis'
  if (lower.includes('code') || lower.includes('debug')) return 'Code'
  if (lower.includes('translat')) return 'Translation'
  if (lower.includes('security') || lower.includes('audit')) return 'Security'
  if (lower.includes('data')) return 'Data'
  return cap
}

function extractCapabilityOptions(catalog = agentCatalog) {
  const seen = new Map()
  for (const agent of Array.isArray(catalog) ? catalog : []) {
    const labels = []
    const primary = getAgentCapabilityLabel(agent)
    if (primary) labels.push(primary)
    if (Array.isArray(agent?.capabilities)) {
      for (const c of agent.capabilities) {
        if (typeof c === 'string' && c.trim()) labels.push(c.trim())
      }
    }
    for (const label of labels) {
      const key = label.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, label)
      }
    }
  }
  return Array.from(seen.entries()).map(([value, label]) => ({ value, label }))
}

function filterAndSortAgents(catalog = agentCatalog, controls = agentCatalogControls) {
  const list = Array.isArray(catalog) ? catalog : []
  const query = String(controls?.query || '')
    .trim()
    .toLowerCase()
  const statusFilter = String(controls?.status || 'all')
    .trim()
    .toLowerCase()
  const capabilityFilter = String(controls?.capability || 'all')
    .trim()
    .toLowerCase()
  const sortMode = String(controls?.sort || 'default')
    .trim()
    .toLowerCase()

  const queryTokens = query ? query.split(/\s+/).filter(Boolean) : []

  const filtered = list.filter((agent) => {
    if (!agent || typeof agent !== 'object') return false
    const agentStatus = String(agent.status || 'online')
      .trim()
      .toLowerCase()
    if (statusFilter && statusFilter !== 'all' && agentStatus !== statusFilter) {
      return false
    }

    if (capabilityFilter && capabilityFilter !== 'all') {
      const primaryCap = getAgentCapabilityLabel(agent).toLowerCase()
      const capFields = [
        primaryCap,
        agent.capability || '',
        agent.category || '',
        Array.isArray(agent.capabilities) ? agent.capabilities.join(' ') : '',
      ]
        .join(' ')
        .toLowerCase()
      if (!capFields.includes(capabilityFilter)) {
        return false
      }
    }

    if (queryTokens.length > 0) {
      const searchable = [
        agent.id || '',
        agent.name || '',
        agent.capability || '',
        agent.description || '',
        agent.model || '',
        agent.endpoint || '',
        agent.category || '',
        getAgentCapabilityLabel(agent),
        Array.isArray(agent.capabilities) ? agent.capabilities.join(' ') : '',
      ]
        .join(' ')
        .toLowerCase()
      for (const token of queryTokens) {
        if (!searchable.includes(token)) return false
      }
    }

    return true
  })

  const sorted = [...filtered]
  if (sortMode === 'price-asc') {
    sorted.sort((a, b) => compareAgentsByPrice(a, b, 'asc'))
  } else if (sortMode === 'price-desc') {
    sorted.sort((a, b) => compareAgentsByPrice(a, b, 'desc'))
  } else if (sortMode === 'name-asc') {
    sorted.sort((a, b) => {
      const cmp = stripLeadingSymbols(a.name).localeCompare(stripLeadingSymbols(b.name))
      return cmp !== 0 ? cmp : String(a.id || '').localeCompare(String(b.id || ''))
    })
  }

  return sorted
}

function syncAgentControlElements() {
  const searchEl = document.getElementById('agent-search-input')
  if (searchEl && searchEl.value !== agentCatalogControls.query) {
    searchEl.value = agentCatalogControls.query
  }
  const statusEl = document.getElementById('agent-status-filter')
  if (statusEl && statusEl.value !== agentCatalogControls.status) {
    statusEl.value = agentCatalogControls.status
  }
  const capEl = document.getElementById('agent-capability-filter')
  if (capEl) {
    const options = extractCapabilityOptions(agentCatalog)
    const optionHtml = [
      '<option value="all">All Capabilities</option>',
      ...options.map(
        (opt) =>
          `<option value="${escapeAgentHtml(opt.value)}"${opt.value === agentCatalogControls.capability ? ' selected' : ''}>${escapeAgentHtml(opt.label)}</option>`
      ),
    ].join('')
    capEl.innerHTML = optionHtml
    capEl.value = agentCatalogControls.capability
  }
  const sortEl = document.getElementById('agent-sort-select')
  if (sortEl && sortEl.value !== agentCatalogControls.sort) {
    sortEl.value = agentCatalogControls.sort
  }
}

function getStatusBadgeInfo(statusRaw) {
  const status = String(statusRaw || 'online')
    .trim()
    .toLowerCase()
  if (status === 'offline') {
    return { dotClass: 'dot-off', label: 'Offline', statusKey: 'offline' }
  }
  if (status === 'degraded' || status === 'busy') {
    return {
      dotClass: 'dot-warn',
      label: status === 'busy' ? 'Busy' : 'Degraded',
      statusKey: status,
    }
  }
  return { dotClass: 'dot-on', label: 'Online', statusKey: 'online' }
}

function renderSidebarAgents(agents = agentCatalog) {
  const navCnt = document.getElementById('nav-cnt')
  if (navCnt) {
    navCnt.textContent = String(agents.length)
  }
  const sbAgents = document.getElementById('sb-agents')
  if (!sbAgents) return

  sbAgents.innerHTML = agents
    .map((a) => {
      const isSelected = selectedAgentId === a.id
      const badge = getStatusBadgeInfo(a.status)
      return `
      <div class="sb-agent${isSelected ? ' selected' : ''}" id="agent-${escapeAgentHtml(a.id)}" data-agent-id="${escapeAgentHtml(a.id)}" role="button" tabindex="0" aria-pressed="${isSelected ? 'true' : 'false'}" onclick="selectAgent('${escapeAgentHtml(a.id)}')" onkeydown="handleAgentCardKeydown(event, '${escapeAgentHtml(a.id)}')">
        <span class="${badge.dotClass}"></span>
        <div class="sb-agent-info">
          <div class="sb-agent-name">${escapeAgentHtml(a.name)}</div>
          <div class="sb-agent-price">${escapeAgentHtml(a.price)} ${escapeAgentHtml(a.currency || 'USDC')}</div>
        </div>
      </div>
    `
    })
    .join('')
}

function renderAgentCatalog() {
  syncAgentControlElements()
  const visibleAgents = filterAndSortAgents(agentCatalog, agentCatalogControls)
  const totalCount = agentCatalog.length
  const visibleCount = visibleAgents.length

  const metaEl = document.getElementById('agent-results-meta')
  const selectedAgent = agentCatalog.find((a) => a.id === selectedAgentId) || null
  if (metaEl) {
    const selectionSuffix = selectedAgent
      ? ` · Selected: ${stripLeadingSymbols(selectedAgent.name) || selectedAgent.id}`
      : ''
    metaEl.textContent = `Showing ${visibleCount} of ${totalCount} agent${totalCount === 1 ? '' : 's'}${selectionSuffix}`
  }

  const selectionEl = document.getElementById('agent-selection-status')
  if (selectionEl) {
    if (selectedAgent) {
      const inView = visibleAgents.some((a) => a.id === selectedAgent.id)
      selectionEl.textContent = `Selected agent: ${selectedAgent.name}${inView ? '' : ' (preserved while hidden by current filters)'}`
      selectionEl.dataset.selectedAgentId = selectedAgent.id
    } else {
      selectionEl.textContent = 'No agent selected'
      selectionEl.dataset.selectedAgentId = ''
    }
  }

  const cardsEl = document.getElementById('agent-cards')
  if (!cardsEl) return visibleAgents

  if (visibleCount === 0) {
    cardsEl.innerHTML = `
      <div class="empty-state agent-empty-state" data-empty-state="no-match" role="status" aria-live="polite" style="grid-column: 1 / -1;">
        <div class="es-icon">🔍</div>
        <p>No agents match the active search or filter criteria.</p>
        <button type="button" class="btn agent-reset-action" id="agent-empty-reset-btn" onclick="resetAgentCatalogControls()" aria-label="Reset agent catalog search and filters">
          Reset Filters
        </button>
      </div>
    `
    return visibleAgents
  }

  cardsEl.innerHTML = visibleAgents
    .map((a) => {
      const isSelected = selectedAgentId === a.id
      const badge = getStatusBadgeInfo(a.status)
      const capLabel = getAgentCapabilityLabel(a)
      return `
      <div class="ac${isSelected ? ' selected' : ''}" id="agent-card-${escapeAgentHtml(a.id)}" data-agent-id="${escapeAgentHtml(a.id)}" data-agent-price="${escapeAgentHtml(a.price)}" data-agent-currency="${escapeAgentHtml(a.currency || 'USDC')}" data-agent-status="${escapeAgentHtml(badge.statusKey)}" data-agent-capability="${escapeAgentHtml(capLabel.toLowerCase())}" role="button" tabindex="0" aria-pressed="${isSelected ? 'true' : 'false'}" aria-label="${escapeAgentHtml(stripLeadingSymbols(a.name) || a.id)} (${escapeAgentHtml(a.price)} ${escapeAgentHtml(a.currency || 'USDC')}, ${escapeAgentHtml(badge.label)})" onclick="selectAgent('${escapeAgentHtml(a.id)}')" onkeydown="handleAgentCardKeydown(event, '${escapeAgentHtml(a.id)}')">
        <div class="ac-head">
          <div class="ac-name">${escapeAgentHtml(a.name)}</div>
          <div class="ac-status status-${escapeAgentHtml(badge.statusKey)}"><span class="${badge.dotClass}"></span> ${escapeAgentHtml(badge.label)}</div>
        </div>
        <div class="ac-desc">${escapeAgentHtml(a.description || a.capability || '')}</div>
        ${a.description && a.capability ? `<div class="ac-cap" style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">Capability: ${escapeAgentHtml(a.capability)}</div>` : ''}
        <div class="ac-meta">
          <span class="ac-tag price">💰 ${escapeAgentHtml(a.price)} ${escapeAgentHtml(a.currency || 'USDC')}</span>
          <span class="ac-tag model">🤖 ${escapeAgentHtml(a.model || 'Claude')}</span>
          <span class="ac-tag endpoint">🔌 ${escapeAgentHtml(a.endpoint || '')}</span>
          ${capLabel ? `<span class="ac-tag capability">🏷️ ${escapeAgentHtml(capLabel)}</span>` : ''}
          ${isSelected ? '<span class="ac-tag selected-badge" data-selected-badge="true">✓ Selected</span>' : ''}
        </div>
      </div>
    `
    })
    .join('')

  return visibleAgents
}

function setAgentCatalog(agents) {
  agentCatalog = Array.isArray(agents) ? [...agents] : []
  renderSidebarAgents(agentCatalog)
  return renderAgentCatalog()
}

function setAgentCatalogControls(partial = {}) {
  agentCatalogControls = {
    ...agentCatalogControls,
    ...partial,
  }
  return renderAgentCatalog()
}

function resetAgentCatalogControls() {
  agentCatalogControls = { ...DEFAULT_AGENT_CONTROLS }
  return renderAgentCatalog()
}

function selectAgent(agentId) {
  if (!agentId) {
    selectedAgentId = null
  } else {
    selectedAgentId = selectedAgentId === agentId ? null : agentId
  }
  renderSidebarAgents(agentCatalog)
  renderAgentCatalog()
  return selectedAgentId
}

function getSelectedAgentId() {
  return selectedAgentId
}

function getAgentCatalogControls() {
  return { ...agentCatalogControls }
}

function handleAgentCardKeydown(event, agentId) {
  if (!event) return
  if (event.key === 'Enter' || event.key === ' ') {
    if (typeof event.preventDefault === 'function') event.preventDefault()
    selectAgent(agentId)
  }
}

async function loadAgents() {
  try {
    const agents = await (await fetch('/api/agents')).json()
    setAgentCatalog(agents)
  } catch {}
}

async function loadAgentPage() {
  try {
    const agents = await (await fetch('/api/agents')).json()
    setAgentCatalog(agents)
  } catch {}
}

function highlightAgent(id) {
  const c = document.getElementById(`agent-${id}`)
  if (c) {
    c.querySelector('.dot-on')?.classList.add('pulse')
    setTimeout(() => c.querySelector('.dot-on')?.classList.remove('pulse'), 3000)
  }
}
