/**
 * Bounded Live Event Feed & Controls Tests (issue #171).
 *
 * Replays several thousand fixture events through the SSE feed module,
 * verifies DOM node bounds under default and custom retention limits, and
 * exercises display pause/resume, clear, and event-type filtering.
 *
 * Run: node tests/event-feed.test.js
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

function createFeedDomHarness() {
  const elements = new Map()

  function makeElement(id, tag = 'div') {
    const attrs = new Map()
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      value: '',
      style: { display: '' },
      dataset: {},
      children: [],
      classList: {
        contains(cls) {
          return el.className.split(/\s+/).includes(cls)
        },
        add(cls) {
          if (!this.contains(cls)) el.className = `${el.className} ${cls}`.trim()
        },
        remove(cls) {
          el.className = el.className
            .split(/\s+/)
            .filter((c) => c && c !== cls)
            .join(' ')
        },
      },
      setAttribute(name, val) {
        const str = String(val)
        attrs.set(name, str)
        if (name.startsWith('data-')) {
          const camel = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
          el.dataset[camel] = str
        }
      },
      getAttribute(name) {
        return attrs.has(name) ? attrs.get(name) : null
      },
      prepend(child) {
        el.children.unshift(child)
      },
      appendChild(child) {
        if (!el.children.includes(child)) el.children.push(child)
      },
      removeChild(child) {
        const idx = el.children.indexOf(child)
        if (idx !== -1) el.children.splice(idx, 1)
      },
    }
    if (id) elements.set(id, el)
    return el
  }

  const feedEl = makeElement('feed')
  const emptyEl = makeElement('feed-empty')
  emptyEl.className = 'empty-state'
  feedEl.children.push(emptyEl)

  makeElement('ev-cnt', 'span')
  const pauseBtn = makeElement('feed-pause-btn', 'button')
  pauseBtn.setAttribute('aria-pressed', 'false')
  const pauseBanner = makeElement('feed-pause-banner', 'div')
  pauseBanner.style.display = 'none'
  const filterSelect = makeElement('feed-filter', 'select')
  filterSelect.value = 'all'
  const limitSelect = makeElement('feed-limit', 'select')
  limitSelect.value = '100'

  const trackedEvents = []
  const highlightedAgents = []

  const documentObj = {
    getElementById(id) {
      return elements.get(id) || null
    },
    createElement(tag) {
      return makeElement('', tag)
    },
  }

  const getRenderedFeedItems = () =>
    feedEl.children.filter((c) => c.id !== 'feed-empty' && !c.classList.contains('empty-state'))

  return {
    elements,
    feedEl,
    emptyEl,
    documentObj,
    trackedEvents,
    highlightedAgents,
    getRenderedFeedItems,
  }
}

async function withSseModule(fn) {
  const sourcePath = path.join(__dirname, '..', 'public', 'assets', 'js', 'sse.js')
  const source = await fs.readFile(sourcePath, 'utf8')
  const exportList = [
    'DEFAULT_FEED_MAX_EVENTS',
    'MIN_FEED_MAX_EVENTS',
    'MAX_FEED_MAX_EVENTS',
    'addFeed',
    'renderFeed',
    'setFeedPaused',
    'toggleFeedPause',
    'clearFeed',
    'setFeedFilter',
    'setFeedRetentionLimit',
    'getFeedState',
    'resetFeedStateForTest',
  ].join(', ')

  const tempPath = path.join(
    __dirname,
    `.sse-under-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
  )
  await fs.writeFile(tempPath, `${source}\nexport { ${exportList} }\n`, 'utf8')

  const harness = createFeedDomHarness()
  globalThis.document = harness.documentObj
  globalThis.trackLiveEvent = (ev) => harness.trackedEvents.push(ev)
  globalThis.highlightAgent = (id) => harness.highlightedAgents.push(id)

  try {
    const mod = await import(pathToFileURL(tempPath).href)
    mod.resetFeedStateForTest()
    await fn(mod, harness)
  } finally {
    await fs.unlink(tempPath).catch(() => {})
    delete globalThis.document
    delete globalThis.trackLiveEvent
    delete globalThis.highlightAgent
  }
}

const EVENT_TYPES = [
  'orchestrator_start',
  'orchestrator_plan',
  'agent_call',
  'x402_payment',
  'x402_retry',
  'agent_response',
  'payment',
  'budget_limit',
  'orchestrator_complete',
  'error',
]

function buildFixtureEvent(index) {
  const type = EVENT_TYPES[index % EVENT_TYPES.length]
  return {
    type,
    index,
    task: `Task #${index}`,
    plan: `Plan #${index}`,
    subtaskCount: (index % 4) + 1,
    agent: `Agent-${index}`,
    agentId: `agent-${index % 4}`,
    cost: '0.01',
    amount: '0.01',
    asset: 'USDC',
    currency: 'USDC',
    from: 'Orch',
    to: 'Server',
    method: 'x402',
    remaining: '0.10',
    quotedTotal: '0.05',
    settledSummary: '0.05 USDC',
    agentsUsed: 2,
    elapsed: '1.2s',
    resultPreview: `Result preview #${index}`,
    message: `Error message #${index}`,
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
  }
}

console.log('Bounded Live Event Feed & Controls')

await test('rendered DOM event count remains bounded across 3,000 streamed events', async () => {
  await withSseModule(async (sse, harness) => {
    const totalEvents = 3000
    for (let i = 1; i <= totalEvents; i += 1) {
      sse.addFeed(buildFixtureEvent(i))
      if (i % 500 === 0) {
        const rendered = harness.getRenderedFeedItems()
        assert.ok(
          rendered.length <= sse.DEFAULT_FEED_MAX_EVENTS,
          `DOM node count ${rendered.length} exceeded bound ${sse.DEFAULT_FEED_MAX_EVENTS} at event ${i}`
        )
      }
    }

    const rendered = harness.getRenderedFeedItems()
    assert.strictEqual(rendered.length, sse.DEFAULT_FEED_MAX_EVENTS)

    const state = sse.getFeedState()
    assert.strictEqual(state.totalReceived, 3000)
    assert.strictEqual(state.retainedCount, 100)
    assert.strictEqual(state.visibleCount, 100)

    // Newest event (3000) is first, oldest retained (2901) is last
    assert.strictEqual(rendered[0].getAttribute('data-event-seq'), '3000')
    assert.strictEqual(rendered[rendered.length - 1].getAttribute('data-event-seq'), '2901')
    assert.match(
      harness.elements.get('ev-cnt').textContent,
      /100 shown \(max 100\) · 3000 total Events/
    )

    // Lowering the configurable retention limit trims both retained state and DOM nodes
    sse.setFeedRetentionLimit(50)
    const afterResize = harness.getRenderedFeedItems()
    assert.strictEqual(afterResize.length, 50)
    assert.strictEqual(afterResize[0].getAttribute('data-event-seq'), '3000')
    assert.strictEqual(afterResize[afterResize.length - 1].getAttribute('data-event-seq'), '2951')
  })
})

await test('pausing display does not lose run progress or claim to stop backend execution', async () => {
  await withSseModule(async (sse, harness) => {
    for (let i = 1; i <= 15; i += 1) {
      sse.addFeed(buildFixtureEvent(i))
    }
    assert.strictEqual(harness.getRenderedFeedItems().length, 15)
    assert.strictEqual(harness.trackedEvents.length, 15)

    // Pause display rendering
    sse.toggleFeedPause()
    assert.strictEqual(sse.getFeedState().paused, true)
    assert.strictEqual(harness.elements.get('feed-pause-btn').getAttribute('aria-pressed'), 'true')

    const banner = harness.elements.get('feed-pause-banner')
    assert.strictEqual(banner.style.display, 'block')
    assert.match(banner.textContent, /Feed display paused/i)
    assert.match(banner.textContent, /Server execution and live run progress continue/i)

    // Stream 25 more events while paused
    for (let i = 16; i <= 40; i += 1) {
      sse.addFeed(buildFixtureEvent(i))
    }

    // DOM remains frozen at the 15 pre-pause items (newest visible is seq 15)
    const pausedDom = harness.getRenderedFeedItems()
    assert.strictEqual(pausedDom.length, 15)
    assert.strictEqual(pausedDom[0].getAttribute('data-event-seq'), '15')

    // Run progress (trackLiveEvent) and sidebar highlights were NOT lost while paused
    assert.strictEqual(harness.trackedEvents.length, 40)
    assert.ok(harness.highlightedAgents.length >= 4)
    assert.strictEqual(sse.getFeedState().pausedBufferedCount, 25)
    assert.match(
      harness.elements.get('ev-cnt').textContent,
      /15 shown · paused \+25 · 40 total Events/
    )

    // Resume display rendering: buffered events appear in exact newest-first order
    sse.toggleFeedPause()
    assert.strictEqual(sse.getFeedState().paused, false)
    assert.strictEqual(banner.style.display, 'none')

    const resumedDom = harness.getRenderedFeedItems()
    assert.strictEqual(resumedDom.length, 40)
    assert.strictEqual(resumedDom[0].getAttribute('data-event-seq'), '40')
    assert.strictEqual(resumedDom[resumedDom.length - 1].getAttribute('data-event-seq'), '1')
  })
})

await test('clear resets the visible feed while counters communicate session scope', async () => {
  await withSseModule(async (sse, harness) => {
    for (let i = 1; i <= 25; i += 1) {
      sse.addFeed(buildFixtureEvent(i))
    }
    assert.strictEqual(harness.getRenderedFeedItems().length, 25)

    sse.clearFeed()
    assert.strictEqual(harness.getRenderedFeedItems().length, 0)
    assert.strictEqual(harness.emptyEl.style.display, '')
    assert.match(harness.emptyEl.innerHTML, /Feed cleared \(25 session events received\)/)
    assert.strictEqual(harness.elements.get('ev-cnt').textContent, '0 shown · 25 total Events')

    // Subsequent events append cleanly and counters stay accurate
    sse.addFeed(buildFixtureEvent(26))
    assert.strictEqual(harness.getRenderedFeedItems().length, 1)
    assert.strictEqual(harness.emptyEl.style.display, 'none')
    assert.strictEqual(harness.elements.get('ev-cnt').textContent, '1 shown · 26 total Events')
  })
})

await test('event-type filtering and resuming preserve event ordering within the retained window', async () => {
  await withSseModule(async (sse, harness) => {
    sse.setFeedRetentionLimit(50)
    for (let i = 1; i <= 120; i += 1) {
      sse.addFeed(buildFixtureEvent(i))
    }

    // Retained window holds sequences 71..120
    // Filter by exact type 'payment'
    sse.setFeedFilter('payment')
    const paymentNodes = harness.getRenderedFeedItems()
    assert.ok(paymentNodes.length > 0)
    const paymentSeqs = paymentNodes.map((n) => Number(n.getAttribute('data-event-seq')))

    for (let i = 0; i < paymentNodes.length; i += 1) {
      assert.strictEqual(paymentNodes[i].getAttribute('data-event-type'), 'payment')
      assert.ok(paymentSeqs[i] >= 71 && paymentSeqs[i] <= 120)
      if (i > 0) {
        assert.ok(
          paymentSeqs[i - 1] > paymentSeqs[i],
          `expected descending sequence order, got ${paymentSeqs[i - 1]} before ${paymentSeqs[i]}`
        )
      }
    }
    assert.match(
      harness.elements.get('ev-cnt').textContent,
      new RegExp(`${paymentNodes.length}/50 shown · 120 total Events`)
    )

    // Filter by group 'group:payment' (includes payment, x402_payment, x402_retry)
    sse.setFeedFilter('group:payment')
    const groupNodes = harness.getRenderedFeedItems()
    assert.strictEqual(groupNodes.length, paymentNodes.length * 3)
    const groupSeqs = groupNodes.map((n) => Number(n.getAttribute('data-event-seq')))
    for (let i = 1; i < groupSeqs.length; i += 1) {
      assert.ok(groupSeqs[i - 1] > groupSeqs[i])
    }

    // Pause while filtered, receive more events, then reset filter to 'all' and resume
    sse.setFeedPaused(true)
    for (let i = 121; i <= 130; i += 1) {
      sse.addFeed(buildFixtureEvent(i))
    }
    sse.setFeedFilter('all')
    sse.setFeedPaused(false)

    const allNodes = harness.getRenderedFeedItems()
    assert.strictEqual(allNodes.length, 50)
    assert.strictEqual(allNodes[0].getAttribute('data-event-seq'), '130')
    assert.strictEqual(allNodes[allNodes.length - 1].getAttribute('data-event-seq'), '81')
    for (let i = 1; i < allNodes.length; i += 1) {
      const prev = Number(allNodes[i - 1].getAttribute('data-event-seq'))
      const curr = Number(allNodes[i].getAttribute('data-event-seq'))
      assert.strictEqual(prev - 1, curr)
    }
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`\n${name}:\n${err.stack}`)
  }
  process.exit(1)
}
