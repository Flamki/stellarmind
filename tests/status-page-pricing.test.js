/**
 * Status-page pricing rendering guards for issue #169.
 *
 * The bug this pins down: `loadStatusPage` built its endpoint rows from a
 * literal array, so the prices shown to a visitor were whatever a developer
 * typed, not what the paywall actually charges. Changing a price in
 * `src/pricing.config.js` changed the 402 challenge but not the page.
 *
 * The page is rendered by an inline <script> inside `public/index.html`, so
 * there is nothing to import. This test extracts that script, runs it against a
 * minimal DOM and a controllable `fetch`, and then checks the rendered rows
 * against the response the server would actually send.
 *
 * Covered, matching the issue's acceptance criteria:
 *  1. a changed backend price is reflected on refresh;
 *  2. a newly configured premium endpoint appears with no frontend edit;
 *  3. missing / malformed metadata produces an explicit unavailable state;
 *  4. method, path and price are rendered consistently for every row.
 *
 * Run: node tests/status-page-pricing.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexHtml = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8')

// ── extract the inline script that renders the status page ───────────────────

const scriptMatch = indexHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)
assert.ok(scriptMatch, 'public/index.html must contain the inline application script')

const appScript = scriptMatch[1]
assert.match(
  appScript,
  /async function loadStatusPage\s*\(/,
  'the inline script must define loadStatusPage'
)

// ── a DOM small enough to run the page against ───────────────────────────────

/**
 * The inline script wires up a lot of unrelated widgets on load. Only
 * #endpoint-list matters here, so every element is a permissive stub and the
 * real innerHTML is captured for the one id under test.
 */
function createElement(id = '') {
  const element = {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    disabled: false,
    checked: false,
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    querySelector: () => createElement(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    blur() {},
    click() {},
    remove() {},
    scrollIntoView() {},
    insertAdjacentHTML() {},
  }
  return element
}

function createDom() {
  const nodes = new Map()
  const captured = new Set(['endpoint-list'])

  const documentStub = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createElement(id))
      return nodes.get(id)
    },
    querySelector: () => createElement(),
    querySelectorAll: () => [],
    createElement: () => createElement(),
    createTextNode: () => ({}),
    addEventListener() {},
    removeEventListener() {},
    body: createElement('body'),
    head: createElement('head'),
    documentElement: createElement('html'),
    readyState: 'complete',
    cookie: '',
  }

  return {
    document: documentStub,
    innerHtmlOf(id) {
      return nodes.has(id) ? nodes.get(id).innerHTML : ''
    },
    captured,
  }
}

/**
 * Run the page script with a canned /api/status payload and return the HTML
 * that ended up in #endpoint-list.
 */
function renderEndpointList(statusPayload) {
  const dom = createDom()

  const jsonResponse = (payload) => ({
    ok: true,
    json: async () => payload,
  })

  const fetchStub = async (url) => {
    if (String(url).includes('/api/status')) return jsonResponse(statusPayload)
    if (String(url).includes('/api/config/apikey')) {
      return jsonResponse({ configured: false, masked: '' })
    }
    return jsonResponse([])
  }

  const sandbox = {
    document: dom.document,
    fetch: fetchStub,
    console,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    EventSource: class {
      constructor() {}
      addEventListener() {}
      close() {}
    },
    navigator: { clipboard: { writeText: async () => {} } },
    window: {},
    alert: () => {},
  }
  sandbox.window = sandbox

  const context = vm.createContext(sandbox)
  vm.runInContext(appScript, context, { filename: 'public/index.html' })

  // the script kicks off its own boot calls; drive the one under test directly
  return vm.runInContext('loadStatusPage()', context).then(() => dom.innerHtmlOf('endpoint-list'))
}

// ── 1. a changed backend price is reflected ──────────────────────────────────

const baseStatus = {
  status: 'online',
  version: '1.0.0',
  network: 'testnet',
  facilitator: 'https://facilitator.example',
  agents: 4,
  claudeEnabled: true,
  x402: {
    middleware: 'm',
    client: 'c',
    pricing: [
      { endpoint: 'GET /api/premium/research', price: '$0.01', agent: 'research-bot' },
      { endpoint: 'GET /api/premium/analyze', price: '$0.05', agent: 'analyst-bot' },
    ],
  },
}

const baseHtml = await renderEndpointList(baseStatus)
assert.match(baseHtml, /\/api\/premium\/research/, 'research row must be rendered')
assert.match(baseHtml, /\$0\.01/, 'research price must come from the response')

const repricedStatus = JSON.parse(JSON.stringify(baseStatus))
repricedStatus.x402.pricing[0].price = '$9.99'
const repricedHtml = await renderEndpointList(repricedStatus)
assert.match(repricedHtml, /\$9\.99/, 'a changed backend price must show up after refresh')
assert.ok(
  !repricedHtml.includes('$0.01'),
  'the previous hardcoded price must not survive a price change'
)

// ── 2. a new premium endpoint appears without a frontend edit ────────────────

const extendedStatus = JSON.parse(JSON.stringify(baseStatus))
extendedStatus.x402.pricing.push({
  endpoint: 'GET /api/premium/translate',
  price: '$0.07',
  agent: 'translate-bot',
})
const extendedHtml = await renderEndpointList(extendedStatus)
assert.match(
  extendedHtml,
  /\/api\/premium\/translate/,
  'a newly configured premium endpoint must render without editing the frontend'
)
assert.match(extendedHtml, /\$0\.07/, 'the new endpoint must carry its configured price')

// ── 3. missing or malformed metadata produces an explicit unavailable state ──

const noPricingHtml = await renderEndpointList({
  ...baseStatus,
  x402: { middleware: 'm', client: 'c' },
})
assert.match(
  noPricingHtml,
  /pricing unavailable/i,
  'absent x402.pricing must produce an explicit unavailable state, not stale rows'
)

const emptyPricingHtml = await renderEndpointList({
  ...baseStatus,
  x402: { middleware: 'm', client: 'c', pricing: [] },
})
assert.match(
  emptyPricingHtml,
  /pricing unavailable/i,
  'an empty pricing list must produce the unavailable state too'
)

const malformedHtml = await renderEndpointList({
  ...baseStatus,
  x402: { middleware: 'm', client: 'c', pricing: 'not-an-array' },
})
assert.match(
  malformedHtml,
  /pricing unavailable/i,
  'malformed pricing metadata must produce the unavailable state'
)

// ── 4. method, path and price render consistently ────────────────────────────

const rowPattern =
  /<span class="ep-method ([a-z]+)">([A-Z]+)<\/span>\s*<span class="ep-path">([^<]+)<\/span>\s*(?:<span class="ep-price">🔒 (\$[0-9.]+)<\/span>|<span class="ep-free">Free<\/span>)/g

const rows = [...extendedHtml.matchAll(rowPattern)].map((m) => ({
  methodClass: m[1],
  method: m[2],
  path: m[3],
  price: m[4] || null,
}))

assert.ok(rows.length >= extendedStatus.x402.pricing.length, 'every endpoint must render as a row')

for (const info of extendedStatus.x402.pricing) {
  const [method, endpointPath] = info.endpoint.split(' ')
  const row = rows.find((r) => r.path === endpointPath)
  assert.ok(row, `${info.endpoint} must render a row`)
  assert.equal(row.method, method, `${info.endpoint} must show its HTTP method`)
  assert.equal(
    row.methodClass,
    method.toLowerCase(),
    `${info.endpoint} method class must match its method for styling`
  )
  assert.equal(row.price, info.price, `${info.endpoint} must show the configured price`)
}

// public routes stay listed and unpriced
const freeRow = rows.find((r) => r.path === '/api/status')
assert.ok(freeRow, 'public routes must still be listed')
assert.equal(freeRow.price, null, 'public routes must render as free, not priced')

console.log('✅ status-page pricing: all assertions passed')
console.log(`   ${rows.length} endpoint rows rendered from response metadata`)
