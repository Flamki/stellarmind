/**
 * Wallet Module
 * Handles wallet balance loading, configured settlement-asset identity matching,
 * dual native (XLM) + settlement-asset display with stroop-level precision,
 * and clear distinction between missing trustline, zero balance, and unavailable data.
 */

const STELLAR_DECIMALS = 7
const STROOP_SCALE = 10n ** BigInt(STELLAR_DECIMALS)

const DEFAULT_SETTLEMENT_ASSET = {
  code: 'USDC',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
}

function escapeWalletHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Normalize a number or decimal string to exact Stellar stroops (7 decimal places)
 * without floating-point rounding drift.
 */
function parseDecimalBalance(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return { isValid: false, stroops: 0n, exact: '—' }
  }

  let str = ''
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) return { isValid: false, stroops: 0n, exact: '—' }
    str = rawValue.toFixed(STELLAR_DECIMALS)
  } else if (typeof rawValue === 'string') {
    str = rawValue.trim()
  } else {
    return { isValid: false, stroops: 0n, exact: '—' }
  }

  if (!str) return { isValid: false, stroops: 0n, exact: '—' }

  // Expand scientific notation if present
  if (/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(str)) {
    const num = Number(str)
    if (!Number.isFinite(num)) return { isValid: false, stroops: 0n, exact: '—' }
    str = num.toFixed(STELLAR_DECIMALS)
  }

  let sign = 1n
  if (str.startsWith('+')) {
    str = str.slice(1)
  } else if (str.startsWith('-')) {
    sign = -1n
    str = str.slice(1)
  }

  if (!/^\d+(\.\d+)?$/.test(str)) {
    return { isValid: false, stroops: 0n, exact: '—' }
  }

  const [intPart, fracRaw = ''] = str.split('.')
  const fracClipped = fracRaw.slice(0, STELLAR_DECIMALS).padEnd(STELLAR_DECIMALS, '0')
  const stroops = (BigInt(intPart) * STROOP_SCALE + BigInt(fracClipped)) * sign
  const absStroops = stroops < 0n ? -stroops : stroops
  const exactInt = absStroops / STROOP_SCALE
  const exactFrac = (absStroops % STROOP_SCALE).toString().padStart(STELLAR_DECIMALS, '0')
  const exactSign = stroops < 0n ? '-' : ''

  return {
    isValid: true,
    stroops,
    exact: `${exactSign}${exactInt}.${exactFrac}`,
  }
}

/**
 * Format a balance string with useful precision:
 * - Zero is always displayed as "0.00" (with exact "0.0000000").
 * - Nonzero values never round down to "0.00" or "0": they show at least 2 decimal
 *   places and preserve all nonzero fractional digits up to 7 decimals (1 stroop).
 */
function formatBalanceAmount(rawValue) {
  const parsed = parseDecimalBalance(rawValue)
  if (!parsed.isValid) {
    return {
      display: '—',
      exact: '—',
      isZero: false,
      isSmallNonZero: false,
      stroops: 0n,
    }
  }

  const { stroops, exact } = parsed
  if (stroops === 0n) {
    return {
      display: '0.00',
      exact,
      isZero: true,
      isSmallNonZero: false,
      stroops: 0n,
    }
  }

  const isNeg = stroops < 0n
  const absStroops = isNeg ? -stroops : stroops
  const intVal = absStroops / STROOP_SCALE
  const fracStr = (absStroops % STROOP_SCALE).toString().padStart(STELLAR_DECIMALS, '0')
  const trimmedFrac = fracStr.replace(/0+$/, '')
  const minTwoDecimals = trimmedFrac.length < 2 ? fracStr.slice(0, 2) : trimmedFrac
  const sign = isNeg ? '-' : ''
  const isSmallNonZero = absStroops > 0n && absStroops < 100000n // < 0.01

  return {
    display: `${sign}${intVal}.${minTwoDecimals}`,
    exact,
    isZero: false,
    isSmallNonZero,
    stroops,
  }
}

function normalizeSettlementAssetConfig(assetInput) {
  if (!assetInput || typeof assetInput !== 'object') {
    return { ...DEFAULT_SETTLEMENT_ASSET }
  }
  const code =
    typeof assetInput.code === 'string' && assetInput.code.trim()
      ? assetInput.code.trim().toUpperCase()
      : DEFAULT_SETTLEMENT_ASSET.code
  const issuer =
    assetInput.issuer !== undefined
      ? assetInput.issuer
        ? String(assetInput.issuer).trim()
        : null
      : code === DEFAULT_SETTLEMENT_ASSET.code
        ? DEFAULT_SETTLEMENT_ASSET.issuer
        : null
  return { code, issuer }
}

/**
 * Find a balance entry matching the requested asset identity (code + issuer).
 */
function findAssetBalance(balances, assetSpec) {
  if (!Array.isArray(balances)) return { entry: null, issuerMismatch: false }
  const code = (assetSpec?.code || 'USDC').toUpperCase()
  const expectedIssuer = assetSpec?.issuer || null

  if (code === 'XLM') {
    const nativeEntry =
      balances.find(
        (b) => (b.asset === 'XLM' || b.asset_type === 'native') && (!b.issuer || b.issuer === null)
      ) || balances.find((b) => b.asset === 'XLM')
    return { entry: nativeEntry || null, issuerMismatch: false }
  }

  const sameCodeEntries = balances.filter(
    (b) => String(b.asset || b.asset_code || '').toUpperCase() === code
  )
  if (sameCodeEntries.length === 0) {
    return { entry: null, issuerMismatch: false }
  }

  if (expectedIssuer) {
    const exactMatch = sameCodeEntries.find((b) => b.issuer === expectedIssuer)
    if (exactMatch) {
      return { entry: exactMatch, issuerMismatch: false }
    }
    // Accept legacy fixtures where issuer was omitted/null only if no explicit wrong issuer was given
    const unissuedFixture = sameCodeEntries.find(
      (b) => b.issuer === undefined || b.issuer === null || b.issuer === ''
    )
    if (unissuedFixture) {
      return { entry: unissuedFixture, issuerMismatch: false }
    }
    return { entry: null, issuerMismatch: true }
  }

  return { entry: sameCodeEntries[0], issuerMismatch: false }
}

/**
 * Resolve structured state for both the configured settlement asset and native XLM.
 */
function resolveWalletAssetView(walletData, settlementAssetInput = DEFAULT_SETTLEMENT_ASSET) {
  const settlementAsset = normalizeSettlementAssetConfig(settlementAssetInput)
  const address = walletData?.address || null
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '...'

  if (!walletData || walletData.available === false) {
    const errorType = walletData?.errorType || 'UPSTREAM_ERROR'
    return {
      available: false,
      state: 'unavailable',
      address,
      shortAddress,
      settlementAsset,
      errorType,
      errorMessage: getBalanceErrorMessage(errorType),
      errorDetail: walletData?.error || 'Wallet data unavailable',
      timestamp: walletData?.timestamp || null,
    }
  }

  const balances = Array.isArray(walletData.balances) ? walletData.balances : []

  // Native XLM balance
  const { entry: xlmEntry } = findAssetBalance(balances, { code: 'XLM', issuer: null })
  const nativeFormatted = xlmEntry
    ? formatBalanceAmount(xlmEntry.balance)
    : { display: '0.00', exact: '0.0000000', isZero: true, isSmallNonZero: false, stroops: 0n }
  const nativeState = !xlmEntry ? 'unfunded' : nativeFormatted.isZero ? 'zero' : 'funded'

  // Configured settlement asset balance (e.g. USDC matched by code + issuer)
  const { entry: settlementEntry, issuerMismatch } = findAssetBalance(balances, settlementAsset)
  let settlementFormatted = null
  let settlementState = 'no_trustline'
  let hasTrustline = false

  if (settlementEntry) {
    hasTrustline = true
    settlementFormatted = formatBalanceAmount(settlementEntry.balance)
    settlementState = settlementFormatted.isZero ? 'zero' : 'funded'
  } else if (issuerMismatch) {
    settlementState = 'issuer_mismatch'
  }

  return {
    available: true,
    state: 'available',
    address,
    shortAddress,
    settlementAsset,
    timestamp: walletData?.timestamp || null,
    native: {
      code: 'XLM',
      hasBalanceEntry: Boolean(xlmEntry),
      state: nativeState,
      ...nativeFormatted,
    },
    settlement: {
      code: settlementAsset.code,
      issuer: settlementEntry?.issuer || settlementAsset.issuer || null,
      hasTrustline,
      issuerMismatch,
      state: settlementState,
      ...(settlementFormatted || {
        display: null,
        exact: null,
        isZero: false,
        isSmallNonZero: false,
        stroops: 0n,
      }),
    },
  }
}

function renderWalletCardHtml(view) {
  if (!view.available) {
    return `<div class="wc-error" data-wallet-state="unavailable" data-error-type="${escapeWalletHtml(view.errorType)}" style="color:var(--red)" title="${escapeWalletHtml(view.errorDetail)}">${escapeWalletHtml(view.errorMessage)}</div>`
  }

  const sCode = escapeWalletHtml(view.settlement.code)
  const sIssuerShort = view.settlement.issuer
    ? ` (${view.settlement.issuer.slice(0, 4)}…${view.settlement.issuer.slice(-4)})`
    : ''

  let settlementRowHtml = ''
  if (view.settlement.hasTrustline) {
    const exactTitle = `Exact: ${view.settlement.exact} ${view.settlement.code}${sIssuerShort}`
    settlementRowHtml = `<div class="wc-asset-row settlement" data-asset="${sCode}" data-trustline="present" data-balance-state="${escapeWalletHtml(view.settlement.state)}" data-exact-balance="${escapeWalletHtml(view.settlement.exact)}" title="${escapeWalletHtml(exactTitle)}"><span class="wc-asset-val">${escapeWalletHtml(view.settlement.display)} ${sCode}</span></div>`
  } else {
    const missingLabel = view.settlement.issuerMismatch
      ? `No ${sCode} trustline (issuer mismatch)`
      : `No ${sCode} trustline`
    const missingTitle = view.settlement.issuer
      ? `Missing trustline for ${view.settlement.code} issuer ${view.settlement.issuer}`
      : `Missing trustline for ${view.settlement.code}`
    settlementRowHtml = `<div class="wc-asset-row settlement wc-missing-trustline" data-asset="${sCode}" data-trustline="missing" data-balance-state="${escapeWalletHtml(view.settlement.state)}" title="${escapeWalletHtml(missingTitle)}"><span class="wc-asset-missing">${escapeWalletHtml(missingLabel)}</span></div>`
  }

  const xlmExactTitle = `Exact: ${view.native.exact} XLM (native fee balance)`
  const nativeRowHtml = `<div class="wc-asset-row native" data-asset="XLM" data-balance-state="${escapeWalletHtml(view.native.state)}" data-exact-balance="${escapeWalletHtml(view.native.exact)}" title="${escapeWalletHtml(xlmExactTitle)}"><span class="wc-asset-val wc-native-val">${escapeWalletHtml(view.native.display)} XLM</span></div>`

  return `<div class="wc-dual-balances" data-wallet-state="available">${settlementRowHtml}${nativeRowHtml}</div>`
}

function renderWalletCompactHtml(view) {
  if (!view.available) {
    return `<span style="color:var(--red)" data-wallet-state="unavailable" data-error-type="${escapeWalletHtml(view.errorType)}" title="${escapeWalletHtml(view.errorDetail)}">${escapeWalletHtml(view.errorMessage)}</span>`
  }

  const sCode = escapeWalletHtml(view.settlement.code)
  const settlementPart = view.settlement.hasTrustline
    ? `${escapeWalletHtml(view.settlement.display)} ${sCode}`
    : `No ${sCode} trustline`
  const nativePart = `${escapeWalletHtml(view.native.display)} XLM`
  const fullTitle = view.settlement.hasTrustline
    ? `Exact: ${view.settlement.exact} ${view.settlement.code} | ${view.native.exact} XLM`
    : `Missing ${view.settlement.code} trustline | Exact: ${view.native.exact} XLM`

  return `<span class="sb-dual-bal" data-wallet-state="available" data-trustline="${view.settlement.hasTrustline ? 'present' : 'missing'}" title="${escapeWalletHtml(fullTitle)}">${settlementPart} · ${nativePart}</span>`
}

function updateWalletFreshnessIndicator(data, hasError = false) {
  if (typeof document === 'undefined') return
  const freshEl = document.getElementById('wallet-freshness')
  if (!freshEl) return

  if (hasError) {
    freshEl.textContent = 'Unavailable'
    freshEl.className = 'tag amber'
    freshEl.setAttribute('data-freshness-state', 'error')
    return
  }

  const ts = data?.timestamp ? new Date(data.timestamp) : null
  const validTime = ts && !Number.isNaN(ts.getTime())
  const timeLabel = validTime
    ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'just now'

  if (data?.partialAvailability) {
    freshEl.textContent = `Partial · ${timeLabel}`
    freshEl.className = 'tag amber'
    freshEl.setAttribute('data-freshness-state', 'partial')
    freshEl.setAttribute('title', data.message || 'Some wallet data unavailable')
  } else {
    freshEl.textContent = `Live · ${timeLabel}`
    freshEl.className = 'tag green'
    freshEl.setAttribute('data-freshness-state', 'live')
    if (data?.timestamp) freshEl.setAttribute('title', `Updated at ${data.timestamp}`)
  }
}

async function loadWallets() {
  try {
    const response = await fetch('/api/wallet/balances')
    const data = await response.json()

    // Handle partial availability
    if (data.partialAvailability) {
      console.warn('Some wallet data unavailable:', data.message)
    }

    const wallets = data.wallets || (!data.timestamp && typeof data === 'object' ? data : {})
    const settlementAsset = normalizeSettlementAssetConfig(data.settlementAsset)

    updateWalletFreshnessIndicator(data, false)

    for (const [k, d] of Object.entries(wallets)) {
      const bk = k === 'orchestrator' ? 'orch' : k
      const balEl = document.getElementById(`bal-${bk}`)
      const addrEl = document.getElementById(`addr-${bk}`)
      const mEl = document.getElementById(`mbal-${bk}`)

      const view = resolveWalletAssetView(d, settlementAsset)

      if (balEl) {
        balEl.innerHTML = renderWalletCardHtml(view)
      }
      if (mEl) {
        mEl.innerHTML = renderWalletCompactHtml(view)
      }
      if (addrEl && view.address) {
        addrEl.textContent = view.shortAddress
        if (addrEl.setAttribute) addrEl.setAttribute('title', view.address)
      }
    }
  } catch (err) {
    console.error('Failed to load wallets:', err)
    updateWalletFreshnessIndicator(null, true)
    const walletKeys = ['server', 'orch', 'buyer']
    for (const bk of walletKeys) {
      const balEl = document.getElementById(`bal-${bk}`)
      const mEl = document.getElementById(`mbal-${bk}`)
      if (balEl) {
        balEl.innerHTML =
          '<span class="wc-error" data-wallet-state="unavailable" style="color:var(--red)" title="Network error">⚠️ Error</span>'
      }
      if (mEl) {
        mEl.innerHTML =
          '<span style="color:var(--red)" data-wallet-state="unavailable" title="Network error">⚠️ Error</span>'
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
