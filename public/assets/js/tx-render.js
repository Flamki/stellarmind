/**
 * Transaction table and detail rendering (issue #159).
 *
 * A classic script that defines `TxRender` on the global object, so the page
 * can use it directly and tests/transaction-operations.test.js can load it in a
 * sandbox. The list row never presents the first operation as the transaction
 * total; the detail view pages through every operation of a transaction.
 */
;(function (root) {
  const DIRECTION_LABEL = { incoming: '↓ in', outgoing: '↑ out', self: '↻ self', other: '→ other' }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function humanType(type) {
    return type ? String(type).replaceAll('_', ' ') : '—'
  }

  function formatAmount(op) {
    if (op.amount) {
      const num = Number.parseFloat(op.amount)
      const shown = Number.isFinite(num) ? num.toFixed(2) : op.amount
      return `${shown} ${op.asset_code || 'XLM'}`
    }
    if (op.type === 'invoke_host_function') return 'contract call'
    return '—'
  }

  /**
   * Text for the Type and Amount columns of one list row, plus whether the
   * detail view is needed to see everything.
   */
  function describeTransaction(tx) {
    const summary = tx.summary || {}
    const ops = tx.operations || []
    const count = summary.operationCount ?? tx.operationCount ?? tx.operation_count ?? null
    const kind = summary.kind || (ops.length === 1 ? 'single' : ops.length ? 'multiple' : 'unknown')
    const complete = summary.operationsComplete ?? tx.operationsComplete ?? false
    const failed = (summary.successful ?? tx.successful) === false
    const direction = summary.direction || (ops.length === 1 ? ops[0].direction : null)

    let type
    let amount
    if (kind === 'single' && ops[0]) {
      type = humanType(ops[0].type)
      amount = failed ? '—' : formatAmount(ops[0])
    } else if (kind === 'multiple') {
      const types = summary.types || []
      const shownTypes =
        types.length && types.length <= 3 ? ` (${types.map(humanType).join(', ')})` : ''
      type = `${count ?? ops.length} operations${shownTypes}`
      amount = 'multiple operations'
    } else if (kind === 'none') {
      type = 'no operations'
      amount = '—'
    } else {
      type = 'operations unavailable'
      amount = '—'
    }

    const needsDetails = kind === 'multiple' || !complete
    return { type, amount, direction, failed, needsDetails, count, complete }
  }

  function renderTxRow(tx, explorerBase = 'https://stellar.expert/explorer/testnet/tx/') {
    const d = describeTransaction(tx)
    const hash = String(tx.hash || tx.id || '')
    const timeRaw = tx.created_at || tx.createdAt || null
    const time = timeRaw ? new Date(timeRaw).toLocaleString() : '—'
    const memo = tx.memo_type === 'none' ? 'none' : tx.memo || '—'
    const arrow =
      d.direction && DIRECTION_LABEL[d.direction]
        ? ` <small>${DIRECTION_LABEL[d.direction]}</small>`
        : ''
    const failedBadge = d.failed ? ' <span class="tag red">failed</span>' : ''
    const more = d.needsDetails
      ? ` <button type="button" class="btn tx-details-btn" data-hash="${escapeHtml(hash)}">${
          d.complete ? 'View all' : `View all${d.count ? ` ${d.count}` : ''} operations`
        }</button>`
      : ''
    const partial =
      !d.complete && d.count && !(tx.operationsError || tx.operationsError === '')
        ? ` <small>(showing ${(tx.operations || []).length} of ${d.count})</small>`
        : ''

    return `<tr data-tx="${escapeHtml(hash)}">
          <td><a href="${escapeHtml(explorerBase + hash)}" target="_blank" rel="noopener" class="tx-hash">${escapeHtml(hash.slice(0, 10))}...${escapeHtml(hash.slice(-6))}</a></td>
          <td>${escapeHtml(d.type)}${failedBadge}${partial}${more}</td>
          <td><span class="tx-amount">${escapeHtml(d.amount)}</span>${arrow}</td>
          <td><span class="tx-memo">${escapeHtml(memo)}</span></td>
          <td><span class="tx-time">${escapeHtml(time)}</span></td>
        </tr>`
  }

  function renderOperationRows(ops) {
    return ops
      .map((op) => {
        const dir =
          op.direction && DIRECTION_LABEL[op.direction] ? DIRECTION_LABEL[op.direction] : '—'
        const parties = op.from || op.to ? `${op.from || '—'} → ${op.to || '—'}` : '—'
        return `<tr class="tx-op-row" data-op="${escapeHtml(op.id)}">
            <td>${escapeHtml(humanType(op.type))}</td>
            <td>${escapeHtml(formatAmount(op))}</td>
            <td>${escapeHtml(dir)}</td>
            <td style="word-break:break-all">${escapeHtml(parties)}</td>
          </tr>`
      })
      .join('')
  }

  /**
   * Pages through GET /api/wallet/transactions/:hash/operations. `fetchJson(url)`
   * resolves to the parsed response body. Each `next()` call returns only the new
   * page, and the cursor comes from the server, so no operation is requested twice.
   */
  function createOperationsPager(hash, fetchJson, { limit = 20 } = {}) {
    let cursor = null
    let done = false
    return {
      get done() {
        return done
      },
      async next() {
        if (done) return { operations: [], hasMore: false, transaction: null }
        const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const data = await fetchJson(
          `/api/wallet/transactions/${encodeURIComponent(hash)}/operations?${query}`
        )
        if (!data.success)
          throw new Error(data.message || data.error || 'Failed to load operations')
        cursor = data.pagination.nextCursor
        done = !data.pagination.hasMore
        return { operations: data.operations, hasMore: !done, transaction: data.transaction }
      },
    }
  }

  /** Expand or collapse the detail row under a transaction row (browser only). */
  async function toggleDetails(hash, fetchJson = (u) => fetch(u).then((r) => r.json())) {
    const row = document.querySelector(`tr[data-tx="${CSS.escape(hash)}"]`)
    if (!row) return
    const existing = row.nextElementSibling
    if (existing && existing.classList.contains('tx-detail')) {
      existing.remove()
      return
    }
    const detail = document.createElement('tr')
    detail.className = 'tx-detail'
    detail.innerHTML =
      '<td colspan="5"><table class="tx-table"><thead><tr><th>Operation</th><th>Amount</th><th>Direction</th><th>From → To</th></tr></thead><tbody></tbody></table><div class="tx-detail-status" style="padding:8px 0"></div><button type="button" class="btn tx-detail-more" style="display:none">Load more operations</button></td>'
    row.after(detail)

    const body = detail.querySelector('tbody')
    const status = detail.querySelector('.tx-detail-status')
    const moreBtn = detail.querySelector('.tx-detail-more')
    const pager = createOperationsPager(hash, fetchJson)
    let loaded = 0

    async function loadPage() {
      moreBtn.disabled = true
      status.textContent = 'Loading operations...'
      try {
        const page = await pager.next()
        body.insertAdjacentHTML('beforeend', renderOperationRows(page.operations))
        loaded += page.operations.length
        const total = page.transaction?.operationCount
        const failed = page.transaction?.successful === false ? ' · transaction failed' : ''
        status.textContent = `${loaded}${total ? ` of ${total}` : ''} operations${failed}`
        moreBtn.style.display = page.hasMore ? 'inline-block' : 'none'
      } catch (err) {
        status.textContent = `Could not load operations: ${err.message}`
        moreBtn.style.display = 'inline-block'
      }
      moreBtn.disabled = false
    }

    moreBtn.addEventListener('click', loadPage)
    await loadPage()
  }

  root.TxRender = {
    escapeHtml,
    describeTransaction,
    renderTxRow,
    renderOperationRows,
    createOperationsPager,
    toggleDetails,
  }
})(globalThis)
