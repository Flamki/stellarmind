/**
 * Dashboard Deep Links & Browser Back/Forward Navigation Tests (issue #172).
 *
 * Exercises direct load, refresh, browser back/forward traversal, run detail
 * selection, unknown route fallback, title/active-state updates, and focus
 * restoration across all existing dashboard pages.
 *
 * Run: node tests/dashboard-navigation.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

const ALL_PAGES = ['orchestrator', 'agents', 'status', 'transactions', 'history']

/**
 * Create a realistic in-memory browser harness with DOM elements, History API
 * stack (pushState, replaceState, back, forward), popstate/hashchange events,
 * and focus tracking.
 */
function createBrowserHarness(initialUrl = 'http://localhost:3001/') {
  const elementsById = new Map()
  const pages = []
  const navItems = []
  const historyItems = []
  const windowListeners = new Map()
  let activeElement = null

  function makeClassList(initial = []) {
    const set = new Set(initial)
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const shouldHave = force !== undefined ? Boolean(force) : !set.has(c)
        if (shouldHave) set.add(c)
        else set.delete(c)
        return shouldHave
      },
    }
  }

  function makeElement({ id = '', tag = 'div', classes = [], attrs = {} } = {}) {
    const attrMap = new Map(Object.entries(attrs))
    const listeners = new Map()
    const children = []
    const el = {
      id,
      tagName: tag.toUpperCase(),
      textContent: '',
      innerHTML: '',
      style: { display: attrs.display || '' },
      tabIndex: attrs.tabindex !== undefined ? Number(attrs.tabindex) : -1,
      dataset: {},
      children,
      classList: makeClassList(classes),
      getAttribute: (name) => (attrMap.has(name) ? attrMap.get(name) : null),
      setAttribute: (name, val) => {
        const str = String(val)
        attrMap.set(name, str)
        if (name === 'tabindex') el.tabIndex = Number(val)
        if (name.startsWith('data-')) {
          const camel = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
          el.dataset[camel] = str
        }
      },
      removeAttribute: (name) => {
        attrMap.delete(name)
      },
      addEventListener: (type, handler) => {
        if (!listeners.has(type)) listeners.set(type, [])
        listeners.get(type).push(handler)
      },
      dispatchEvent: (event) => {
        const handlers = listeners.get(event.type) || []
        for (const h of handlers) h(event)
      },
      focus: () => {
        activeElement = el
      },
      querySelector: (selector) => {
        if (selector.includes('h2') || selector.includes('h1')) {
          return children.find((c) => c.tagName === 'H2' || c.tagName === 'H1') || null
        }
        return children[0] || null
      },
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
        el.dataset[camel] = String(v)
      }
    }
    if (id) elementsById.set(id, el)
    return el
  }

  // Create page sections and sidebar items for all 5 pages
  for (const pageId of ALL_PAGES) {
    const isDefault = pageId === 'orchestrator'
    const pageEl = makeElement({
      id: `page-${pageId}`,
      classes: isDefault ? ['page', 'active'] : ['page'],
    })
    const heading = makeElement({
      id: `heading-${pageId}`,
      tag: 'h2',
    })
    heading.textContent = `Heading ${pageId}`
    pageEl.children.push(heading)
    pages.push(pageEl)

    const navEl = makeElement({
      id: `nav-${pageId}`,
      classes: isDefault ? ['sb-item', 'active'] : ['sb-item'],
      attrs: { 'data-page': pageId },
    })
    navItems.push(navEl)
  }

  // Topbar, live region, task input, and run detail modal
  makeElement({ id: 'topbar-title' })
  makeElement({ id: 'aria-live-region' })
  makeElement({ id: 'task-input', tag: 'input' })
  makeElement({ id: 'history-detail-modal', attrs: { display: 'none', tabindex: '-1' } })

  // Create fixture history items
  for (const runId of ['run-alpha', 'run-beta']) {
    const item = makeElement({
      id: `history-item-${runId}`,
      classes: ['history-item'],
      attrs: { 'data-run-id': runId, tabindex: '0', role: 'button' },
    })
    historyItems.push(item)
  }

  // History stack and Location simulation
  const parsedInit = new URL(initialUrl, 'http://localhost:3001')
  const historyStack = [
    {
      url: parsedInit.href,
      hash: parsedInit.hash,
      search: parsedInit.search,
      pathname: parsedInit.pathname,
      state: null,
      title: 'StellarMind — AI Agent Marketplace',
    },
  ]
  let historyIndex = 0

  const location = {
    get href() {
      return historyStack[historyIndex].url
    },
    get hash() {
      return historyStack[historyIndex].hash
    },
    set hash(newHash) {
      const normalized = newHash.startsWith('#') ? newHash : `#${newHash}`
      const nextUrl = new URL(normalized, historyStack[historyIndex].url)
      historyStack.splice(historyIndex + 1)
      historyStack.push({
        url: nextUrl.href,
        hash: nextUrl.hash,
        search: nextUrl.search,
        pathname: nextUrl.pathname,
        state: null,
        title: documentObj.title,
      })
      historyIndex = historyStack.length - 1
      emitWindowEvent('hashchange', { type: 'hashchange' })
    },
    get search() {
      return historyStack[historyIndex].search
    },
    get pathname() {
      return historyStack[historyIndex].pathname
    },
  }

  function applyUrlToEntry(urlArg) {
    const base = historyStack[historyIndex].url
    const resolved = new URL(urlArg || base, base)
    return {
      url: resolved.href,
      hash: resolved.hash,
      search: resolved.search,
      pathname: resolved.pathname,
    }
  }

  const history = {
    get state() {
      return historyStack[historyIndex].state
    },
    get length() {
      return historyStack.length
    },
    pushState(state, title, url) {
      const target = applyUrlToEntry(url)
      historyStack.splice(historyIndex + 1)
      historyStack.push({
        ...target,
        state: state ? structuredClone(state) : null,
        title: title || documentObj.title,
      })
      historyIndex = historyStack.length - 1
    },
    replaceState(state, title, url) {
      const target = applyUrlToEntry(url)
      historyStack[historyIndex] = {
        ...target,
        state: state ? structuredClone(state) : null,
        title: title || documentObj.title,
      }
    },
    back() {
      if (historyIndex <= 0) return false
      historyIndex -= 1
      emitWindowEvent('popstate', {
        type: 'popstate',
        state: historyStack[historyIndex].state,
      })
      return true
    },
    forward() {
      if (historyIndex >= historyStack.length - 1) return false
      historyIndex += 1
      emitWindowEvent('popstate', {
        type: 'popstate',
        state: historyStack[historyIndex].state,
      })
      return true
    },
  }

  function emitWindowEvent(type, event) {
    const handlers = windowListeners.get(type) || []
    for (const handler of handlers) {
      handler(event)
    }
  }

  const documentObj = {
    title: 'StellarMind — AI Agent Marketplace',
    readyState: 'complete',
    get activeElement() {
      return activeElement
    },
    getElementById(id) {
      return elementsById.get(id) || null
    },
    querySelector(selector) {
      const match = selector.match(/^\.sb-item\[data-page="([^"]+)"\]$/)
      if (match) {
        return navItems.find((n) => n.getAttribute('data-page') === match[1]) || null
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector === '.page') return pages
      if (selector === '.sb-item' || selector === '.sb-item[data-page]') return navItems
      if (selector === '.history-item') return historyItems
      return []
    },
    addEventListener() {},
  }

  const windowObj = {
    location,
    history,
    document: documentObj,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(handler)
    },
  }

  const loaderCalls = {
    agents: 0,
    status: 0,
    transactions: 0,
    history: 0,
    openRunDetail: [],
    closeRunDetail: 0,
  }

  return {
    windowObj,
    documentObj,
    location,
    history,
    historyStack,
    elementsById,
    pages,
    navItems,
    historyItems,
    loaderCalls,
    getActiveElement: () => activeElement,
  }
}

async function withNavigationEnvironment(initialUrl, fn) {
  const navPath = path.join(__dirname, '..', 'public', 'assets', 'js', 'navigation.js')
  const initPath = path.join(__dirname, '..', 'public', 'assets', 'js', 'init.js')
  const navSource = await fs.readFile(navPath, 'utf8')
  const initSource = await fs.readFile(initPath, 'utf8')

  const exportList = [
    'DEFAULT_PAGE',
    'pageTitles',
    'normalizePageId',
    'parseDashboardRoute',
    'buildDashboardUrl',
    'formatDocumentTitle',
    'showPage',
    'syncRunDetailRoute',
    'handleLocationChange',
    'initNavigation',
    'initApp',
  ].join(', ')

  const tempPath = path.join(
    __dirname,
    `.nav-under-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  )
  await fs.writeFile(
    tempPath,
    `${navSource}\n${initSource.replace(/if \(document\.readyState[\s\S]*$/, '')}\nexport { ${exportList} }\n`,
    'utf8'
  )

  const harness = createBrowserHarness(initialUrl)

  globalThis.window = harness.windowObj
  globalThis.document = harness.documentObj
  globalThis.initBudgetSlider = () => {}
  globalThis.loadAgents = () => {}
  globalThis.loadWallets = () => {}
  globalThis.connectSSE = () => {}
  globalThis.setInterval = () => 1
  globalThis.loadAgentPage = () => {
    harness.loaderCalls.agents += 1
  }
  globalThis.loadStatusPage = () => {
    harness.loaderCalls.status += 1
  }
  globalThis.loadTxPage = () => {
    harness.loaderCalls.transactions += 1
  }
  globalThis.loadHistoryPage = () => {
    harness.loaderCalls.history += 1
    return Promise.resolve()
  }

  const baseOpenRunDetail = async (runId) => {
    harness.loaderCalls.openRunDetail.push(runId)
    const modal = harness.documentObj.getElementById('history-detail-modal')
    if (modal) modal.style.display = 'flex'
  }
  const baseCloseRunDetail = () => {
    harness.loaderCalls.closeRunDetail += 1
    const modal = harness.documentObj.getElementById('history-detail-modal')
    if (modal) modal.style.display = 'none'
  }

  globalThis.openRunDetail = baseOpenRunDetail
  globalThis.closeRunDetail = baseCloseRunDetail
  harness.windowObj.openRunDetail = baseOpenRunDetail
  harness.windowObj.closeRunDetail = baseCloseRunDetail

  try {
    const mod = await import(pathToFileURL(tempPath).href)
    globalThis.initNavigation = mod.initNavigation
    globalThis.showPage = mod.showPage
    await fn(mod, harness)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
    delete globalThis.window
    delete globalThis.document
    delete globalThis.initBudgetSlider
    delete globalThis.loadAgents
    delete globalThis.loadWallets
    delete globalThis.connectSSE
    delete globalThis.loadAgentPage
    delete globalThis.loadStatusPage
    delete globalThis.loadTxPage
    delete globalThis.loadHistoryPage
    delete globalThis.openRunDetail
    delete globalThis.closeRunDetail
    delete globalThis.initNavigation
    delete globalThis.showPage
  }
}

console.log('Dashboard Deep Links & Browser History Navigation')

await test('direct load of copied URL opens each dashboard page on fresh load', async () => {
  for (const pageId of ALL_PAGES) {
    await withNavigationEnvironment(`http://localhost:3001/#${pageId}`, async (nav, harness) => {
      nav.initNavigation()

      const pageEl = harness.elementsById.get(`page-${pageId}`)
      const navEl = harness.elementsById.get(`nav-${pageId}`)
      assert.strictEqual(
        pageEl.classList.contains('active'),
        true,
        `expected #page-${pageId} to be active`
      )
      assert.strictEqual(pageEl.getAttribute('aria-hidden'), 'false')
      assert.strictEqual(
        navEl.classList.contains('active'),
        true,
        `expected sidebar item for ${pageId} to be active`
      )
      assert.strictEqual(navEl.getAttribute('aria-current'), 'page')
      assert.strictEqual(
        harness.elementsById.get('topbar-title').textContent,
        nav.pageTitles[pageId]
      )
      assert.match(harness.documentObj.title, new RegExp(`^${nav.pageTitles[pageId]} — `))
      assert.strictEqual(harness.location.hash, `#${pageId}`)

      // Every other page is inactive
      for (const otherId of ALL_PAGES.filter((p) => p !== pageId)) {
        assert.strictEqual(
          harness.elementsById.get(`page-${otherId}`).classList.contains('active'),
          false
        )
        assert.strictEqual(
          harness.elementsById.get(`nav-${otherId}`).getAttribute('aria-current'),
          null
        )
      }
    })
  }
})

await test('direct load supports query-param and slash-hash deep links and run detail deep links', async () => {
  await withNavigationEnvironment('http://localhost:3001/?page=status', async (nav, harness) => {
    nav.initNavigation()
    assert.strictEqual(harness.elementsById.get('page-status').classList.contains('active'), true)
    assert.strictEqual(harness.loaderCalls.status, 1)
  })

  await withNavigationEnvironment(
    'http://localhost:3001/#/history/run-alpha',
    async (nav, harness) => {
      nav.initNavigation()
      assert.strictEqual(
        harness.elementsById.get('page-history').classList.contains('active'),
        true
      )
      assert.strictEqual(harness.loaderCalls.history, 1)
      assert.deepStrictEqual(harness.loaderCalls.openRunDetail, ['run-alpha'])
      assert.strictEqual(harness.elementsById.get('history-detail-modal').style.display, 'flex')
      assert.strictEqual(
        harness.elementsById.get('history-item-run-alpha').classList.contains('selected'),
        true
      )
      assert.match(harness.documentObj.title, /Run History \(run-alpha\)/)
    }
  )
})

await test('refresh restores the active page and run detail selection from the URL', async () => {
  await withNavigationEnvironment('http://localhost:3001/', async (nav, harness) => {
    nav.initNavigation()
    nav.showPage('transactions')
    const copiedUrl = harness.location.href
    assert.strictEqual(copiedUrl, 'http://localhost:3001/#transactions')

    // Simulate page refresh using the current URL
    await withNavigationEnvironment(copiedUrl, async (freshNav, freshHarness) => {
      freshNav.initNavigation()
      assert.strictEqual(
        freshHarness.elementsById.get('page-transactions').classList.contains('active'),
        true
      )
      assert.strictEqual(freshHarness.loaderCalls.transactions, 1)
      assert.strictEqual(freshHarness.elementsById.get('topbar-title').textContent, 'Transactions')
    })
  })
})

await test('browser back and forward restore prior pages and run detail selection', async () => {
  await withNavigationEnvironment('http://localhost:3001/', async (nav, harness) => {
    nav.initNavigation()
    assert.strictEqual(harness.location.hash, '#orchestrator')

    // Navigate through pages: orchestrator -> agents -> status -> history -> run detail
    nav.showPage('agents')
    assert.strictEqual(harness.location.hash, '#agents')
    assert.strictEqual(harness.elementsById.get('page-agents').classList.contains('active'), true)

    nav.showPage('status')
    assert.strictEqual(harness.location.hash, '#status')
    assert.strictEqual(harness.elementsById.get('page-status').classList.contains('active'), true)

    nav.showPage('history')
    assert.strictEqual(harness.location.hash, '#history')
    assert.strictEqual(harness.elementsById.get('page-history').classList.contains('active'), true)

    // Open a run detail via wrapped openRunDetail
    await harness.windowObj.openRunDetail('run-beta')
    assert.strictEqual(harness.location.hash, '#history/run-beta')
    assert.strictEqual(harness.elementsById.get('history-detail-modal').style.display, 'flex')
    assert.strictEqual(
      harness.elementsById.get('history-item-run-beta').classList.contains('selected'),
      true
    )

    // Back 1: closes run detail, stays on history page
    harness.history.back()
    assert.strictEqual(harness.location.hash, '#history')
    assert.strictEqual(harness.elementsById.get('page-history').classList.contains('active'), true)
    assert.strictEqual(harness.elementsById.get('history-detail-modal').style.display, 'none')
    assert.strictEqual(
      harness.elementsById.get('history-item-run-beta').classList.contains('selected'),
      false
    )

    // Back 2: returns to status page
    harness.history.back()
    assert.strictEqual(harness.location.hash, '#status')
    assert.strictEqual(harness.elementsById.get('page-status').classList.contains('active'), true)
    assert.strictEqual(harness.elementsById.get('topbar-title').textContent, 'API Status')

    // Back 3: returns to agents page
    harness.history.back()
    assert.strictEqual(harness.location.hash, '#agents')
    assert.strictEqual(harness.elementsById.get('page-agents').classList.contains('active'), true)

    // Back 4: returns to orchestrator page
    harness.history.back()
    assert.strictEqual(harness.location.hash, '#orchestrator')
    assert.strictEqual(
      harness.elementsById.get('page-orchestrator').classList.contains('active'),
      true
    )

    // Forward traversal restores agents -> status -> history -> history/run-beta
    harness.history.forward()
    assert.strictEqual(harness.location.hash, '#agents')
    assert.strictEqual(harness.elementsById.get('page-agents').classList.contains('active'), true)

    harness.history.forward()
    assert.strictEqual(harness.location.hash, '#status')
    assert.strictEqual(harness.elementsById.get('page-status').classList.contains('active'), true)

    harness.history.forward()
    assert.strictEqual(harness.location.hash, '#history')
    assert.strictEqual(harness.elementsById.get('page-history').classList.contains('active'), true)

    harness.history.forward()
    assert.strictEqual(harness.location.hash, '#history/run-beta')
    assert.strictEqual(harness.elementsById.get('history-detail-modal').style.display, 'flex')
    assert.strictEqual(
      harness.elementsById.get('history-item-run-beta').classList.contains('selected'),
      true
    )
  })
})

await test('unknown routes fall back to orchestrator without throwing and canonicalize the URL', async () => {
  const unknownUrls = [
    'http://localhost:3001/#unknown-route',
    'http://localhost:3001/#/does-not-exist/extra',
    'http://localhost:3001/?page=nonexistent',
    'http://localhost:3001/invalid-path',
    'http://localhost:3001/#agents/extra-segment',
    'http://localhost:3001/#%E0%A4%A',
  ]

  for (const badUrl of unknownUrls) {
    await withNavigationEnvironment(badUrl, async (nav, harness) => {
      assert.doesNotThrow(() => {
        nav.initNavigation()
      })
      assert.strictEqual(
        harness.elementsById.get('page-orchestrator').classList.contains('active'),
        true,
        `expected fallback to orchestrator for ${badUrl}`
      )
      assert.strictEqual(harness.location.hash, '#orchestrator')
      assert.strictEqual(harness.elementsById.get('topbar-title').textContent, 'Task Orchestrator')
    })
  }

  // Calling showPage directly with invalid inputs also falls back safely
  await withNavigationEnvironment('http://localhost:3001/', async (nav, harness) => {
    nav.initNavigation()
    for (const invalidInput of ['unknown', '', null, undefined, 42, {}]) {
      assert.doesNotThrow(() => {
        const res = nav.showPage(invalidInput)
        assert.strictEqual(res.page, 'orchestrator')
      })
      assert.strictEqual(
        harness.elementsById.get('page-orchestrator').classList.contains('active'),
        true
      )
    }
  })
})

await test('navigation updates title, active state, aria-live region, and focus appropriately', async () => {
  await withNavigationEnvironment('http://localhost:3001/', async (nav, harness) => {
    nav.initNavigation()

    nav.showPage('agents')
    assert.strictEqual(
      harness.documentObj.title,
      'Agent Registry — StellarMind — AI Agent Marketplace'
    )
    assert.strictEqual(
      harness.elementsById.get('aria-live-region').textContent,
      'Agent Registry page active'
    )
    assert.strictEqual(harness.getActiveElement(), harness.elementsById.get('heading-agents'))

    // Keyboard Enter/Space on sidebar item navigates and moves focus
    const txNav = harness.elementsById.get('nav-transactions')
    txNav.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault() {},
    })
    assert.strictEqual(
      harness.elementsById.get('page-transactions').classList.contains('active'),
      true
    )
    assert.strictEqual(harness.getActiveElement(), harness.elementsById.get('heading-transactions'))

    // Opening and closing run detail manages focus between modal and triggering history item
    nav.showPage('history')
    await harness.windowObj.openRunDetail('run-alpha')
    assert.strictEqual(harness.getActiveElement(), harness.elementsById.get('history-detail-modal'))

    harness.windowObj.closeRunDetail()
    assert.strictEqual(harness.location.hash, '#history')
    assert.strictEqual(
      harness.getActiveElement(),
      harness.elementsById.get('history-item-run-alpha')
    )
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n${name}:\n${err.stack}`)
  }
  process.exit(1)
}
