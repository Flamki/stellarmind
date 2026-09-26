/**
 * Wallet Module
 * Handles wallet balance loading and display
 */

const NATIVE_ASSET = 'XLM'
const UNAVAILABLE = 'unavailable'
const NO_TRUSTLINE = 'no trustline'
const DEFAULT_SETTLEMENT_ASSET = 'USDC'

/** Trim the trailing zeros of a fixed-point string without touching integers. */
function trimZeros(text) {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/**
 * Format an amount so a small nonzero value never renders as an exact zero.
 * 0 -> "0.00", 0.4 -> "0.4", 0.004 -> "0.0040", 1234.5678 -> "1234.57".
 */
function formatAmount(value) {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return null
  const abs = Math.abs(n)
  if (abs === 0) return '0.00'
  if (abs >= 1) return trimZeros(n.toFixed(2))
  if (abs >= 0.01) return trimZeros(n.toFixed(3))
  return n.toPrecision(3)
}

/** One asset row: distinguishes a real zero from a missing trustline. */
function describeBalance(entry, assetCode) {
  if (!entry) return { state: 'no-trustline', text: `${assetCode}: ${NO_TRUSTLINE}` }
  const amount = formatAmount(entry.balance)
  if (amount === null) return { state: 'unavailable', text: `${assetCode}: ${UNAVAILABLE}` }
  const state = amount === '0.00' ? 'zero' : 'ok'
  return { state, text: `${amount} ${assetCode}` }
}

/** The settlement asset follows configuration, never a hardcoded guess. */
function settlementAssetCode(wallet, configured) {
  const fromWallet = wallet && wallet.settlementAsset
  const code = fromWallet || configured || DEFAULT_SETTLEMENT_ASSET
  return String(code).toUpperCase()
}

/**
 * Both balances, together, with the three states kept apart.
 * Returns { state, text, parts } where text is identical on desktop and mobile.
 */
function summariseWallet(wallet, configuredAsset) {
  if (!wallet || !Array.isArray(wallet.balances) || wallet.balances.length === 0) {
    return { state: 'unavailable', text: UNAVAILABLE, parts: [] }
  }
  const code = settlementAssetCode(wallet, configuredAsset)
  const native = wallet.balances.find((b) => String(b.asset).toUpperCase() === NATIVE_ASSET)
  const settlement = wallet.balances.find((b) => String(b.asset).toUpperCase() === code)
  const parts = [describeBalance(settlement, code), describeBalance(native, NATIVE_ASSET)]
  if (parts.every((p) => p.state === 'unavailable')) {
    return { state: 'unavailable', text: UNAVAILABLE, parts }
  }
  return { state: 'ok', text: parts.map((p) => p.text).join(' \u00b7 '), parts }
}

function configuredSettlementAsset(root) {
  const doc = typeof document === 'undefined' ? null : document
  const host = root || (doc && doc.querySelector('[data-settlement-asset]'))
  if (!host) return DEFAULT_SETTLEMENT_ASSET
  const attr = host.getAttribute ? host.getAttribute('data-settlement-asset') : null
  return attr || DEFAULT_SETTLEMENT_ASSET
}

function renderWallet(key, wallet, configuredAsset) {
  const bk = key === 'orchestrator' ? 'orch' : key
  const { text, state } = summariseWallet(wallet, configuredAsset)
  const stamp = new Date().toISOString()
  for (const id of [`bal-${bk}`, `mbal-${bk}`]) {
    const el = document.getElementById(id)
    if (!el) continue
    el.textContent = text
    el.dataset.walletState = state
    el.dataset.walletUpdated = stamp
    el.title = `updated ${stamp}`
  }
  const addrEl = document.getElementById(`addr-${bk}`)
  if (addrEl && wallet && wallet.address) {
    addrEl.textContent = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
  }
}

async function loadWallets() {
  const configured = configuredSettlementAsset()
  let payload = null
  try {
    payload = await (await fetch('/api/wallet/balances')).json()
  } catch (err) {
    payload = null
  }
  const entries = payload && typeof payload === 'object' ? Object.entries(payload) : []
  if (entries.length === 0) {
    const nodes = document.querySelectorAll('[id^="bal-"],[id^="mbal-"]')
    for (const el of nodes) {
      el.textContent = UNAVAILABLE
      el.dataset.walletState = 'unavailable'
    }
    return
  }
  for (const [key, wallet] of entries) renderWallet(key, wallet, configured)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatAmount,
    describeBalance,
    settlementAssetCode,
    summariseWallet,
    configuredSettlementAsset,
    UNAVAILABLE,
    NO_TRUSTLINE,
  }
}
