/**
 * Pages Module
 * Handles loading and rendering of individual pages
 */

const VALID_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])

const UNPRICED_PUBLIC_ENDPOINTS = [
  { method: 'POST', path: '/api/orchestrate', label: 'Free' },
  { method: 'GET', path: '/api/agents', label: 'Free' },
  { method: 'GET', path: '/api/wallet/balances', label: 'Free' },
  { method: 'GET', path: '/api/wallet/transactions', label: 'Free' },
  { method: 'GET', path: '/api/status', label: 'Free' },
  { method: 'GET', path: '/api/events', label: 'Free' },
]

function parsePricingMetadataEntry(item, defaultAsset = 'USDC') {
  if (!item || typeof item !== 'object') {
    return { valid: false, error: 'Pricing entry must be an object' }
  }

  let method = typeof item.method === 'string' ? item.method.trim().toUpperCase() : ''
  let routePath = typeof item.path === 'string' ? item.path.trim() : ''

  if ((!method || !routePath) && typeof item.endpoint === 'string' && item.endpoint.trim()) {
    const parts = item.endpoint.trim().split(/\s+/)
    if (parts.length >= 2) {
      if (!method) method = parts[0].toUpperCase()
      if (!routePath) routePath = parts.slice(1).join(' ')
    } else if (parts.length === 1 && parts[0].startsWith('/')) {
      if (!method) method = 'GET'
      if (!routePath) routePath = parts[0]
    }
  }

  if (!VALID_HTTP_METHODS.has(method) || !routePath.startsWith('/')) {
    return { valid: false, error: 'Invalid endpoint method or path' }
  }

  const rawPrice =
    typeof item.price === 'number' && Number.isFinite(item.price) && item.price > 0
      ? `$${item.price.toFixed(2)}`
      : typeof item.price === 'string'
        ? item.price.trim()
        : ''

  if (!rawPrice || !/^\$?\d+(\.\d+)?(\s+[A-Za-z]+)?$/.test(rawPrice)) {
    return { valid: false, error: `Invalid or missing price for ${method} ${routePath}` }
  }

  const numericCheck = Number.parseFloat(rawPrice.replace(/^\$/, ''))
  if (!Number.isFinite(numericCheck) || numericCheck <= 0) {
    return { valid: false, error: `Non-positive price for ${method} ${routePath}` }
  }

  const asset =
    typeof item.asset === 'string' && item.asset.trim()
      ? item.asset.trim().toUpperCase()
      : typeof item.currency === 'string' && item.currency.trim()
        ? item.currency.trim().toUpperCase()
        : String(defaultAsset || 'USDC').toUpperCase()

  const normalizedPrice = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`
  const hasAssetInPrice = new RegExp(`\\b${asset}\\b`, 'i').test(normalizedPrice)
  const priceWithAsset = hasAssetInPrice ? normalizedPrice : `${normalizedPrice} (${asset})`

  return {
    valid: true,
    method,
    path: routePath,
    price: normalizedPrice,
    asset,
    priceWithAsset,
    agent: item.agent || null,
    description: item.description || null,
    emoji: item.emoji || null,
  }
}

function normalizeStatusPricingMetadata(statusData) {
  const x4 = statusData && typeof statusData === 'object' ? statusData.x402 : null
  if (!x4 || typeof x4 !== 'object' || !Array.isArray(x4.pricing) || x4.pricing.length === 0) {
    return {
      available: false,
      reason: 'Pricing metadata is missing from /api/status',
      paymentAvailable: false,
      paymentStatus: 'unavailable',
      paymentLabel: 'Pricing Unavailable',
      premiumRows: [],
      malformedCount: 0,
    }
  }

  const defaultAsset = x4.settlementAsset || 'USDC'
  const validRows = []
  let malformedCount = 0

  for (const entry of x4.pricing) {
    const parsed = parsePricingMetadataEntry(entry, defaultAsset)
    if (parsed.valid) {
      validRows.push(parsed)
    } else {
      malformedCount += 1
    }
  }

  if (malformedCount > 0 || validRows.length === 0) {
    return {
      available: false,
      reason:
        malformedCount > 0
          ? `Malformed pricing metadata (${malformedCount} invalid entr${malformedCount === 1 ? 'y' : 'ies'})`
          : 'No valid premium endpoints configured',
      paymentAvailable: false,
      paymentStatus: 'unavailable',
      paymentLabel: 'Pricing Unavailable',
      premiumRows: validRows,
      malformedCount,
    }
  }

  const enabled = x4.enabled !== false
  const ready = x4.ready !== undefined ? Boolean(x4.ready) : enabled
  const paymentAvailable = Boolean(enabled && ready)
  const paymentStatus = paymentAvailable ? 'active' : enabled ? 'degraded' : 'disabled'
  const paymentLabel = paymentAvailable
    ? 'x402 Active'
    : enabled
      ? 'Paywall Not Ready'
      : 'Paywall Disabled'

  return {
    available: true,
    reason: null,
    paymentAvailable,
    paymentStatus,
    paymentLabel,
    premiumRows: validRows,
    malformedCount: 0,
  }
}

function renderStatusEndpointList(statusData) {
  const normalized = normalizeStatusPricingMetadata(statusData)

  let premiumSectionHtml = ''
  if (!normalized.available) {
    premiumSectionHtml = `
      <div class="ep-unavailable" data-pricing-state="unavailable" role="alert" style="padding:12px 14px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:var(--radius-sm);color:var(--red);font-size:11.5px;">
        ⚠️ Premium endpoint pricing unavailable: ${escapeHtml(normalized.reason)}
      </div>
    `
  } else {
    const payIcon = normalized.paymentAvailable ? '🔒' : '🔓'
    premiumSectionHtml = normalized.premiumRows
      .map(
        (row) => `
      <div class="ep-item ep-premium" data-endpoint-tier="premium" data-method="${escapeHtml(row.method)}" data-path="${escapeHtml(row.path)}" data-price="${escapeHtml(row.price)}" data-asset="${escapeHtml(row.asset)}" data-payment-status="${escapeHtml(normalized.paymentStatus)}">
        <span class="ep-method ${escapeHtml(row.method.toLowerCase())}">${escapeHtml(row.method)}</span>
        <span class="ep-path">${escapeHtml(row.path)}</span>
        <span class="ep-price" data-payment-available="${normalized.paymentAvailable}">${payIcon} ${escapeHtml(row.price)} · ${escapeHtml(row.asset)} · ${escapeHtml(normalized.paymentLabel)}</span>
      </div>
    `
      )
      .join('')
  }

  const publicSectionHtml = UNPRICED_PUBLIC_ENDPOINTS.map(
    (e) => `
      <div class="ep-item ep-public" data-endpoint-tier="public" data-method="${escapeHtml(e.method)}" data-path="${escapeHtml(e.path)}">
        <span class="ep-method ${escapeHtml(e.method.toLowerCase())}">${escapeHtml(e.method)}</span>
        <span class="ep-path">${escapeHtml(e.path)}</span>
        <span class="ep-free">${escapeHtml(e.label)}</span>
      </div>
    `
  ).join('')

  return {
    html: `${premiumSectionHtml}${publicSectionHtml}`,
    normalized,
  }
}

async function loadStatusPage() {
  try {
    const statusRes = await fetch('/api/status')
    if (!statusRes.ok) {
      throw new Error(`HTTP ${statusRes.status}`)
    }
    const s = await statusRes.json()
    let k = { configured: false, masked: null }
    try {
      const keyRes = await fetch('/api/config/apikey')
      if (keyRes.ok) k = await keyRes.json()
    } catch {}

    const statusGrid = document.getElementById('status-grid')
    if (statusGrid) {
      statusGrid.innerHTML = `
        <div class="status-card"><div class="sc-icon">🟢</div><div class="sc-label">System Status</div><div class="sc-value">${escapeHtml(s.status?.toUpperCase() || 'ONLINE')}</div><div class="sc-sub">StellarMind v${escapeHtml(s.version || '1.0.0')}</div></div>
        <div class="status-card"><div class="sc-icon">🌐</div><div class="sc-label">Network</div><div class="sc-value">${escapeHtml(s.network || 'unknown')}</div><div class="sc-sub">${escapeHtml(s.facilitator || '')}</div></div>
        <div class="status-card"><div class="sc-icon">🤖</div><div class="sc-label">Agents</div><div class="sc-value">${escapeHtml(String(s.agents ?? 0))}</div><div class="sc-sub">Claude ${s.claudeEnabled ? '✅ Connected' : '❌ Off'}</div></div>
      `
    }

    const tag = document.getElementById('key-status-tag')
    const hint = document.getElementById('key-hint')
    if (tag && hint) {
      if (k.configured) {
        tag.textContent = 'Active'
        tag.className = 'tag green'
        hint.textContent = `Current: ${k.masked}`
      } else {
        tag.textContent = 'Not Configured'
        tag.className = 'tag red'
        hint.textContent = 'Current: No key set (using fallbacks)'
      }
    }

    const { html, normalized } = renderStatusEndpointList(s)
    const epList = document.getElementById('endpoint-list')
    if (epList) {
      epList.innerHTML = html
    }
    const paywallTag = document.getElementById('endpoint-paywall-tag')
    if (paywallTag) {
      if (!normalized.available) {
        paywallTag.textContent = 'Pricing Unavailable'
        paywallTag.className = 'tag amber'
      } else if (normalized.paymentAvailable) {
        paywallTag.textContent = 'x402 Paywalled'
        paywallTag.className = 'tag green'
      } else {
        paywallTag.textContent = normalized.paymentLabel
        paywallTag.className = 'tag amber'
      }
    }

    const x4 = s.x402 || {}
    const x402Info = document.getElementById('x402-info')
    if (x402Info) {
      x402Info.innerHTML = `
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.8;">
          <p style="margin-bottom:10px;"><strong style="color:var(--text-primary);">Middleware:</strong> ${escapeHtml(x4.middleware || 'N/A')}</p>
          <p style="margin-bottom:10px;"><strong style="color:var(--text-primary);">Client:</strong> ${escapeHtml(x4.client || 'N/A')}</p>
          <p style="margin-bottom:10px;"><strong style="color:var(--text-primary);">Flow:</strong></p>
          <div style="background:var(--bg-card-alt);padding:12px 16px;border-radius:var(--radius-sm);font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.8;color:var(--accent-light);">
            1. Orchestrator → GET /api/premium/* → Server<br/>
            2. Server returns <span style="color:var(--amber);">402 Payment Required</span> (price, network, payTo)<br/>
            3. <span style="color:var(--purple);">wrapFetchWithPayment</span> auto-signs Stellar USDC tx<br/>
            4. Retries with <span style="color:var(--green);">X-PAYMENT</span> header<br/>
            5. Facilitator verifies → settles on-chain (~5s)<br/>
            6. Server returns <span style="color:var(--green);">200 OK</span> + Claude response
          </div>
        </div>
      `
    }
  } catch (err) {
    const epList = document.getElementById('endpoint-list')
    if (epList) {
      const { html } = renderStatusEndpointList(null)
      epList.innerHTML = html
    }
    const paywallTag = document.getElementById('endpoint-paywall-tag')
    if (paywallTag) {
      paywallTag.textContent = 'Pricing Unavailable'
      paywallTag.className = 'tag amber'
    }
  }
}

async function loadTxPage() {
  try {
    const response = await fetch('/api/wallet/transactions')
    const data = await response.json()

    // Handle error state
    if (!data.success) {
      const errorHtml = `
        <tr>
          <td colspan="5" style="text-align:center;padding:32px;">
            <div style="color:var(--red);margin-bottom:12px;font-size:16px;">
              ${getTransactionErrorIcon(data.errorType)} ${data.message || 'Failed to load transactions'}
            </div>
            ${
              data.retryable
                ? `
              <button onclick="loadTxPage()" style="padding:8px 16px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;">
                🔄 Retry
              </button>
              <div style="color:var(--text-muted);font-size:12px;margin-top:8px;">
                Error ID: ${data.correlationId || 'N/A'}
              </div>
            `
                : `
              <div style="color:var(--text-muted);font-size:12px;margin-top:8px;">
                ${data.errorType === 'ACCOUNT_NOT_FOUND' ? 'Run the wallet setup first to fund this account.' : ''}
              </div>
            `
            }
          </td>
        </tr>
      `
      document.getElementById('tx-body').innerHTML = errorHtml
      document.getElementById('tx-cnt').textContent = '0'
      document.getElementById('tx-total').textContent = '0 Transactions'
      return
    }

    const txs = data.transactions || []
    document.getElementById('tx-cnt').textContent = txs.length
    document.getElementById('tx-total').textContent =
      `${txs.length} Transaction${txs.length !== 1 ? 's' : ''}`

    if (!txs.length) {
      document.getElementById('tx-body').innerHTML =
        '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted);">✅ No transactions yet. This account is empty but valid.</td></tr>'
      return
    }

    document.getElementById('tx-body').innerHTML = txs
      .map((tx) => {
        const ops = tx.operations || []
        const op = ops[0] || {}
        let amt = '—'

        if (op.amount) {
          const num = Number.parseFloat(op.amount)
          amt = Number.isFinite(num)
            ? `${num.toFixed(2)} ${op.asset_code || 'XLM'}`
            : `${op.amount} ${op.asset_code || 'XLM'}`
        } else if (op.type === 'invoke_host_function') {
          amt = 'contract call'
        }

        const hash = tx.hash || tx.id || ''
        const url = `https://stellar.expert/explorer/testnet/tx/${hash}`
        const timeRaw = tx.created_at || tx.createdAt || null
        const time = timeRaw ? new Date(timeRaw).toLocaleString() : '—'
        const memoValue = tx.memo_type === 'none' ? 'none' : tx.memo || '—'
        const opType = op.type ? op.type.replaceAll('_', ' ') : '—'

        return `<tr>
          <td><a href="${url}" target="_blank" class="tx-hash">${hash.slice(0, 10)}...${hash.slice(-6)}</a></td>
          <td>${opType}</td>
          <td><span class="tx-amount">${amt}</span></td>
          <td><span class="tx-memo">${memoValue}</span></td>
          <td><span class="tx-time">${time}</span></td>
        </tr>`
      })
      .join('')
  } catch (err) {
    console.error('Failed to load transactions:', err)
    document.getElementById('tx-body').innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;padding:32px;">
          <div style="color:var(--red);margin-bottom:12px;">
            🌐 Network error: ${err.message}
          </div>
          <button onclick="loadTxPage()" style="padding:8px 16px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;">
            🔄 Retry
          </button>
        </td>
      </tr>
    `
  }
}

/**
 * Get icon for transaction error types
 */
function getTransactionErrorIcon(errorType) {
  const icons = {
    ACCOUNT_NOT_FOUND: '❌',
    TIMEOUT: '⏱️',
    NETWORK_ERROR: '🌐',
    UPSTREAM_ERROR: '⚠️',
  }
  return icons[errorType] || '⚠️'
}

async function saveApiKey() {
  const key = document.getElementById('api-key-input').value.trim()
  const btn = document.getElementById('btn-save-key')

  if (!key || !key.startsWith('sk-ant-')) {
    alert('Please enter a valid Anthropic API key starting with sk-ant-')
    return
  }

  btn.disabled = true
  btn.textContent = 'Saving...'

  try {
    const res = await fetch('/api/config/apikey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })

    const d = await res.json()
    if (d.success) {
      alert('API Key updated successfully! Agents will now use your key.')
      document.getElementById('api-key-input').value = ''
      loadStatusPage()
    } else {
      alert(`Error: ${d.error}`)
    }
  } catch (err) {
    alert(`Failed to save key: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = 'Update Key'
  }
}

async function loadHistoryPage() {
  const listEl = document.getElementById('history-list')
  const emptyEl = document.getElementById('history-empty')
  const loadingEl = document.getElementById('history-loading')
  const metaEl = document.getElementById('history-meta')
  const prevBtn = document.getElementById('history-prev')
  const nextBtn = document.getElementById('history-next')

  loadingEl.style.display = 'block'
  emptyEl.style.display = 'none'
  listEl.innerHTML = ''

  try {
    const params = new URLSearchParams()
    const statusFilter = document.getElementById('history-status-filter')?.value
    const limit = document.getElementById('history-limit')?.value || 20
    if (statusFilter) params.set('status', statusFilter)
    params.set('limit', limit)
    const res = await fetch(`/api/runs?${params.toString()}`)
    const data = await res.json()
    loadingEl.style.display = 'none'

    if (!data.runs || data.runs.length === 0) {
      emptyEl.style.display = 'block'
      metaEl.textContent = 'No runs found'
      prevBtn.disabled = true
      nextBtn.disabled = true
      return
    }

    metaEl.textContent = `Showing ${data.runs.length} run${data.runs.length !== 1 ? 's' : ''}`

    listEl.innerHTML = data.runs
      .map((run) => {
        const status = run.status || 'unknown'
        const statusClass = `status-${status}`
        const created = run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'
        const completed = run.completedAt ? new Date(run.completedAt).toLocaleString() : '—'
        const spent =
          run.totalSpent !== undefined && run.totalSpent !== null
            ? run.totalSpent
            : (run.summary?.totalSpent ?? '0')
        const budget =
          run.budget !== undefined && run.budget !== null
            ? run.budget
            : (run.summary?.budget ?? '—')
        const task = run.task || 'No task description'
        const taskShort = task.length > 100 ? task.slice(0, 97) + '...' : task
        return `
          <div class="history-item" tabindex="0" role="button" data-run-id="${escapeHtml(run.id)}" onclick="openRunDetail('${escapeHtml(run.id)}')" onkeydown="if(event.key==='Enter'||event.key===' ') {event.preventDefault(); openRunDetail('${escapeHtml(run.id)}');}">
            <div class="history-row">
              <div class="history-id"><code>${escapeHtml(run.id)}</code></div>
              <span class="history-status ${statusClass}">${escapeHtml(status)}</span>
            </div>
            <div class="history-task">${escapeHtml(taskShort)}</div>
            <div class="history-meta">
              <span>Created: ${escapeHtml(created)}</span>
              <span>Completed: ${escapeHtml(completed)}</span>
              <span>Spent: ${escapeHtml(spent)} / ${escapeHtml(budget)}</span>
            </div>
          </div>
        `
      })
      .join('')

    prevBtn.disabled = true // pagination not fully implemented in API yet; keep minimal
    nextBtn.disabled = true
  } catch (err) {
    loadingEl.style.display = 'none'
    emptyEl.style.display = 'block'
    emptyEl.innerHTML = '<div class="es-icon">❌</div><p>Failed to load run history</p>'
  }
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
