/**
 * Pages Module
 * Handles loading and rendering of individual pages
 */

/**
 * Convert an integer stroops value to an exact XLM decimal string (1 XLM = 10,000,000 stroops)
 * without rounding small values (such as 100 stroops = 0.00001 XLM) to zero (#161).
 */
function stroopsToXlmDisplay(stroops) {
  if (stroops === null || stroops === undefined || stroops === '') return null
  const s = String(stroops).trim()
  if (!/^\d+$/.test(s)) return null
  const units = BigInt(s)
  const scale = 10_000_000n
  const intPart = units / scale
  const fracPart = units % scale
  if (fracPart === 0n) return intPart.toString()
  const fracStr = fracPart.toString().padStart(7, '0').replace(/0+$/, '')
  return `${intPart}.${fracStr}`
}

/**
 * Format an XLM decimal string or number while preserving up to 7 fractional
 * decimal places so small XLM amounts and fees never round to `0.00`.
 */
function formatXlmAmount(value, options = {}) {
  const minDecimals = options.minDecimals ?? 0
  const maxDecimals = options.maxDecimals ?? 7
  const includeAsset = options.includeAsset !== false
  const asset = options.asset || 'XLM'

  if (value === null || value === undefined || value === '') return '—'

  let raw = String(value).trim()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    raw = value.toFixed(maxDecimals)
  } else if (/e/i.test(raw)) {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return `${raw}${includeAsset ? ` ${asset}` : ''}`
    raw = parsed.toFixed(maxDecimals)
  }

  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/)
  if (!match) {
    return includeAsset ? `${raw} ${asset}` : raw
  }

  const sign = match[1] === '-' ? '-' : ''
  const intPart = match[2]
  const fracRaw = (match[3] || '').slice(0, maxDecimals)
  const trimmedFrac = fracRaw.replace(/0+$/, '')
  const finalFrac =
    trimmedFrac.length >= minDecimals ? trimmedFrac : trimmedFrac.padEnd(minDecimals, '0')

  const formatted = finalFrac.length > 0 ? `${sign}${intPart}.${finalFrac}` : `${sign}${intPart}`
  return includeAsset ? `${formatted} ${asset}` : formatted
}

/**
 * Format a transaction or receipt network fee explicitly separating confirmed,
 * pending, and unknown fee states (#161).
 */
function formatNetworkFee(txOrFee) {
  if (!txOrFee || typeof txOrFee !== 'object') return 'unknown'
  const fee =
    txOrFee.networkFee && typeof txOrFee.networkFee === 'object' ? txOrFee.networkFee : txOrFee
  const status = fee.status || txOrFee.feeStatus || (txOrFee.pending ? 'pending' : null)

  if (status === 'not_applicable') return 'none'
  if (status === 'pending') return 'pending'
  if (status === 'unknown') return 'unknown'

  const stroopsCandidate =
    fee.stroops ?? txOrFee.feeChargedStroops ?? txOrFee.feeCharged ?? txOrFee.fee_charged ?? null

  if (
    stroopsCandidate !== null &&
    stroopsCandidate !== undefined &&
    /^\d+$/.test(String(stroopsCandidate).trim())
  ) {
    const stroopsStr = String(stroopsCandidate).trim()
    const xlmStr = fee.amount || txOrFee.feeChargedXlm || stroopsToXlmDisplay(stroopsStr)
    return `${formatXlmAmount(xlmStr, { minDecimals: 0, maxDecimals: 7, includeAsset: true })} (${stroopsStr} stroops)`
  }

  const xlmCandidate = fee.amount ?? txOrFee.feeChargedXlm ?? txOrFee.feeXlm ?? null
  if (xlmCandidate !== null && xlmCandidate !== undefined && String(xlmCandidate).trim() !== '') {
    return formatXlmAmount(xlmCandidate, { minDecimals: 0, maxDecimals: 7, includeAsset: true })
  }

  return 'unknown'
}

async function loadStatusPage() {
  try {
    const s = await (await fetch('/api/status')).json()
    const k = await (await fetch('/api/config/apikey')).json()

    document.getElementById('status-grid').innerHTML = `
      <div class="status-card"><div class="sc-icon">🟢</div><div class="sc-label">System Status</div><div class="sc-value">${s.status?.toUpperCase()}</div><div class="sc-sub">StellarMind v${s.version}</div></div>
      <div class="status-card"><div class="sc-icon">🌐</div><div class="sc-label">Network</div><div class="sc-value">${s.network}</div><div class="sc-sub">${s.facilitator}</div></div>
      <div class="status-card"><div class="sc-icon">🤖</div><div class="sc-label">Agents</div><div class="sc-value">${s.agents}</div><div class="sc-sub">Claude ${s.claudeEnabled ? '✅ Connected' : '❌ Off'}</div></div>
    `

    const tag = document.getElementById('key-status-tag')
    const hint = document.getElementById('key-hint')
    if (k.configured) {
      tag.textContent = 'Active'
      tag.className = 'tag green'
      hint.textContent = `Current: ${k.masked}`
    } else {
      tag.textContent = 'Not Configured'
      tag.className = 'tag red'
      hint.textContent = 'Current: No key set (using fallbacks)'
    }

    const eps = [
      { m: 'GET', p: '/api/premium/research', pr: '$0.01', pw: true },
      { m: 'GET', p: '/api/premium/summarize', pr: '$0.01', pw: true },
      { m: 'GET', p: '/api/premium/analyze', pr: '$0.05', pw: true },
      { m: 'GET', p: '/api/premium/code', pr: '$0.03', pw: true },
      { m: 'POST', p: '/api/orchestrate', pr: '', pw: false },
      { m: 'GET', p: '/api/agents', pr: '', pw: false },
      { m: 'GET', p: '/api/wallet/balances', pr: '', pw: false },
      { m: 'GET', p: '/api/wallet/transactions', pr: '', pw: false },
      { m: 'GET', p: '/api/status', pr: '', pw: false },
      { m: 'GET', p: '/api/events', pr: '', pw: false },
    ]

    document.getElementById('endpoint-list').innerHTML = eps
      .map(
        (e) => `
      <div class="ep-item">
        <span class="ep-method ${e.m.toLowerCase()}">${e.m}</span>
        <span class="ep-path">${e.p}</span>
        ${e.pw ? `<span class="ep-price">🔒 ${e.pr}</span>` : '<span class="ep-free">Free</span>'}
      </div>
    `
      )
      .join('')

    const x4 = s.x402 || {}
    document.getElementById('x402-info').innerHTML = `
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.8;">
        <p style="margin-bottom:10px;"><strong style="color:var(--text-primary);">Middleware:</strong> ${x4.middleware || 'N/A'}</p>
        <p style="margin-bottom:10px;"><strong style="color:var(--text-primary);">Client:</strong> ${x4.client || 'N/A'}</p>
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
  } catch {}
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
          const assetCode = op.asset_code || 'XLM'
          amt = formatXlmAmount(op.amount, {
            minDecimals: 2,
            maxDecimals: 7,
            includeAsset: true,
            asset: assetCode,
          })
        } else if (op.type === 'invoke_host_function') {
          amt = 'contract call'
        }

        const feeDisplay = formatNetworkFee(tx)
        const hash = tx.hash || tx.id || ''
        const url = `https://stellar.expert/explorer/testnet/tx/${hash}`
        const timeRaw = tx.created_at || tx.createdAt || null
        const time = timeRaw ? new Date(timeRaw).toLocaleString() : '—'
        const memoValue = tx.memo_type === 'none' ? 'none' : tx.memo || '—'
        const opType = op.type ? op.type.replaceAll('_', ' ') : '—'

        return `<tr>
          <td><a href="${url}" target="_blank" class="tx-hash">${hash.slice(0, 10)}...${hash.slice(-6)}</a></td>
          <td>${opType}</td>
          <td><span class="tx-amount">${amt}</span><div class="tx-fee" style="font-size:10px;color:var(--text-muted);">Network fee: ${feeDisplay}</div></td>
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
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
