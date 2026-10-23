/**
 * Wallet Module
 * Handles wallet balance loading and display
 */

async function loadWallets() {
  try {
    const response = await fetch('/api/wallet/balances')
    const data = await response.json()

    // Handle partial availability
    if (data.partialAvailability) {
      console.warn('Some wallet data unavailable:', data.message)
    }

    const wallets = data.wallets || {}

    for (const [k, d] of Object.entries(wallets)) {
      const bk = k === 'orchestrator' ? 'orch' : k
      const balEl = document.getElementById(`bal-${bk}`)
      const addrEl = document.getElementById(`addr-${bk}`)
      const mEl = document.getElementById(`mbal-${bk}`)

      // Check if wallet data is available
      if (!d.available) {
        // Show error state
        if (balEl) {
          const errorMsg = getBalanceErrorMessage(d.errorType)
          balEl.innerHTML = `<span style="color:var(--red)" title="${d.error}">${errorMsg}</span>`
        }
        if (mEl) {
          mEl.innerHTML = `<span style="color:var(--red)" title="${d.error}">⚠️ Unavailable</span>`
        }
        if (addrEl && d.address) {
          addrEl.textContent = `${d.address.slice(0, 6)}...${d.address.slice(-4)}`
        }
        continue
      }

      // Show balance data
      if (balEl && d.balances) {
        const u = d.balances.find((b) => b.asset === 'USDC')
        const x = d.balances.find((b) => b.asset === 'XLM')

        if (u && parseFloat(u.balance) > 0) {
          balEl.textContent = `${parseFloat(u.balance).toFixed(2)} USDC`
          if (mEl) mEl.textContent = `${parseFloat(u.balance).toFixed(1)} USDC`
        } else if (x) {
          balEl.textContent = `${parseFloat(x.balance).toFixed(2)} XLM`
          if (mEl) mEl.textContent = `${parseFloat(x.balance).toFixed(0)} XLM`
        } else {
          // Empty but valid account
          balEl.textContent = '0.00 XLM'
          if (mEl) mEl.textContent = '0 XLM'
        }
      }

      if (addrEl && d.address) {
        addrEl.textContent = `${d.address.slice(0, 6)}...${d.address.slice(-4)}`
      }
    }
  } catch (err) {
    console.error('Failed to load wallets:', err)
    // Show error state on all wallet displays
    const walletKeys = ['server', 'orch', 'buyer']
    for (const bk of walletKeys) {
      const balEl = document.getElementById(`bal-${bk}`)
      if (balEl) {
        balEl.innerHTML = '<span style="color:var(--red)" title="Network error">⚠️ Error</span>'
      }
    }
  }
}

/**
 * Get user-friendly error message for balance errors
 */
function getBalanceErrorMessage(errorType) {
  const messages = {
    ACCOUNT_NOT_FOUND: '⚠️ Not funded',
    TIMEOUT: '⏱️ Timeout',
    NETWORK_ERROR: '🌐 Network error',
    UPSTREAM_ERROR: '⚠️ Service unavailable',
  }
  return messages[errorType] || '⚠️ Error'
}
