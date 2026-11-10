/**
 * Status-page price list metadata rendering tests (Issue #169)
 *
 * Verifies:
 *  1. Changing a backend price is reflected after refreshing the status page.
 *  2. Adding a new configured premium endpoint appears without frontend code edits.
 *  3. Missing or malformed pricing metadata produces an explicit unavailable state
 *     while keeping unpriced public endpoints rendered.
 *  4. Method, path, asset/price, and payment availability are displayed consistently.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pricingConfig } from '../src/pricing.config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0

async function testAsync(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(`  ${err.message}`)
    failed++
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Not equal'}: expected ${expected}, got ${actual}`)
  }
}

async function createStatusHarness(fetchResponder) {
  const elements = new Map()

  const ensureElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        className: 'tag',
        style: {},
      })
    }
    return elements.get(id)
  }

  for (const id of [
    'status-grid',
    'key-status-tag',
    'key-hint',
    'endpoint-list',
    'endpoint-paywall-tag',
    'x402-info',
  ]) {
    ensureElement(id)
  }

  globalThis.document = {
    getElementById(id) {
      return elements.get(id) || null
    },
  }

  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/config/apikey')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { configured: true, masked: 'sk-ant-...test' }
        },
      }
    }
    return fetchResponder(url)
  }

  const pagesPath = path.resolve(__dirname, '../public/assets/js/pages.js')
  const source = await fs.readFile(pagesPath, 'utf8')
  const moduleSource = `${source}\nexport { UNPRICED_PUBLIC_ENDPOINTS, parsePricingMetadataEntry, normalizeStatusPricingMetadata, renderStatusEndpointList, loadStatusPage };\n`
  const encoded = Buffer.from(moduleSource, 'utf8').toString('base64')
  const mod = await import(`data:text/javascript;base64,${encoded}`)

  return {
    elements,
    mod,
  }
}

console.log('\n=== Status Page Pricing Metadata Tests (#169) ===\n')

await testAsync(
  'Renders backend pricing metadata and reflects updated backend prices on refresh',
  async () => {
    let researchPrice = '$0.01'
    let analyzePrice = '$0.05'

    const basePricing = pricingConfig.getAllPricingInfo().map((entry) => {
      const [method, routePath] = entry.endpoint.split(/\s+/)
      return {
        ...entry,
        method,
        path: routePath,
        asset: 'USDC',
      }
    })

    const { elements, mod } = await createStatusHarness(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'online',
          version: '1.0.0',
          network: 'stellar:testnet',
          facilitator: 'https://channels.openzeppelin.com/x402/testnet',
          agents: 4,
          claudeEnabled: true,
          x402: {
            enabled: true,
            ready: true,
            settlementAsset: 'USDC',
            middleware: '@x402/express',
            client: '@x402/fetch',
            pricing: basePricing.map((item) => {
              if (item.path === '/api/premium/research') return { ...item, price: researchPrice }
              if (item.path === '/api/premium/analyze') return { ...item, price: analyzePrice }
              return item
            }),
          },
        }
      },
    }))

    await mod.loadStatusPage()
    const epList = elements.get('endpoint-list')
    const paywallTag = elements.get('endpoint-paywall-tag')

    assert(epList.innerHTML.includes('data-path="/api/premium/research"'), 'Missing research route')
    assert(epList.innerHTML.includes('data-price="$0.01"'), 'Expected initial $0.01 research price')
    assert(epList.innerHTML.includes('data-price="$0.05"'), 'Expected initial $0.05 analyze price')
    assert(epList.innerHTML.includes('USDC · x402 Active'), 'Expected USDC and x402 Active label')
    assertEqual(paywallTag.textContent, 'x402 Paywalled', 'Expected active paywall tag text')

    // Simulate backend pricing change and refresh status page
    researchPrice = '$0.04'
    analyzePrice = '$0.12'
    await mod.loadStatusPage()

    assert(
      epList.innerHTML.includes('data-path="/api/premium/research" data-price="$0.04"'),
      'Expected updated $0.04 research price after refresh'
    )
    assert(
      epList.innerHTML.includes('data-path="/api/premium/analyze" data-price="$0.12"'),
      'Expected updated $0.12 analyze price after refresh'
    )
    assert(
      !epList.innerHTML.includes('data-path="/api/premium/research" data-price="$0.01"'),
      'Stale $0.01 research price should not remain'
    )
  }
)

await testAsync(
  'Renders newly added configured premium endpoints without frontend code edits and keeps public routes',
  async () => {
    const customPricing = [
      ...pricingConfig.getAllPricingInfo(),
      {
        endpoint: 'POST /api/premium/translate',
        method: 'POST',
        path: '/api/premium/translate',
        price: '$0.08',
        asset: 'EURC',
        agent: 'translate-bot',
        description: 'Multilingual translation endpoint',
        emoji: '🌐',
      },
    ]

    const { elements, mod } = await createStatusHarness(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'online',
          version: '1.0.0',
          network: 'stellar:testnet',
          facilitator: 'https://channels.openzeppelin.com/x402/testnet',
          agents: 5,
          claudeEnabled: false,
          x402: {
            enabled: true,
            ready: false,
            settlementAsset: 'USDC',
            pricing: customPricing,
          },
        }
      },
    }))

    await mod.loadStatusPage()
    const epList = elements.get('endpoint-list')
    const paywallTag = elements.get('endpoint-paywall-tag')

    assert(
      epList.innerHTML.includes('data-method="POST" data-path="/api/premium/translate"'),
      'Expected new POST /api/premium/translate endpoint to appear automatically'
    )
    assert(
      epList.innerHTML.includes('data-price="$0.08" data-asset="EURC"'),
      'Expected custom endpoint price $0.08 and asset EURC'
    )
    assert(
      epList.innerHTML.includes('Paywall Not Ready'),
      'Expected degraded payment availability label when x402.ready is false'
    )
    assertEqual(paywallTag.textContent, 'Paywall Not Ready', 'Expected Paywall Not Ready tag')

    for (const pub of mod.UNPRICED_PUBLIC_ENDPOINTS) {
      assert(
        epList.innerHTML.includes(
          `data-endpoint-tier="public" data-method="${pub.method}" data-path="${pub.path}"`
        ),
        `Expected unpriced public route ${pub.method} ${pub.path} to be rendered`
      )
    }
  }
)

await testAsync(
  'Renders explicit unavailable state when pricing metadata is missing, malformed, or /api/status fails',
  async () => {
    let scenario = 'missing'

    const { elements, mod } = await createStatusHarness(async () => {
      if (scenario === 'network_error') {
        return { ok: false, status: 503, async json() {} }
      }
      if (scenario === 'malformed') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              status: 'online',
              version: '1.0.0',
              network: 'stellar:testnet',
              x402: {
                enabled: true,
                pricing: [
                  { endpoint: 'GET /api/premium/research', price: '$0.01' },
                  { endpoint: 'INVALID_ROUTE', price: 'free-ish' },
                ],
              },
            }
          },
        }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'online',
            version: '1.0.0',
            network: 'stellar:testnet',
            x402: {
              enabled: true,
              pricing: [],
            },
          }
        },
      }
    })

    // 1. Missing / empty pricing array
    await mod.loadStatusPage()
    const epList = elements.get('endpoint-list')
    const paywallTag = elements.get('endpoint-paywall-tag')
    assert(
      epList.innerHTML.includes('data-pricing-state="unavailable"'),
      'Expected explicit unavailable state when pricing array is empty'
    )
    assert(
      epList.innerHTML.includes('Pricing metadata is missing from /api/status'),
      'Expected missing pricing message'
    )
    assert(
      epList.innerHTML.includes('data-path="/api/orchestrate"'),
      'Public routes should still render when premium pricing is unavailable'
    )
    assertEqual(paywallTag.textContent, 'Pricing Unavailable', 'Expected unavailable tag')

    // 2. Malformed pricing entry
    scenario = 'malformed'
    await mod.loadStatusPage()
    assert(
      epList.innerHTML.includes('data-pricing-state="unavailable"'),
      'Expected explicit unavailable state when pricing metadata has malformed entries'
    )
    assert(
      epList.innerHTML.includes('Malformed pricing metadata (1 invalid entry)'),
      'Expected malformed entry count in unavailable state'
    )

    // 3. Failed /api/status response
    scenario = 'network_error'
    await mod.loadStatusPage()
    assert(
      epList.innerHTML.includes('data-pricing-state="unavailable"'),
      'Expected explicit unavailable state when /api/status request fails'
    )
  }
)

console.log(`\nResults: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
