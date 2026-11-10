/**
 * Navigation Module
 * Handles page switching, deep-link routing, browser back/forward history,
 * run detail selection state, and accessible focus management.
 */

const DEFAULT_PAGE = 'orchestrator'
const BASE_DOCUMENT_TITLE = 'StellarMind — AI Agent Marketplace'

const pageTitles = {
  orchestrator: 'Task Orchestrator',
  agents: 'Agent Registry',
  status: 'API Status',
  transactions: 'Transactions',
  history: 'Run History',
}

let activeRunDetailId = null
let navigationInitialized = false
let suppressHashChange = false

/**
 * Normalize a candidate page identifier to a known dashboard page.
 * Unknown or empty identifiers safely fall back to DEFAULT_PAGE.
 */
function normalizePageId(id) {
  if (typeof id !== 'string') {
    return { page: DEFAULT_PAGE, isKnown: false, rawPage: id }
  }
  const cleaned = id.trim().toLowerCase().replace(/^#\/?/, '').replace(/^\/+/, '')
  if (!cleaned) {
    return { page: DEFAULT_PAGE, isKnown: true, rawPage: '' }
  }
  if (Object.prototype.hasOwnProperty.call(pageTitles, cleaned)) {
    return { page: cleaned, isKnown: true, rawPage: cleaned }
  }
  return { page: DEFAULT_PAGE, isKnown: false, rawPage: cleaned }
}

function safeDecode(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parse a location object, URL string, or hash/search fragment into a normalized
 * dashboard route `{ page, runId, isKnown, rawPage }`.
 */
function parseDashboardRoute(locationInput) {
  const loc =
    locationInput !== undefined
      ? locationInput
      : typeof window !== 'undefined' && window.location
        ? window.location
        : { hash: '', search: '', pathname: '/' }

  let hash = ''
  let search = ''
  let pathname = '/'

  if (typeof loc === 'string') {
    const trimmed = loc.trim()
    if (trimmed.startsWith('#')) {
      hash = trimmed
    } else if (trimmed.startsWith('?')) {
      search = trimmed
    } else {
      try {
        const parsed = new URL(trimmed, 'http://localhost')
        hash = parsed.hash || ''
        search = parsed.search || ''
        pathname = parsed.pathname || '/'
      } catch {
        hash = trimmed
      }
    }
  } else if (loc && typeof loc === 'object') {
    hash = typeof loc.hash === 'string' ? loc.hash : ''
    search = typeof loc.search === 'string' ? loc.search : ''
    pathname = typeof loc.pathname === 'string' ? loc.pathname : '/'
  }

  const rawHash = hash.replace(/^#/, '').trim()
  if (rawHash) {
    if (rawHash.includes('=') && !rawHash.startsWith('/')) {
      const [hashPath, hashQuery] = rawHash.split('?')
      const params = new URLSearchParams(hashQuery !== undefined ? hashQuery : hashPath)
      const pageParam = params.get('page') || (hashQuery !== undefined ? hashPath : '')
      const runParam = params.get('run') || params.get('runId') || null
      const norm = normalizePageId(safeDecode(pageParam))
      return {
        page: norm.page,
        runId: norm.isKnown && norm.page === 'history' && runParam ? String(runParam).trim() : null,
        isKnown: norm.isKnown,
        rawPage: norm.rawPage,
      }
    }

    const [pathPart, queryPart = ''] = rawHash.replace(/^\/+/, '').split('?')
    const segments = pathPart
      .split('/')
      .map((s) => safeDecode(s).trim())
      .filter(Boolean)
    const candidatePage = segments[0] || ''
    const norm = normalizePageId(candidatePage)
    const queryParams = queryPart ? new URLSearchParams(queryPart) : null
    const runFromPath = segments.length > 1 ? segments.slice(1).join('/') : null
    const runFromQuery = queryParams ? queryParams.get('run') || queryParams.get('runId') : null
    const rawRunId = runFromPath || runFromQuery || null

    if (!norm.isKnown) {
      return { page: DEFAULT_PAGE, runId: null, isKnown: false, rawPage: norm.rawPage }
    }
    if (norm.page !== 'history' && segments.length > 1) {
      return { page: DEFAULT_PAGE, runId: null, isKnown: false, rawPage: pathPart }
    }
    return {
      page: norm.page,
      runId: norm.page === 'history' && rawRunId ? String(rawRunId).trim() : null,
      isKnown: true,
      rawPage: norm.rawPage,
    }
  }

  const rawSearch = search.replace(/^\?/, '').trim()
  if (rawSearch) {
    const params = new URLSearchParams(rawSearch)
    if (params.has('page') || params.has('run') || params.has('runId')) {
      const pageCandidate = params.get('page') || (params.has('run') ? 'history' : '')
      const runCandidate = params.get('run') || params.get('runId') || null
      const norm = normalizePageId(safeDecode(pageCandidate))
      return {
        page: norm.page,
        runId:
          norm.isKnown && norm.page === 'history' && runCandidate
            ? String(runCandidate).trim()
            : null,
        isKnown: norm.isKnown,
        rawPage: norm.rawPage,
      }
    }
  }

  const cleanPath = pathname.replace(/^\/+|\/+$/g, '')
  if (cleanPath && cleanPath !== 'index.html') {
    const segments = cleanPath
      .split('/')
      .map((s) => safeDecode(s).trim())
      .filter(Boolean)
    const norm = normalizePageId(segments[0] || '')
    const runFromPath = segments.length > 1 ? segments.slice(1).join('/') : null
    if (!norm.isKnown || (norm.page !== 'history' && segments.length > 1)) {
      return { page: DEFAULT_PAGE, runId: null, isKnown: false, rawPage: cleanPath }
    }
    return {
      page: norm.page,
      runId: norm.page === 'history' && runFromPath ? runFromPath : null,
      isKnown: true,
      rawPage: norm.rawPage,
    }
  }

  return { page: DEFAULT_PAGE, runId: null, isKnown: true, rawPage: DEFAULT_PAGE }
}

/**
 * Build a canonical hash URL for a dashboard page and optional run detail ID.
 */
function buildDashboardUrl(page, options = {}) {
  const { page: resolvedPage } = normalizePageId(page)
  const runId =
    resolvedPage === 'history' && options && options.runId ? String(options.runId).trim() : null
  if (resolvedPage === 'history' && runId) {
    return `#history/${encodeURIComponent(runId)}`
  }
  return `#${resolvedPage}`
}

/**
 * Format the document title for the active dashboard page and optional run detail.
 */
function formatDocumentTitle(pageId, options = {}) {
  const { page: resolvedPage } = normalizePageId(pageId)
  const pageTitle = pageTitles[resolvedPage] || pageTitles[DEFAULT_PAGE]
  const runId =
    resolvedPage === 'history' && options && options.runId ? String(options.runId).trim() : null
  if (runId) {
    return `${pageTitle} (${runId}) — ${BASE_DOCUMENT_TITLE}`
  }
  return `${pageTitle} — ${BASE_DOCUMENT_TITLE}`
}

function updateHistorySelectionAttribute(runId) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return
  document.querySelectorAll('.history-item').forEach((item) => {
    const itemRunId = item.getAttribute ? item.getAttribute('data-run-id') : item.dataset?.runId
    const isSelected = Boolean(runId && itemRunId === String(runId))
    if (item.classList) {
      if (isSelected) item.classList.add('selected')
      else item.classList.remove('selected')
    }
    if (item.setAttribute) {
      item.setAttribute('aria-current', isSelected ? 'true' : 'false')
    }
  })
}

function focusPageTarget(pageId, options = {}) {
  if (typeof document === 'undefined') return
  const { runId, restoreRunId } = options

  if (runId) {
    const modal = document.getElementById('history-detail-modal')
    if (modal && typeof modal.focus === 'function') {
      modal.focus({ preventScroll: true })
      return
    }
  }

  if (restoreRunId && document.querySelectorAll) {
    let matchedItem = null
    document.querySelectorAll('.history-item').forEach((item) => {
      const idAttr = item.getAttribute ? item.getAttribute('data-run-id') : item.dataset?.runId
      if (idAttr === String(restoreRunId)) matchedItem = item
    })
    if (matchedItem && typeof matchedItem.focus === 'function') {
      matchedItem.focus({ preventScroll: true })
      return
    }
  }

  const pageEl = document.getElementById(`page-${pageId}`)
  const heading =
    (pageEl && pageEl.querySelector && pageEl.querySelector('h2, h1, [data-page-focus]')) ||
    pageEl ||
    document.getElementById('topbar-title')

  if (heading) {
    if (
      heading.getAttribute &&
      !heading.getAttribute('tabindex') &&
      heading.tabIndex !== undefined &&
      heading.tabIndex < 0
    ) {
      if (heading.setAttribute) heading.setAttribute('tabindex', '-1')
      heading.tabIndex = -1
    } else if (heading.setAttribute && !heading.getAttribute('tabindex')) {
      heading.setAttribute('tabindex', '-1')
    }
    if (typeof heading.focus === 'function') {
      heading.focus({ preventScroll: true })
    }
  }
}

function announceNavigation(pageId, runId) {
  if (typeof document === 'undefined') return
  const liveRegion = document.getElementById('aria-live-region')
  if (!liveRegion) return
  const title = pageTitles[pageId] || pageTitles[DEFAULT_PAGE]
  liveRegion.textContent = runId ? `${title}: viewing run ${runId}` : `${title} page active`
}

function writeHistoryState(state, title, url, replace = false) {
  if (typeof window === 'undefined') return
  const currentHash = window.location?.hash || ''
  const shouldReplace = replace || currentHash === url

  if (window.history) {
    const method = shouldReplace ? 'replaceState' : 'pushState'
    if (typeof window.history[method] === 'function') {
      suppressHashChange = true
      try {
        window.history[method](state, title, url)
      } finally {
        suppressHashChange = false
      }
      return
    }
  }

  if (window.location && window.location.hash !== url) {
    suppressHashChange = true
    window.location.hash = url
    suppressHashChange = false
  }
}

/**
 * Switch the active dashboard page, update sidebar and document state,
 * trigger page data loaders, and synchronize browser history.
 */
function showPage(id, options = {}) {
  const { page: resolvedId, isKnown } = normalizePageId(id)
  const runId =
    resolvedId === 'history' && options && options.runId ? String(options.runId).trim() : null
  const updateHistory = options.updateHistory !== false
  const replaceHistory = Boolean(options.replace) || !isKnown
  const manageFocus = options.manageFocus !== false

  if (typeof document !== 'undefined') {
    // Hide all pages and reveal the resolved page
    if (document.querySelectorAll) {
      document.querySelectorAll('.page').forEach((p) => {
        p.classList.remove('active')
        if (p.setAttribute) p.setAttribute('aria-hidden', 'true')
      })
    }
    const targetPage = document.getElementById(`page-${resolvedId}`)
    if (targetPage) {
      targetPage.classList.add('active')
      if (targetPage.setAttribute) targetPage.setAttribute('aria-hidden', 'false')
    }

    // Update sidebar active state and aria-current
    if (document.querySelectorAll) {
      document.querySelectorAll('.sb-item').forEach((item) => {
        item.classList.remove('active')
        if (item.removeAttribute) item.removeAttribute('aria-current')
      })
    }
    const activeNav = document.querySelector
      ? document.querySelector(`.sb-item[data-page="${resolvedId}"]`)
      : null
    if (activeNav) {
      activeNav.classList.add('active')
      if (activeNav.setAttribute) activeNav.setAttribute('aria-current', 'page')
    }

    // Update topbar title and document title
    const topbarTitle = document.getElementById('topbar-title')
    if (topbarTitle) {
      topbarTitle.textContent = pageTitles[resolvedId] || resolvedId
    }
    document.title = formatDocumentTitle(resolvedId, { runId })
  }

  if (updateHistory) {
    const targetUrl = buildDashboardUrl(resolvedId, { runId })
    const state = { page: resolvedId, runId }
    writeHistoryState(state, formatDocumentTitle(resolvedId, { runId }), targetUrl, replaceHistory)
  }

  // Load page-specific data
  if (resolvedId === 'agents' && typeof loadAgentPage === 'function') loadAgentPage()
  if (resolvedId === 'status' && typeof loadStatusPage === 'function') loadStatusPage()
  if (resolvedId === 'transactions' && typeof loadTxPage === 'function') loadTxPage()
  if (resolvedId === 'history' && typeof loadHistoryPage === 'function') {
    const maybePromise = loadHistoryPage()
    if (runId && maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(() => updateHistorySelectionAttribute(runId)).catch(() => {})
    }
  }

  // Synchronize run detail modal state
  const previousRunId = activeRunDetailId
  activeRunDetailId = runId
  updateHistorySelectionAttribute(runId)

  if (resolvedId === 'history' && runId) {
    if (typeof openRunDetail === 'function') {
      openRunDetail(runId, { updateHistory: false, fromRouter: true })
    }
  } else {
    const modal =
      typeof document !== 'undefined' ? document.getElementById('history-detail-modal') : null
    if (modal && modal.style && modal.style.display && modal.style.display !== 'none') {
      if (typeof closeRunDetail === 'function') {
        closeRunDetail({ updateHistory: false, fromRouter: true })
      } else {
        modal.style.display = 'none'
      }
    }
  }

  announceNavigation(resolvedId, runId)

  if (manageFocus) {
    focusPageTarget(resolvedId, {
      runId,
      restoreRunId: !runId && previousRunId ? previousRunId : null,
    })
  }

  return { page: resolvedId, runId, isKnown }
}

/**
 * Synchronize URL and history state when opening or closing a run detail view.
 */
function syncRunDetailRoute(runId, options = {}) {
  const cleanRunId = runId ? String(runId).trim() : null
  const previousRunId = activeRunDetailId
  activeRunDetailId = cleanRunId
  updateHistorySelectionAttribute(cleanRunId)

  if (typeof document !== 'undefined') {
    document.title = formatDocumentTitle('history', { runId: cleanRunId })
  }

  if (options.updateHistory !== false) {
    const targetUrl = buildDashboardUrl('history', { runId: cleanRunId })
    const state = { page: 'history', runId: cleanRunId }
    writeHistoryState(
      state,
      formatDocumentTitle('history', { runId: cleanRunId }),
      targetUrl,
      Boolean(options.replace)
    )
  }

  announceNavigation('history', cleanRunId)

  if (options.manageFocus !== false) {
    focusPageTarget('history', {
      runId: cleanRunId,
      restoreRunId: !cleanRunId && previousRunId ? previousRunId : null,
    })
  }
}

/**
 * Apply the current browser URL or history state to the dashboard.
 */
function handleLocationChange(options = {}) {
  const state = options.state && typeof options.state === 'object' ? options.state : null
  const parsed = parseDashboardRoute(options.location)

  const page = state && state.page ? normalizePageId(state.page).page : parsed.page
  const isKnown = state && state.page ? normalizePageId(state.page).isKnown : parsed.isKnown
  const runId =
    page === 'history' ? (state && state.runId !== undefined ? state.runId : parsed.runId) : null

  return showPage(page, {
    runId,
    // Replace history on initial load or when canonicalizing an unknown route,
    // without pushing a duplicate entry during popstate/hashchange traversal.
    updateHistory: Boolean(options.initial) || !isKnown,
    replace: true,
    manageFocus: options.manageFocus !== false,
  })
}

function wrapRunDetailHandlers() {
  const scope = typeof window !== 'undefined' ? window : globalThis
  if (!scope) return

  if (typeof scope.openRunDetail === 'function' && !scope.openRunDetail._routedWrapper) {
    const originalOpen = scope.openRunDetail
    const wrappedOpen = async function (runId, options = {}) {
      const cleanRunId = runId ? String(runId).trim() : null
      if (!options || !options.fromRouter) {
        const currentPageEl =
          typeof document !== 'undefined' ? document.getElementById('page-history') : null
        if (currentPageEl && !currentPageEl.classList.contains('active')) {
          showPage('history', {
            runId: cleanRunId,
            updateHistory: options?.updateHistory !== false,
            replace: Boolean(options?.replace),
            manageFocus: false,
          })
          return
        }
        syncRunDetailRoute(cleanRunId, {
          updateHistory: options?.updateHistory !== false,
          replace: Boolean(options?.replace),
          manageFocus: false,
        })
      }
      const result = await originalOpen.call(this, cleanRunId)
      if (options?.manageFocus !== false) {
        focusPageTarget('history', { runId: cleanRunId })
      }
      return result
    }
    wrappedOpen._routedWrapper = true
    scope.openRunDetail = wrappedOpen
  }

  if (typeof scope.closeRunDetail === 'function' && !scope.closeRunDetail._routedWrapper) {
    const originalClose = scope.closeRunDetail
    const wrappedClose = function (options = {}) {
      const previousRunId = activeRunDetailId
      const result = originalClose.call(this)
      if (!options || !options.fromRouter) {
        syncRunDetailRoute(null, {
          updateHistory: options?.updateHistory !== false,
          replace: Boolean(options?.replace),
          manageFocus: options?.manageFocus !== false,
        })
      } else if (previousRunId && options?.manageFocus !== false) {
        focusPageTarget('history', { restoreRunId: previousRunId })
      }
      return result
    }
    wrappedClose._routedWrapper = true
    scope.closeRunDetail = wrappedClose
  }
}

/**
 * Initialize dashboard navigation, keyboard sidebar controls, and history listeners.
 */
function initNavigation() {
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    document.querySelectorAll('.sb-item[data-page]').forEach((item) => {
      if (item.setAttribute) {
        if (!item.getAttribute('role')) item.setAttribute('role', 'button')
        if (!item.getAttribute('tabindex')) item.setAttribute('tabindex', '0')
      }
      if (!item._navKeyHandlerBound && item.addEventListener) {
        item._navKeyHandlerBound = true
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            const targetPage = item.getAttribute
              ? item.getAttribute('data-page')
              : item.dataset?.page
            if (targetPage) showPage(targetPage)
          }
        })
      }
    })
  }

  wrapRunDetailHandlers()

  if (typeof window !== 'undefined' && !navigationInitialized) {
    navigationInitialized = true

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('popstate', (event) => {
        handleLocationChange({
          state: event && event.state ? event.state : null,
          manageFocus: true,
        })
      })

      window.addEventListener('hashchange', () => {
        if (suppressHashChange) return
        handleLocationChange({ manageFocus: true })
      })
    }
  }

  return handleLocationChange({ initial: true, manageFocus: false })
}
