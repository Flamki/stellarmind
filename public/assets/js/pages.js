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

async function loadTxPage() {
  try {
    const txs = await (await fetch('/api/wallet/transactions')).json()
    document.getElementById('tx-cnt').textContent = txs.length
    document.getElementById('tx-total').textContent = `${txs.length} Transactions`

    if (!txs.length) {
      document.getElementById('tx-body').innerHTML =
        '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted);">No transactions yet. Run the orchestrator first!</td></tr>'
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
  } catch {
    document.getElementById('tx-body').innerHTML =
      '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted);">Failed to load transactions.</td></tr>'
  }
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
