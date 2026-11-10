/**
 * Pages Module
 * Handles loading and rendering of individual pages
 */

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

const txListCache = new Map()
const txDetailState = new Map()
let txWalletAddress = null

function resolveTxOperationDirection(op, accountAddress = txWalletAddress) {
  if (!op || typeof op !== 'object') return 'unknown'
  if (typeof op.direction === 'string' && op.direction !== 'unknown') {
    return op.direction
  }
  const normalizedAccount =
    typeof accountAddress === 'string' && accountAddress.trim() ? accountAddress.trim() : null
  const from = op.from || op.funder || op.source_account || null
  const to = op.to || op.into || op.account || null

  if (!normalizedAccount) {
    if (from && to) return from === to ? 'self' : 'transfer'
    return 'non_transfer'
  }
  const isFrom = from === normalizedAccount
  const isTo = to === normalizedAccount
  if (isFrom && isTo) return 'self'
  if (isTo) return 'incoming'
  if (isFrom) return 'outgoing'
  return 'non_transfer'
}

function deduplicateTxOperations(operations = []) {
  const seen = new Set()
  const result = []
  for (const op of operations) {
    if (!op || typeof op !== 'object') continue
    const key =
      op.id !== undefined && op.id !== null
        ? `id:${String(op.id)}`
        : op.paging_token !== undefined && op.paging_token !== null
          ? `cursor:${String(op.paging_token)}`
          : null
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    result.push(op)
  }
  return result
}

function summarizeTxRow(tx, walletAddress = txWalletAddress) {
  const rawOps = Array.isArray(tx?.operations) ? tx.operations : []
  const ops = deduplicateTxOperations(rawOps)
  const loadedOperationCount = Number.isFinite(Number(tx?.loadedOperationCount))
    ? Number(tx.loadedOperationCount)
    : ops.length
  const totalOperationCount = Number.isFinite(Number(tx?.operation_count))
    ? Number(tx.operation_count)
    : Number.isFinite(Number(tx?.operationSummary?.operationCount))
      ? Number(tx.operationSummary.operationCount)
      : loadedOperationCount

  const operationsComplete =
    typeof tx?.operationsComplete === 'boolean'
      ? tx.operationsComplete
      : tx?.operationsError
        ? false
        : loadedOperationCount >= totalOperationCount

  const operationsTruncated =
    typeof tx?.operationsTruncated === 'boolean'
      ? tx.operationsTruncated
      : !tx?.operationsError && loadedOperationCount < totalOperationCount

  const hasMoreOperations = Boolean(
    tx?.hasMoreOperations || operationsTruncated || tx?.nextOperationsCursor
  )
  const successful = tx?.successful !== false
  const statusLabel = successful ? 'Succeeded' : 'Failed'

  const assets = []
  const types = []
  const directions = new Set()

  if (Array.isArray(tx?.operationSummary?.assets)) {
    for (const a of tx.operationSummary.assets) {
      if (a && !assets.includes(a)) assets.push(a)
    }
  }
  if (Array.isArray(tx?.operationSummary?.types)) {
    for (const t of tx.operationSummary.types) {
      if (t && !types.includes(t)) types.push(t)
    }
  }

  for (const op of ops) {
    const assetCode =
      op.asset_code || (op.asset_type === 'native' ? 'XLM' : null) || op.asset || null
    if (assetCode && !assets.includes(assetCode)) {
      assets.push(assetCode)
    }
    if (op.type && !types.includes(op.type)) {
      types.push(op.type)
    }
    const dir = resolveTxOperationDirection(op, walletAddress)
    if (dir && dir !== 'unknown') {
      directions.add(dir)
    }
  }

  let direction = tx?.operationSummary?.direction || 'none'
  if (directions.size === 1) {
    direction = Array.from(directions)[0]
  } else if (directions.size > 1) {
    direction = 'mixed'
  } else if (totalOperationCount === 0) {
    direction = 'none'
  }

  let typeLabel = '—'
  let amountLabel = '—'
  let countBadge = `${totalOperationCount} op${totalOperationCount === 1 ? '' : 's'}`

  if (totalOperationCount === 0 && ops.length === 0) {
    typeLabel = 'no operations (0 ops)'
    amountLabel = 'No operations (0 ops)'
    countBadge = '0 ops'
  } else if (totalOperationCount === 1 && ops.length === 1 && operationsComplete) {
    const op = ops[0]
    const rawType = op.type ? op.type.replaceAll('_', ' ') : 'operation'
    typeLabel =
      direction && direction !== 'none' && direction !== 'unknown'
        ? `${rawType} (${direction})`
        : rawType

    if (op.amount !== undefined && op.amount !== null) {
      const num = Number.parseFloat(op.amount)
      const assetCode = op.asset_code || (op.asset_type === 'native' ? 'XLM' : 'XLM')
      amountLabel = Number.isFinite(num)
        ? `${num.toFixed(2)} ${assetCode}`
        : `${op.amount} ${assetCode}`
    } else if (op.type === 'invoke_host_function') {
      amountLabel = 'contract call'
    } else {
      amountLabel = rawType
    }
    countBadge = '1 op'
  } else {
    const readableTypes = types.map((t) => t.replaceAll('_', ' '))
    const baseTypeSummary =
      readableTypes.length === 1
        ? `${readableTypes[0]} (${totalOperationCount} ops)`
        : readableTypes.length > 1
          ? `multi-op (${totalOperationCount} ops: ${readableTypes.slice(0, 2).join(', ')}${readableTypes.length > 2 ? ', …' : ''})`
          : `multi-op (${totalOperationCount} ops)`

    typeLabel = operationsComplete
      ? baseTypeSummary
      : `${baseTypeSummary} · incomplete (${loadedOperationCount}/${totalOperationCount} loaded)`

    const assetLabel = assets.length > 0 ? assets.join(', ') : 'non-transfer'
    amountLabel = operationsComplete
      ? `Multi-op (${totalOperationCount} ops · ${assetLabel})`
      : `Multi-op (${loadedOperationCount} of ${totalOperationCount} ops loaded · ${assetLabel})`

    countBadge = operationsComplete
      ? `${totalOperationCount} ops`
      : `${loadedOperationCount}/${totalOperationCount} ops (incomplete)`
  }

  return {
    hash: tx?.hash || tx?.id || '',
    successful,
    statusLabel,
    totalOperationCount,
    loadedOperationCount,
    operationsComplete,
    operationsTruncated,
    hasMoreOperations,
    direction,
    assets,
    assetLabel: assets.length > 0 ? assets.join(', ') : '—',
    typeLabel,
    amountLabel,
    countBadge,
    nextCursor:
      tx?.nextOperationsCursor ||
      tx?.operationsPagination?.nextCursor ||
      (ops.length > 0 ? ops[ops.length - 1].paging_token || ops[ops.length - 1].id || null : null),
    continuationUrl:
      tx?.operationsContinuationUrl || tx?.operationsPagination?.continuationUrl || null,
  }
}

async function loadTxPage() {
  try {
    const response = await fetch('/api/wallet/transactions')
    const data = await response.json()

    // Handle error state
    if (data && !Array.isArray(data) && data.success === false) {
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

    const txs = Array.isArray(data) ? data : data.transactions || []
    if (data && typeof data.address === 'string') {
      txWalletAddress = data.address
    }

    document.getElementById('tx-cnt').textContent = txs.length
    document.getElementById('tx-total').textContent =
      `${txs.length} Transaction${txs.length !== 1 ? 's' : ''}`

    if (!txs.length) {
      document.getElementById('tx-body').innerHTML =
        '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted);">✅ No transactions yet. This account is empty but valid.</td></tr>'
      return
    }

    txListCache.clear()
    for (const tx of txs) {
      const hash = tx.hash || tx.id || ''
      if (hash) txListCache.set(hash, tx)
    }

    document.getElementById('tx-body').innerHTML = txs
      .map((tx) => {
        const summary = summarizeTxRow(tx, txWalletAddress)
        const hash = summary.hash
        const shortHash =
          hash.length > 16 ? `${hash.slice(0, 10)}...${hash.slice(-6)}` : hash || '—'
        const url = `https://stellar.expert/explorer/testnet/tx/${hash}`
        const timeRaw = tx.created_at || tx.createdAt || null
        const time = timeRaw ? new Date(timeRaw).toLocaleString() : '—'
        const memoValue = tx.memo_type === 'none' ? 'none' : tx.memo || '—'
        const statusClass = summary.successful ? 'tag green' : 'tag red'
        const completenessClass = summary.operationsComplete ? 'tag' : 'tag amber'
        const directionBadge =
          summary.direction && summary.direction !== 'none'
            ? `<span class="tag tx-direction" data-direction="${escapeHtml(summary.direction)}" style="margin-left:6px;">${escapeHtml(summary.direction)}</span>`
            : ''
        const detailAction =
          summary.totalOperationCount > 1 || !summary.operationsComplete
            ? `<button type="button" class="btn-tx-detail" onclick="openTxDetail('${escapeHtml(hash)}')" style="margin-left:8px;padding:2px 8px;font-size:10px;background:var(--bg-card-alt);color:var(--accent-light);border:1px solid var(--border);border-radius:4px;cursor:pointer;">${summary.operationsComplete ? `Inspect ${summary.totalOperationCount} ops` : `Load all ${summary.totalOperationCount} ops`}</button>`
            : `<button type="button" class="btn-tx-detail" onclick="openTxDetail('${escapeHtml(hash)}')" style="margin-left:8px;padding:2px 6px;font-size:10px;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;cursor:pointer;">Details</button>`

        return `<tr data-tx-hash="${escapeHtml(hash)}" data-ops-complete="${summary.operationsComplete}" data-op-count="${summary.totalOperationCount}" data-tx-successful="${summary.successful}">
          <td>
            <a href="${url}" target="_blank" class="tx-hash">${escapeHtml(shortHash)}</a>
            <span class="${statusClass} tx-status-badge" data-tx-status="${summary.successful ? 'succeeded' : 'failed'}" style="margin-left:6px;">${escapeHtml(summary.statusLabel)}</span>
            <span class="${completenessClass} tx-op-count-badge" style="margin-left:4px;">${escapeHtml(summary.countBadge)}</span>
          </td>
          <td><span class="tx-type">${escapeHtml(summary.typeLabel)}</span>${directionBadge}</td>
          <td><span class="tx-amount">${escapeHtml(summary.amountLabel)}</span>${detailAction}</td>
          <td><span class="tx-memo">${escapeHtml(memoValue)}</span></td>
          <td><span class="tx-time">${escapeHtml(time)}</span></td>
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

function renderTxDetailModal(hash) {
  const state = txDetailState.get(hash)
  if (!state) return null

  const summary = summarizeTxRow(state, txWalletAddress)
  const modal = document.getElementById('tx-detail-modal')
  const metaEl = document.getElementById('tx-detail-meta')
  const opsEl = document.getElementById('tx-detail-ops')
  const actionsEl = document.getElementById('tx-detail-actions')

  const opsRowsHtml =
    state.operations.length === 0
      ? '<div class="tx-detail-empty" style="padding:16px;color:var(--text-muted);">No operations in this transaction (0 ops).</div>'
      : state.operations
          .map((op, idx) => {
            const opType = (op.type || 'operation').replaceAll('_', ' ')
            const asset = op.asset_code || (op.asset_type === 'native' ? 'XLM' : '—')
            const amount =
              op.amount !== undefined && op.amount !== null ? `${op.amount} ${asset}` : '—'
            const direction = resolveTxOperationDirection(op, txWalletAddress)
            const opId = op.id || op.paging_token || `op-${idx + 1}`
            return `<div class="tx-detail-op-row" data-op-id="${escapeHtml(String(opId))}" style="display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:12px;">
              <span><strong>#${idx + 1}</strong> <code>${escapeHtml(String(opId))}</code> · ${escapeHtml(opType)}</span>
              <span>Direction: <strong>${escapeHtml(direction)}</strong></span>
              <span>Asset: <strong>${escapeHtml(asset)}</strong></span>
              <span>Amount: <strong>${escapeHtml(amount)}</strong></span>
            </div>`
          })
          .join('')

  const metaHtml = `
    <div class="tx-detail-summary" data-ops-complete="${summary.operationsComplete}" data-tx-successful="${summary.successful}">
      <div><strong>Hash:</strong> <code>${escapeHtml(hash)}</code></div>
      <div><strong>Status:</strong> <span class="tx-detail-status">${escapeHtml(summary.statusLabel)}</span></div>
      <div><strong>Operations:</strong> ${summary.loadedOperationCount} of ${summary.totalOperationCount} loaded (${summary.operationsComplete ? 'Complete' : 'Incomplete - more pages available'})</div>
      <div><strong>Direction:</strong> ${escapeHtml(summary.direction)} | <strong>Assets:</strong> ${escapeHtml(summary.assetLabel)}</div>
    </div>
  `

  const actionsHtml = summary.operationsComplete
    ? '<span class="tag green">All operations loaded</span>'
    : `
      <button type="button" id="btn-tx-load-more-ops" onclick="loadMoreTxOperations('${escapeHtml(hash)}')" style="padding:6px 12px;font-size:12px;cursor:pointer;">Load Next Page</button>
      <button type="button" id="btn-tx-load-all-ops" onclick="loadAllTxOperations('${escapeHtml(hash)}')" style="padding:6px 12px;font-size:12px;cursor:pointer;margin-left:8px;">Load All Remaining Operations</button>
    `

  if (modal) modal.style.display = 'flex'
  if (metaEl) metaEl.innerHTML = metaHtml
  if (opsEl) opsEl.innerHTML = opsRowsHtml
  if (actionsEl) actionsEl.innerHTML = actionsHtml

  return {
    hash,
    summary,
    operations: state.operations,
    metaHtml,
    opsRowsHtml,
    actionsHtml,
  }
}

async function openTxDetail(hash, options = {}) {
  if (!hash) return null

  const cachedTx = txListCache.get(hash)
  if (cachedTx && !options.forceRefresh) {
    const ops = deduplicateTxOperations(cachedTx.operations || [])
    const totalCount = Number.isFinite(Number(cachedTx.operation_count))
      ? Number(cachedTx.operation_count)
      : ops.length
    const complete =
      typeof cachedTx.operationsComplete === 'boolean'
        ? cachedTx.operationsComplete
        : ops.length >= totalCount

    txDetailState.set(hash, {
      ...cachedTx,
      hash,
      operations: ops,
      operation_count: totalCount,
      loadedOperationCount: ops.length,
      operationsComplete: complete,
      operationsTruncated: !complete,
      hasMoreOperations: Boolean(cachedTx.hasMoreOperations || !complete),
      nextOperationsCursor:
        cachedTx.nextOperationsCursor ||
        (ops.length > 0
          ? ops[ops.length - 1].paging_token || ops[ops.length - 1].id || null
          : null),
    })
  } else if (!txDetailState.has(hash) || options.forceRefresh) {
    const query = new URLSearchParams()
    if (options.fetchAll) query.set('all', 'true')
    if (options.limit) query.set('limit', String(options.limit))
    if (txWalletAddress) query.set('address', txWalletAddress)
    const suffix = query.toString() ? `?${query.toString()}` : ''
    const res = await fetch(`/api/wallet/transactions/${encodeURIComponent(hash)}${suffix}`)
    const data = await res.json()
    if (data && data.transaction) {
      const tx = data.transaction
      const ops = deduplicateTxOperations(tx.operations || [])
      txDetailState.set(hash, {
        ...tx,
        hash,
        operations: ops,
        loadedOperationCount: ops.length,
      })
      txListCache.set(hash, txDetailState.get(hash))
    }
  }

  if (options.fetchAll && txDetailState.get(hash) && !txDetailState.get(hash).operationsComplete) {
    await loadAllTxOperations(hash)
  }

  return renderTxDetailModal(hash)
}

async function loadMoreTxOperations(hash, limit = 10) {
  let state = txDetailState.get(hash)
  if (!state) {
    await openTxDetail(hash)
    state = txDetailState.get(hash)
  }
  if (!state || state.operationsComplete) {
    return renderTxDetailModal(hash)
  }

  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (state.nextOperationsCursor) {
    params.set('cursor', String(state.nextOperationsCursor))
  }
  if (Number.isFinite(Number(state.operation_count))) {
    params.set('expectedCount', String(state.operation_count))
  }
  if (txWalletAddress) {
    params.set('address', txWalletAddress)
  }

  const res = await fetch(
    `/api/wallet/transactions/${encodeURIComponent(hash)}/operations?${params.toString()}`
  )
  const data = await res.json()
  if (data && Array.isArray(data.operations)) {
    const mergedOps = deduplicateTxOperations([...(state.operations || []), ...data.operations])
    const totalCount = Number.isFinite(Number(state.operation_count))
      ? Number(state.operation_count)
      : Number.isFinite(Number(data.totalCount))
        ? Number(data.totalCount)
        : mergedOps.length
    const hasMore = Boolean(data.hasMore && mergedOps.length < totalCount)
    const complete = !hasMore && mergedOps.length >= totalCount

    const updated = {
      ...state,
      operations: mergedOps,
      operation_count: totalCount,
      loadedOperationCount: mergedOps.length,
      operationsComplete: complete,
      operationsTruncated: !complete,
      hasMoreOperations: hasMore,
      nextOperationsCursor: hasMore ? data.nextCursor || null : null,
      operationsContinuationUrl: hasMore ? data.continuationUrl || null : null,
    }
    txDetailState.set(hash, updated)
    txListCache.set(hash, updated)
  }

  return renderTxDetailModal(hash)
}

async function loadAllTxOperations(hash) {
  let state = txDetailState.get(hash)
  if (!state) {
    await openTxDetail(hash)
    state = txDetailState.get(hash)
  }
  if (!state) return null

  const params = new URLSearchParams({ all: 'true' })
  if (Number.isFinite(Number(state.operation_count))) {
    params.set('expectedCount', String(state.operation_count))
  }
  if (txWalletAddress) {
    params.set('address', txWalletAddress)
  }

  const res = await fetch(
    `/api/wallet/transactions/${encodeURIComponent(hash)}/operations?${params.toString()}`
  )
  const data = await res.json()
  if (data && Array.isArray(data.operations)) {
    const mergedOps = deduplicateTxOperations([...(state.operations || []), ...data.operations])
    const totalCount = Number.isFinite(Number(state.operation_count))
      ? Number(state.operation_count)
      : Number.isFinite(Number(data.totalCount))
        ? Number(data.totalCount)
        : mergedOps.length
    const complete = Boolean(data.complete ?? mergedOps.length >= totalCount)

    const updated = {
      ...state,
      operations: mergedOps,
      operation_count: totalCount,
      loadedOperationCount: mergedOps.length,
      operationsComplete: complete,
      operationsTruncated: !complete,
      hasMoreOperations: Boolean(data.hasMore && !complete),
      nextOperationsCursor: data.nextCursor || null,
      operationsContinuationUrl: data.continuationUrl || null,
    }
    txDetailState.set(hash, updated)
    txListCache.set(hash, updated)
  }

  return renderTxDetailModal(hash)
}

function closeTxDetail() {
  const modal = document.getElementById('tx-detail-modal')
  if (modal) modal.style.display = 'none'
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
  const str = String(text ?? '')
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const div = document.createElement('div')
    if (div && 'textContent' in div && 'innerHTML' in div) {
      div.textContent = str
      if (typeof div.innerHTML === 'string' && div.innerHTML.length > 0) {
        return div.innerHTML
      }
    }
  }
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
