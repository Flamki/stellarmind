/**
 * Searchable and sortable agent catalog controls tests (Issue #168)
 *
 * Verifies:
 *  1. Search and capability/status filters narrow the rendered catalog predictably and compose cleanly.
 *  2. Price sorting compares normalized numeric amounts within an asset rather than display strings.
 *  3. Search, filter, and sort changes preserve the user's selected agent.
 *  4. Empty results offer a clear reset action that restores the catalog.
 *  5. Controls and agent cards are usable by keyboard and assistive technology.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareAgentPrices, queryAgentCatalog } from '../src/agents/registry.js'

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

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message || 'Deep equal failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

const FIXTURE_CATALOG = [
  {
    id: 'research-bot',
    name: '🔬 Research Agent',
    endpoint: '/api/research',
    price: '0.01',
    currency: 'USDC',
    model: 'Claude Haiku',
    capability: 'Deep web research and fact-finding on any topic',
    description: 'Uses Claude Haiku for fast, accurate research synthesis.',
    status: 'online',
  },
  {
    id: 'summary-bot',
    name: '📝 Summary Agent',
    endpoint: '/api/summarize',
    price: '0.0100',
    currency: 'USDC',
    model: 'Claude Haiku',
    capability: 'Text summarization and key insight extraction',
    description: 'Condenses long texts into concise, actionable summaries.',
    status: 'online',
  },
  {
    id: 'analyst-bot',
    name: '📊 Analysis Agent',
    endpoint: '/api/analyze',
    price: '0.05',
    currency: 'USDC',
    model: 'Claude Sonnet',
    capability: 'Deep strategic analysis with structured insights',
    description: 'Uses Claude Sonnet for premium-tier quantitative analysis.',
    status: 'online',
  },
  {
    id: 'code-bot',
    name: '💻 Code Agent',
    endpoint: '/api/code',
    price: '0.03',
    currency: 'USDC',
    model: 'Claude Sonnet',
    capability: 'Code generation, review, and debugging',
    description: 'Generates, reviews, and debugs TypeScript and Rust code.',
    status: 'degraded',
  },
  {
    id: 'micro-ping-bot',
    name: '⚡ Micro Ping Agent',
    endpoint: '/api/ping',
    price: '0.005',
    currency: 'USDC',
    model: 'Claude Haiku',
    capability: 'Data telemetry ping and latency verification',
    description: 'Ultra-low-cost health telemetry probe.',
    status: 'online',
  },
  {
    id: 'security-auditor',
    name: '🛡️ Security Auditor',
    endpoint: '/api/security',
    price: '2',
    currency: 'USDC',
    model: 'Claude Opus',
    capability: 'Security vulnerability auditing for Soroban contracts',
    description: 'Audits smart contracts for reentrancy and authorization flaws.',
    status: 'online',
  },
  {
    id: 'enterprise-architect',
    name: '🏛️ Enterprise Architect',
    endpoint: '/api/architect',
    price: '10',
    currency: 'USDC',
    model: 'Claude Opus',
    capability: 'Deep strategic analysis for distributed architecture',
    description: 'Full-scale system design and threat modeling.',
    status: 'offline',
  },
  {
    id: 'polyglot-translator',
    name: '🌐 Polyglot Translator',
    endpoint: '/api/translate',
    price: '0.10',
    currency: 'USDC',
    model: 'Claude Haiku',
    capability: 'Translation and localization across 40 languages',
    description: 'Preserves technical terminology while localizing documentation.',
    status: 'online',
  },
  {
    id: 'sql-optimizer',
    name: '🗄️ SQL Optimizer',
    endpoint: '/api/sql',
    price: '0.25',
    currency: 'USDC',
    model: 'Claude Sonnet',
    capability: 'Code review and query execution plan tuning',
    description: 'Indexes and rewrites slow relational database queries.',
    status: 'offline',
  },
  {
    id: 'defi-researcher',
    name: '📈 DeFi Researcher',
    endpoint: '/api/defi',
    price: '0.03',
    currency: 'USDC',
    model: 'Claude Sonnet',
    capability: 'Deep web research on Stellar DEX liquidity',
    description: 'Tracks orderbook depth and path payment slippage.',
    status: 'degraded',
  },
  {
    id: 'euro-compliance-bot',
    name: '🇪🇺 Euro Compliance Agent',
    endpoint: '/api/eu-compliance',
    price: '0.02',
    currency: 'EURC',
    model: 'Claude Sonnet',
    capability: 'Security and MiCA regulatory compliance review',
    description: 'Evaluates European stablecoin settlement requirements.',
    status: 'online',
  },
  {
    id: 'euro-research-bot',
    name: '💶 Euro Market Researcher',
    endpoint: '/api/eu-research',
    price: '0.008',
    currency: 'EURC',
    model: 'Claude Haiku',
    capability: 'Research on European payment corridors',
    description: 'Synthesizes SEPA and EURC corridor volume metrics.',
    status: 'online',
  },
]

async function createAgentCatalogHarness(catalogFixture = FIXTURE_CATALOG) {
  const elements = new Map()

  const ensureElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        innerHTML: '',
        textContent: '',
        className: '',
        dataset: {},
        style: {},
      })
    }
    return elements.get(id)
  }

  for (const id of [
    'nav-cnt',
    'sb-agents',
    'agent-search-input',
    'agent-status-filter',
    'agent-capability-filter',
    'agent-sort-select',
    'agent-reset-btn',
    'agent-results-meta',
    'agent-selection-status',
    'agent-cards',
  ]) {
    ensureElement(id)
  }

  globalThis.document = {
    getElementById(id) {
      return elements.get(id) || null
    },
  }

  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/agents')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return catalogFixture
        },
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`)
  }

  const agentsJsPath = path.resolve(__dirname, '../public/assets/js/agents.js')
  const source = await fs.readFile(agentsJsPath, 'utf8')
  const moduleSource = `${source}\n// instance-${Date.now()}-${Math.random()}\nexport { parseNormalizedPriceUnits, compareAgentsByPrice, extractCapabilityOptions, filterAndSortAgents, setAgentCatalog, setAgentCatalogControls, resetAgentCatalogControls, selectAgent, getSelectedAgentId, getAgentCatalogControls, handleAgentCardKeydown, loadAgents, loadAgentPage };\n`
  const encoded = Buffer.from(moduleSource, 'utf8').toString('base64')
  const mod = await import(`data:text/javascript;base64,${encoded}`)

  await mod.loadAgentPage()
  return { elements, mod }
}

console.log('\n=== Agent Catalog Search, Filter, and Sort Tests (#168) ===\n')

await testAsync(
  'Search, status, and capability filters narrow the catalog predictably and compose together',
  async () => {
    const { elements, mod } = await createAgentCatalogHarness()

    // Initial full render
    assertEqual(elements.get('nav-cnt').textContent, '12', 'Expected 12 total agents in sidebar')
    assert(
      elements.get('agent-results-meta').textContent.includes('Showing 12 of 12 agents'),
      'Expected 12 of 12 agents in results meta'
    )

    // Filter by capability: research
    let visible = mod.setAgentCatalogControls({ capability: 'research' })
    assertDeepEqual(
      visible.map((a) => a.id),
      ['research-bot', 'defi-researcher', 'euro-research-bot'],
      'Capability filter "research" should return the 3 research agents'
    )

    // Compose capability="research" + status="online"
    visible = mod.setAgentCatalogControls({ status: 'online' })
    assertDeepEqual(
      visible.map((a) => a.id),
      ['research-bot', 'euro-research-bot'],
      'Composing capability=research + status=online should exclude degraded defi-researcher'
    )

    // Compose capability="research" + status="online" + search query="haiku synthesis"
    visible = mod.setAgentCatalogControls({ query: 'haiku synthesis' })
    assertDeepEqual(
      visible.map((a) => a.id),
      ['research-bot'],
      'Composing search query with capability and status filters should narrow to research-bot'
    )
    assert(
      elements.get('agent-cards').innerHTML.includes('data-agent-id="research-bot"'),
      'Rendered HTML should include research-bot card'
    )
    assert(
      !elements.get('agent-cards').innerHTML.includes('data-agent-id="euro-research-bot"'),
      'Rendered HTML should not include filtered-out euro-research-bot'
    )
  }
)

await testAsync(
  'Price sorting compares normalized numeric amounts within an asset rather than display strings',
  async () => {
    const { mod } = await createAgentCatalogHarness()

    // Ascending price sort across all 12 fixture agents
    const asc = mod.setAgentCatalogControls({ sort: 'price-asc' })
    const usdcAscIds = asc.filter((a) => a.currency === 'USDC').map((a) => a.id)
    const eurcAscIds = asc.filter((a) => a.currency === 'EURC').map((a) => a.id)

    // Verify numeric ordering: 0.005 < 0.01 === 0.0100 < 0.03 === 0.03 < 0.05 < 0.10 < 0.25 < 2 < 10
    // (String sort would wrongly put '10' before '2' and '0.0100' after '0.01' without tie-breaking)
    assertDeepEqual(
      usdcAscIds,
      [
        'micro-ping-bot', // 0.005
        'research-bot', // 0.01 (Research Agent < Summary Agent)
        'summary-bot', // 0.0100
        'code-bot', // 0.03 (Code Agent < DeFi Researcher)
        'defi-researcher', // 0.03
        'analyst-bot', // 0.05
        'polyglot-translator', // 0.10
        'sql-optimizer', // 0.25
        'security-auditor', // 2
        'enterprise-architect', // 10
      ],
      'USDC agents should be sorted by exact normalized numeric price ascending with deterministic name tie-breaking'
    )
    assertDeepEqual(
      eurcAscIds,
      ['euro-research-bot', 'euro-compliance-bot'],
      'EURC agents should be sorted by exact normalized numeric price ascending (0.008 < 0.02)'
    )

    // Descending price sort
    const desc = mod.setAgentCatalogControls({ sort: 'price-desc' })
    const usdcDescIds = desc.filter((a) => a.currency === 'USDC').map((a) => a.id)
    assertDeepEqual(
      usdcDescIds,
      [
        'enterprise-architect', // 10
        'security-auditor', // 2
        'sql-optimizer', // 0.25
        'polyglot-translator', // 0.10
        'analyst-bot', // 0.05
        'code-bot', // 0.03
        'defi-researcher', // 0.03
        'research-bot', // 0.01
        'summary-bot', // 0.0100
        'micro-ping-bot', // 0.005
      ],
      'USDC agents should be sorted by exact normalized numeric price descending'
    )

    // Also verify backend registry helpers match
    assertEqual(
      compareAgentPrices(
        { price: '2', currency: 'USDC' },
        { price: '10', currency: 'USDC' },
        'asc'
      ),
      -1,
      'compareAgentPrices should order 2 USDC before 10 USDC'
    )
    const queried = queryAgentCatalog(FIXTURE_CATALOG, {
      status: 'online',
      sort: 'price-asc',
    })
    assertEqual(queried[0].id, 'micro-ping-bot', 'Cheapest online USDC agent should be first')
  }
)

await testAsync(
  'Preserves the selected agent across search, filter, sort, and reset updates',
  async () => {
    const { elements, mod } = await createAgentCatalogHarness()

    // Select code-bot via keyboard handler (Enter key)
    let prevented = false
    mod.handleAgentCardKeydown(
      {
        key: 'Enter',
        preventDefault() {
          prevented = true
        },
      },
      'code-bot'
    )
    assert(prevented, 'Enter keydown on agent card should preventDefault')
    assertEqual(mod.getSelectedAgentId(), 'code-bot', 'code-bot should be selected')
    assert(
      elements.get('agent-cards').innerHTML.includes('id="agent-card-code-bot"'),
      'code-bot card should be rendered'
    )
    assert(
      elements.get('agent-cards').innerHTML.includes('data-selected-badge="true"'),
      'Selected card should display selected badge'
    )

    // Narrow filter to status="online" (which hides degraded code-bot)
    mod.setAgentCatalogControls({ status: 'online' })
    assertEqual(
      mod.getSelectedAgentId(),
      'code-bot',
      'selectedAgentId must be preserved even when filtered out of current view'
    )
    assert(
      elements
        .get('agent-selection-status')
        .textContent.includes('preserved while hidden by current filters'),
      'Selection status should indicate that the selected agent is preserved while hidden'
    )

    // Widen filter back to status="all" and sort by price-desc
    mod.setAgentCatalogControls({ status: 'all', sort: 'price-desc' })
    assertEqual(mod.getSelectedAgentId(), 'code-bot', 'selectedAgentId should still be code-bot')
    assert(
      elements
        .get('agent-cards')
        .innerHTML.includes('id="agent-card-code-bot" data-agent-id="code-bot"'),
      'code-bot card should be visible again'
    )
    assert(
      elements
        .get('agent-cards')
        .innerHTML.includes('class="ac selected" id="agent-card-code-bot"'),
      'code-bot card should retain .selected class after re-sorting'
    )
  }
)

await testAsync(
  'Renders an accessible no-match empty state with a reset action that restores the catalog',
  async () => {
    const { elements, mod } = await createAgentCatalogHarness()

    mod.selectAgent('analyst-bot')
    const emptyResult = mod.setAgentCatalogControls({
      query: 'nonexistent-quantum-teleportation-xyz',
      status: 'offline',
    })

    assertEqual(emptyResult.length, 0, 'Expected 0 matching agents')
    const cardsHtml = elements.get('agent-cards').innerHTML
    assert(
      cardsHtml.includes('data-empty-state="no-match"'),
      'Expected no-match empty state to be rendered'
    )
    assert(
      cardsHtml.includes('id="agent-empty-reset-btn"'),
      'Expected empty state reset action button to be rendered'
    )
    assert(
      elements.get('agent-results-meta').textContent.includes('Showing 0 of 12 agents'),
      'Results meta should announce 0 of 12 agents'
    )

    // Trigger reset action
    const restored = mod.resetAgentCatalogControls()
    assertEqual(restored.length, 12, 'Reset should restore all 12 catalog agents')
    assertEqual(elements.get('agent-search-input').value, '', 'Search input should be cleared')
    assertEqual(
      elements.get('agent-status-filter').value,
      'all',
      'Status filter should be reset to all'
    )
    assertEqual(
      elements.get('agent-capability-filter').value,
      'all',
      'Capability filter should be reset to all'
    )
    assertEqual(
      elements.get('agent-sort-select').value,
      'default',
      'Sort select should be reset to default'
    )
    assertEqual(
      mod.getSelectedAgentId(),
      'analyst-bot',
      'Resetting filters should preserve selectedAgentId'
    )
  }
)

console.log(`\nResults: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
