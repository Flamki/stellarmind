/**
 * Wallet Module
 * Handles wallet balance loading and display
 */

async function loadWallets() {
  try {
    const w = await (await fetch('/api/wallet/balances')).json()
    for (const [k, d] of Object.entries(w)) {
      const bk = k === 'orchestrator' ? 'orch' : k
      const balEl = document.getElementById(`bal-${bk}`)
      const addrEl = document.getElementById(`addr-${bk}`)
      const mEl = document.getElementById(`mbal-${bk}`)

      if (balEl && d.balances) {
        const u = d.balances.find((b) => b.asset === 'USDC')
        const x = d.balances.find((b) => b.asset === 'XLM')

        if (u && parseFloat(u.balance) > 0) {
          balEl.textContent = `${parseFloat(u.balance).toFixed(2)} USDC`
          if (mEl) mEl.textContent = `${parseFloat(u.balance).toFixed(1)} USDC`
        } else if (x) {
          balEl.textContent = `${parseFloat(x.balance).toFixed(2)} XLM`
          if (mEl) mEl.textContent = `${parseFloat(x.balance).toFixed(0)} XLM`
        }
      }

      if (addrEl && d.address) {
        addrEl.textContent = `${d.address.slice(0, 6)}...${d.address.slice(-4)}`
      }
    }
  } catch {}
}
