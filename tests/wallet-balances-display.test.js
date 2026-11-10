/**
 * Dual-Asset Wallet Balance Display & Precision Tests (issue #170).
 *
 * Validates that both native XLM and configured settlement-asset (USDC)
 * balances are displayed together with stroop-level precision, that small
 * nonzero amounts never round to zero, and that missing trustlines, zero
 * balances, issuer mismatches, and upstream unavailability are distinguishable.
 *
 * Run: node tests/wallet-balances-display.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

function createWalletDomHarness() {
  const elements = new Map()

  function makeElement(id) {
    const attrs = new Map()
    const el = {
      id,
      className: '',
      textContent: '',
      innerHTML: '',
      setAttribute(name, val) {
        attrs.set(name, String(val))
      },
      getAttribute(name) {
        return attrs.has(name) ? attrs.get(name) : null
      },
    }
    elements.set(id, el)
    return el
  }

  for (const key of ['server', 'orch', 'buyer']) {
    makeElement(`bal-${key}`)
    makeElement(`addr-${key}`)
    makeElement(`mbal-${key}`)
  }
  makeElement('wallet-freshness')

  return {
    elements,
    documentObj: {
      getElementById(id) {
        return elements.get(id) || null
      },
    },
  }
}

async function withWalletModule(mockFetchResponse, fn) {
  const sourcePath = path.join(__dirname, '..', 'public', 'assets', 'js', 'wallet.js')
  const source = await fs.readFile(sourcePath, 'utf8')
  const exportList = [
    'DEFAULT_SETTLEMENT_ASSET',
    'parseDecimalBalance',
    'formatBalanceAmount',
    'findAssetBalance',
    'resolveWalletAssetView',
    'renderWalletCardHtml',
    'renderWalletCompactHtml',
    'loadWallets',
    'getBalanceErrorMessage',
  ].join(', ')

  const tempPath = path.join(
    __dirname,
    `.wallet-under-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  )
  await fs.writeFile(tempPath, `${source}\nexport { ${exportList} }\n`, 'utf8')

  const harness = createWalletDomHarness()
  const prevDocument = globalThis.document
  const prevFetch = globalThis.fetch
  globalThis.document = harness.documentObj
  globalThis.fetch = async () => {
    if (mockFetchResponse instanceof Error) {
      throw mockFetchResponse
    }
    return {
      ok: true,
      status: 200,
      json: async () => mockFetchResponse,
    }
  }

  try {
    const mod = await import(pathToFileURL(tempPath).href)
    await fn(mod, harness)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
    if (prevDocument === undefined) delete globalThis.document
    else globalThis.document = prevDocument
    if (prevFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = prevFetch
  }
}

console.log('Dual-Asset Wallet Balance Display & Precision')

await test('small nonzero amounts never round to exact zero', async () => {
  await withWalletModule({}, async (wallet) => {
    const oneStroop = wallet.formatBalanceAmount('0.0000001')
    assert.strictEqual(oneStroop.display, '0.0000001')
    assert.strictEqual(oneStroop.exact, '0.0000001')
    assert.strictEqual(oneStroop.isZero, false)
    assert.strictEqual(oneStroop.isSmallNonZero, true)

    const halfCent = wallet.formatBalanceAmount('0.0050000')
    assert.strictEqual(halfCent.display, '0.005')
    assert.strictEqual(halfCent.exact, '0.0050000')
    assert.strictEqual(halfCent.isZero, false)
    assert.strictEqual(halfCent.isSmallNonZero, true)

    const microBalance = wallet.formatBalanceAmount('0.0004200')
    assert.strictEqual(microBalance.display, '0.00042')
    assert.strictEqual(microBalance.exact, '0.0004200')
    assert.strictEqual(microBalance.isZero, false)

    const standardBalance = wallet.formatBalanceAmount('25.5000000')
    assert.strictEqual(standardBalance.display, '25.50')
    assert.strictEqual(standardBalance.exact, '25.5000000')
    assert.strictEqual(standardBalance.isZero, false)
    assert.strictEqual(standardBalance.isSmallNonZero, false)

    const exactZero = wallet.formatBalanceAmount('0.0000000')
    assert.strictEqual(exactZero.display, '0.00')
    assert.strictEqual(exactZero.exact, '0.0000000')
    assert.strictEqual(exactZero.isZero, true)
    assert.strictEqual(exactZero.isSmallNonZero, false)
  })
})

await test('both native XLM and settlement USDC balances are visible together across desktop and compact views', async () => {
  const payload = {
    settlementAsset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER },
    timestamp: '2026-10-21T12:34:56.000Z',
    wallets: {
      server: {
        address: 'GSERVER1234567890ABCDEF1234567890ABCDEF1234567890SERVER99',
        available: true,
        balances: [
          { asset: 'USDC', balance: '14.2500000', issuer: TESTNET_USDC_ISSUER },
          { asset: 'XLM', balance: '99.9999900', issuer: null },
        ],
      },
      orchestrator: {
        address: 'GORCH1234567890ABCDEF1234567890ABCDEF1234567890ORCH8888',
        available: true,
        balances: [
          { asset: 'USDC', balance: '0.0000001', issuer: TESTNET_USDC_ISSUER },
          { asset: 'XLM', balance: '0.0045000', issuer: null },
        ],
      },
      buyer: {
        address: 'GBUYER1234567890ABCDEF1234567890ABCDEF1234567890BUYER777',
        available: true,
        balances: [
          { asset: 'USDC', balance: '0.0000000', issuer: TESTNET_USDC_ISSUER },
          { asset: 'XLM', balance: '50.0000000', issuer: null },
        ],
      },
    },
  }

  await withWalletModule(payload, async (wallet, harness) => {
    await wallet.loadWallets()

    // Server shows both 14.25 USDC and 99.99999 XLM with exact precision metadata
    const serverCard = harness.elements.get('bal-server').innerHTML
    const serverCompact = harness.elements.get('mbal-server').innerHTML
    assert.match(serverCard, /14\.25 USDC/)
    assert.match(serverCard, /99\.99999 XLM/)
    assert.match(serverCard, /data-exact-balance="14\.2500000"/)
    assert.match(serverCard, /data-exact-balance="99\.9999900"/)
    assert.match(serverCompact, /14\.25 USDC · 99\.99999 XLM/)

    // Orchestrator shows small nonzero balances without rounding to 0.00 or 0
    const orchCard = harness.elements.get('bal-orch').innerHTML
    const orchCompact = harness.elements.get('mbal-orch').innerHTML
    assert.match(orchCard, /0\.0000001 USDC/)
    assert.match(orchCard, /0\.0045 XLM/)
    assert.match(orchCompact, /0\.0000001 USDC · 0\.0045 XLM/)

    // Freshness badge reflects live status
    const freshness = harness.elements.get('wallet-freshness')
    assert.strictEqual(freshness.getAttribute('data-freshness-state'), 'live')
    assert.match(freshness.textContent, /^Live · /)
  })
})

await test('missing trustline, zero balance, issuer mismatch, and unavailable data are distinguishable', async () => {
  const payload = {
    settlementAsset: { code: 'USDC', issuer: TESTNET_USDC_ISSUER },
    partialAvailability: true,
    message: 'Some wallet data could not be retrieved.',
    timestamp: '2026-10-21T12:34:56.000Z',
    wallets: {
      // Case 1: Zero USDC balance (trustline present, balance = 0)
      server: {
        address: 'GSERVER1234567890ABCDEF1234567890ABCDEF1234567890SERVER99',
        available: true,
        balances: [
          { asset: 'USDC', balance: '0.0000000', issuer: TESTNET_USDC_ISSUER },
          { asset: 'XLM', balance: '100.0000000', issuer: null },
        ],
      },
      // Case 2: Missing USDC trustline (XLM funded, no USDC entry)
      orchestrator: {
        address: 'GORCH1234567890ABCDEF1234567890ABCDEF1234567890ORCH8888',
        available: true,
        balances: [{ asset: 'XLM', balance: '100.0000000', issuer: null }],
      },
      // Case 3: Upstream unavailable (Horizon timeout)
      buyer: {
        address: 'GBUYER1234567890ABCDEF1234567890ABCDEF1234567890BUYER777',
        available: false,
        error: 'Request timed out',
        errorType: 'TIMEOUT',
        timestamp: '2026-10-21T12:34:56.000Z',
      },
    },
  }

  await withWalletModule(payload, async (wallet, harness) => {
    await wallet.loadWallets()

    const zeroUsdcHtml = harness.elements.get('bal-server').innerHTML
    const noTrustlineHtml = harness.elements.get('bal-orch').innerHTML
    const unavailableHtml = harness.elements.get('bal-buyer').innerHTML

    // Zero USDC has trustline="present" and state="zero" and displays "0.00 USDC" + "100.00 XLM"
    assert.match(zeroUsdcHtml, /data-trustline="present"/)
    assert.match(zeroUsdcHtml, /data-balance-state="zero"/)
    assert.match(zeroUsdcHtml, /0\.00 USDC/)
    assert.match(zeroUsdcHtml, /100\.00 XLM/)

    // Missing trustline has trustline="missing" and state="no_trustline" and displays "No USDC trustline" + "100.00 XLM"
    assert.match(noTrustlineHtml, /data-trustline="missing"/)
    assert.match(noTrustlineHtml, /data-balance-state="no_trustline"/)
    assert.match(noTrustlineHtml, /No USDC trustline/)
    assert.match(noTrustlineHtml, /100\.00 XLM/)
    assert.match(harness.elements.get('mbal-orch').innerHTML, /No USDC trustline · 100\.00 XLM/)

    // Unavailable wallet has data-wallet-state="unavailable" and displays timeout message
    assert.match(unavailableHtml, /data-wallet-state="unavailable"/)
    assert.match(unavailableHtml, /data-error-type="TIMEOUT"/)
    assert.match(unavailableHtml, /Timeout/)

    // Verify all three HTML outputs are distinct
    assert.notStrictEqual(zeroUsdcHtml, noTrustlineHtml)
    assert.notStrictEqual(noTrustlineHtml, unavailableHtml)
    assert.notStrictEqual(zeroUsdcHtml, unavailableHtml)

    // Verify issuer mismatch is rejected and distinguished from valid trustline
    const spoofedView = wallet.resolveWalletAssetView(
      {
        address: 'GSPOOF1234567890',
        available: true,
        balances: [
          {
            asset: 'USDC',
            balance: '9999.0000000',
            issuer: 'GFAKEISSUER111111111111111111111111111111111111111111111',
          },
          { asset: 'XLM', balance: '20.0000000', issuer: null },
        ],
      },
      { code: 'USDC', issuer: TESTNET_USDC_ISSUER }
    )
    assert.strictEqual(spoofedView.settlement.hasTrustline, false)
    assert.strictEqual(spoofedView.settlement.issuerMismatch, true)
    assert.strictEqual(spoofedView.settlement.state, 'issuer_mismatch')
    const spoofedHtml = wallet.renderWalletCardHtml(spoofedView)
    assert.match(spoofedHtml, /No USDC trustline \(issuer mismatch\)/)
    assert.doesNotMatch(spoofedHtml, /9999/)

    // Freshness badge reflects partial availability
    const freshness = harness.elements.get('wallet-freshness')
    assert.strictEqual(freshness.getAttribute('data-freshness-state'), 'partial')
    assert.match(freshness.textContent, /^Partial · /)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n${name}:\n${err.stack}`)
  }
  process.exit(1)
}
