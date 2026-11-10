/**
 * Tests for Issue #159: Expose complete transaction operations with explicit pagination.
 *
 * Covers:
 * - Transactions with 0, 1, 10, and >10 (15, 25) operations
 * - Explicit completeness flags and continuation pagination cursors/URLs
 * - Operation ordering preservation and deduplication across paginated requests
 * - Accurate representation of operation count, asset, direction, and transaction success status
 * - HTTP endpoints: GET /api/wallet/transactions, GET /api/wallet/transactions/:hash/operations, GET /api/wallet/transactions/:hash
 * - UI transaction table summary and detail modal pagination in public/assets/js/pages.js
 *
 * Run: node tests/transaction-operations-pagination.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import {
  clearOperationsCache,
  deduplicateOperations,
  fetchAllTransactionOperations,
  fetchTransactionOperations,
  getTransactionDetail,
  getTransactions,
  resolveOperationDirection,
  summarizeTransactionOperations,
} from '../src/stellar/wallet.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const TEST_WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7'
const COUNTERPARTY_A = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR'
const COUNTERPARTY_B = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'

function makeOperation(index, overrides = {}) {
  const isNative = index % 2 === 1
  const isIncoming = index % 3 === 0
  return {
    id: `op-${index}`,
    paging_token: `cursor-${index}`,
    type: 'payment',
    asset_type: isNative ? 'native' : 'credit_alphanum4',
    asset_code: isNative ? undefined : 'USDC',
    asset_issuer: isNative ? undefined : COUNTERPARTY_B,
    amount: `${(index * 1.25).toFixed(2)}`,
    from: isIncoming ? COUNTERPARTY_A : TEST_WALLET,
    to: isIncoming ? TEST_WALLET : COUNTERPARTY_A,
    source_account: isIncoming ? COUNTERPARTY_A : TEST_WALLET,
    created_at: `2026-03-29T12:00:${String(index % 60).padStart(2, '0')}Z`,
    ...overrides,
  }
}

function makeOperationSequence(count, overridesFn = () => ({})) {
  return Array.from({ length: count }, (_, idx) => {
    const n = idx + 1
    return makeOperation(n, overridesFn(n))
  })
}

/**
 * Fake Horizon server supporting both `.transactions()` and paginated `.operations().forTransaction(hash)`.
 */
function createFakeHorizonServer({
  transactions = [],
  operationsByHash = {},
  overlapDuplicateOnPage = false,
} = {}) {
  const opCalls = []

  const txMap = new Map(transactions.map((tx) => [tx.hash || tx.id, tx]))

  const server = {
    serverURL: 'https://horizon-testnet.stellar.org',
    transactions() {
      let txHash = null
      let txCursor = null
      let txOrder = 'desc'
      let txLimit = 20

      const builder = {
        forAccount() {
          return builder
        },
        transaction(hash) {
          txHash = hash
          return {
            call: async () => {
              const found = txMap.get(txHash)
              if (!found) {
                const err = new Error(`Transaction ${txHash} not found`)
                err.response = { status: 404 }
                throw err
              }
              return { ...found }
            },
          }
        },
        cursor(c) {
          txCursor = c
          return builder
        },
        order(o) {
          txOrder = o
          return builder
        },
        limit(l) {
          txLimit = l
          return builder
        },
        async call() {
          let list = [...transactions]
          if (txOrder === 'asc') list.reverse()
          if (txCursor) {
            const idx = list.findIndex((t) => t.paging_token === txCursor)
            if (idx >= 0) list = list.slice(idx + 1)
          }
          return { records: list.slice(0, txLimit) }
        },
      }
      return builder
    },
    operations() {
      return {
        forTransaction(hash) {
          let opOrder = 'asc'
          let opLimit = 10
          let opCursor = null

          const opBuilder = {
            order(o) {
              opOrder = o
              return opBuilder
            },
            limit(l) {
              opLimit = l
              return opBuilder
            },
            cursor(c) {
              opCursor = c
              return opBuilder
            },
            async call() {
              opCalls.push({ hash, order: opOrder, limit: opLimit, cursor: opCursor })
              const allOps = [...(operationsByHash[hash] || [])]
              const ordered = opOrder === 'desc' ? [...allOps].reverse() : allOps

              let startIndex = 0
              if (opCursor) {
                const cursorIdx = ordered.findIndex(
                  (op) => op.paging_token === opCursor || op.id === opCursor
                )
                startIndex = cursorIdx >= 0 ? cursorIdx + 1 : ordered.length
                if (overlapDuplicateOnPage && startIndex > 0) {
                  // Intentionally include the boundary record again to test deduplication
                  startIndex -= 1
                }
              }

              const slice = ordered.slice(startIndex, startIndex + opLimit)
              return {
                records: slice.map((r) => ({ ...r })),
              }
            },
          }
          return opBuilder
        },
      }
    },
  }

  return { server, opCalls }
}

let passed = 0
let failed = 0

async function runTest(name, fn) {
  try {
    clearOperationsCache()
    await fn()
    console.log(`✓ ${name}`)
    passed += 1
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(`  ${err.stack || err.message}`)
    failed += 1
  }
}

// ── 1. Transactions with 0, 1, 10, and >10 operations in getTransactions ─────

await runTest(
  'getTransactions handles 0, 1, 10, and >10 operations with accurate completeness flags',
  async () => {
    const operationsByHash = {
      'tx-0': [],
      'tx-1': makeOperationSequence(1, () => ({
        asset_type: 'native',
        amount: '25.0000000',
        from: TEST_WALLET,
        to: COUNTERPARTY_A,
      })),
      'tx-10': makeOperationSequence(10),
      'tx-15': makeOperationSequence(15),
    }

    const transactions = [
      {
        id: 'tx-0',
        hash: 'tx-0',
        paging_token: 'pt-0',
        operation_count: 0,
        successful: true,
        created_at: '2026-03-29T12:00:00Z',
        memo_type: 'none',
      },
      {
        id: 'tx-1',
        hash: 'tx-1',
        paging_token: 'pt-1',
        operation_count: 1,
        successful: true,
        created_at: '2026-03-29T12:01:00Z',
        memo_type: 'text',
        memo: 'single-op',
      },
      {
        id: 'tx-10',
        hash: 'tx-10',
        paging_token: 'pt-10',
        operation_count: 10,
        successful: true,
        created_at: '2026-03-29T12:02:00Z',
        memo_type: 'text',
        memo: 'ten-ops',
      },
      {
        id: 'tx-15',
        hash: 'tx-15',
        paging_token: 'pt-15',
        operation_count: 15,
        successful: false,
        created_at: '2026-03-29T12:03:00Z',
        memo_type: 'text',
        memo: 'fifteen-ops-failed',
      },
    ]

    const { server } = createFakeHorizonServer({ transactions, operationsByHash })
    const result = await getTransactions(TEST_WALLET, 20, null, 'desc', { horizonServer: server })

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.transactions.length, 4)

    const [tx0, tx1, tx10, tx15] = result.transactions

    // 0 operations
    assert.strictEqual(tx0.operation_count, 0)
    assert.strictEqual(tx0.loadedOperationCount, 0)
    assert.strictEqual(tx0.operationsComplete, true)
    assert.strictEqual(tx0.operationsTruncated, false)
    assert.strictEqual(tx0.hasMoreOperations, false)
    assert.strictEqual(tx0.nextOperationsCursor, null)
    assert.strictEqual(tx0.operationsContinuationUrl, null)
    assert.strictEqual(tx0.operationSummary.direction, 'none')
    assert.strictEqual(tx0.successful, true)

    // 1 operation
    assert.strictEqual(tx1.operation_count, 1)
    assert.strictEqual(tx1.loadedOperationCount, 1)
    assert.strictEqual(tx1.operationsComplete, true)
    assert.strictEqual(tx1.operationsTruncated, false)
    assert.strictEqual(tx1.hasMoreOperations, false)
    assert.strictEqual(tx1.operations[0].asset_code, 'XLM')
    assert.strictEqual(tx1.operations[0].direction, 'outgoing')
    assert.strictEqual(tx1.operationSummary.direction, 'outgoing')
    assert.deepStrictEqual(tx1.operationSummary.assets, ['XLM'])
    assert.strictEqual(tx1.successful, true)

    // 10 operations (exact preview limit)
    assert.strictEqual(tx10.operation_count, 10)
    assert.strictEqual(tx10.loadedOperationCount, 10)
    assert.strictEqual(tx10.operationsComplete, true)
    assert.strictEqual(tx10.operationsTruncated, false)
    assert.strictEqual(tx10.hasMoreOperations, false)
    assert.strictEqual(tx10.nextOperationsCursor, null)
    assert.strictEqual(tx10.operationsContinuationUrl, null)
    assert.deepStrictEqual(tx10.operationSummary.assets, ['XLM', 'USDC'])
    assert.strictEqual(tx10.operationSummary.direction, 'mixed')

    // 15 operations (>10 preview limit: explicitly marked incomplete with continuation info)
    assert.strictEqual(tx15.operation_count, 15)
    assert.strictEqual(tx15.loadedOperationCount, 10)
    assert.strictEqual(tx15.operationsComplete, false)
    assert.strictEqual(tx15.operationsTruncated, true)
    assert.strictEqual(tx15.hasMoreOperations, true)
    assert.strictEqual(tx15.nextOperationsCursor, 'cursor-10')
    assert.strictEqual(
      tx15.operationsContinuationUrl,
      '/api/wallet/transactions/tx-15/operations?cursor=cursor-10&limit=10'
    )
    assert.strictEqual(tx15.successful, false)
    assert.strictEqual(tx15.operationSummary.successful, false)
  }
)

// ── 2. Paginated follow-up and full-operation retrieval preserve order & deduplicate ──

await runTest(
  'fetchTransactionOperations and fetchAllTransactionOperations preserve order and deduplicate across pages',
  async () => {
    const operationsByHash = {
      'tx-25': makeOperationSequence(25),
    }
    const { server } = createFakeHorizonServer({
      operationsByHash,
      overlapDuplicateOnPage: true,
    })

    // Manual 3-page walk using cursor
    const page1 = await fetchTransactionOperations('tx-25', server, {
      limit: 10,
      expectedCount: 25,
      accountAddress: TEST_WALLET,
    })
    assert.strictEqual(page1.operations.length, 10)
    assert.strictEqual(page1.complete, false)
    assert.strictEqual(page1.truncated, true)
    assert.strictEqual(page1.hasMore, true)
    assert.strictEqual(page1.nextCursor, 'cursor-10')

    const page2 = await fetchTransactionOperations('tx-25', server, {
      limit: 10,
      cursor: page1.nextCursor,
      expectedCount: 25,
      accountAddress: TEST_WALLET,
    })
    assert.strictEqual(page2.hasMore, true)

    const page3 = await fetchTransactionOperations('tx-25', server, {
      limit: 10,
      cursor: page2.nextCursor,
      expectedCount: 25,
      accountAddress: TEST_WALLET,
    })

    const { operations: combinedManual } = deduplicateOperations([
      ...page1.operations,
      ...page2.operations,
      ...page3.operations,
    ])
    assert.strictEqual(combinedManual.length, 25, 'all 25 unique operations must be present')
    assert.deepStrictEqual(
      combinedManual.map((op) => op.id),
      Array.from({ length: 25 }, (_, i) => `op-${i + 1}`),
      'operations must stay in exact ascending order without duplicates'
    )

    // Automatic full retrieval via fetchAllTransactionOperations
    const allResult = await fetchAllTransactionOperations('tx-25', {
      horizonServer: server,
      pageSize: 10,
      expectedCount: 25,
      accountAddress: TEST_WALLET,
    })
    assert.strictEqual(allResult.error, null)
    assert.strictEqual(allResult.complete, true)
    assert.strictEqual(allResult.truncated, false)
    assert.strictEqual(allResult.hasMore, false)
    assert.strictEqual(allResult.operations.length, 25)
    assert.deepStrictEqual(
      allResult.operations.map((op) => op.id),
      Array.from({ length: 25 }, (_, i) => `op-${i + 1}`)
    )
  }
)

// ── 3. Operation direction, asset, count, and transaction success representation ──

await runTest(
  'resolveOperationDirection and summarizeTransactionOperations represent count, asset, direction, and success accurately',
  async () => {
    assert.strictEqual(
      resolveOperationDirection({ from: COUNTERPARTY_A, to: TEST_WALLET }, TEST_WALLET),
      'incoming'
    )
    assert.strictEqual(
      resolveOperationDirection({ from: TEST_WALLET, to: COUNTERPARTY_A }, TEST_WALLET),
      'outgoing'
    )
    assert.strictEqual(
      resolveOperationDirection({ from: TEST_WALLET, to: TEST_WALLET }, TEST_WALLET),
      'self'
    )
    assert.strictEqual(
      resolveOperationDirection(
        { type: 'manage_data', source_account: COUNTERPARTY_A },
        TEST_WALLET
      ),
      'non_transfer'
    )

    const summaryFailed = summarizeTransactionOperations(
      [
        {
          id: 'op-1',
          type: 'payment',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          amount: '5.00',
          from: COUNTERPARTY_A,
          to: TEST_WALLET,
        },
      ],
      {
        accountAddress: TEST_WALLET,
        expectedCount: 1,
        complete: true,
        successful: false,
      }
    )

    assert.strictEqual(summaryFailed.operationCount, 1)
    assert.strictEqual(summaryFailed.loadedOperationCount, 1)
    assert.strictEqual(summaryFailed.complete, true)
    assert.strictEqual(summaryFailed.direction, 'incoming')
    assert.deepStrictEqual(summaryFailed.assets, ['USDC'])
    assert.strictEqual(summaryFailed.successful, false)
  }
)

// ── 4. HTTP endpoints: /api/wallet/transactions and /api/wallet/transactions/:hash/operations ──

await runTest(
  'HTTP endpoints expose truncation metadata, continuation URLs, and paginated/complete operation responses',
  async () => {
    const operationsByHash = {
      'tx-0': [],
      'tx-1': makeOperationSequence(1),
      'tx-10': makeOperationSequence(10),
      'tx-15': makeOperationSequence(15),
    }
    const transactions = [
      { id: 'tx-0', hash: 'tx-0', paging_token: 'pt-0', operation_count: 0, successful: true },
      { id: 'tx-1', hash: 'tx-1', paging_token: 'pt-1', operation_count: 1, successful: true },
      { id: 'tx-10', hash: 'tx-10', paging_token: 'pt-10', operation_count: 10, successful: true },
      { id: 'tx-15', hash: 'tx-15', paging_token: 'pt-15', operation_count: 15, successful: false },
    ]

    const { server: horizonServer } = createFakeHorizonServer({
      transactions,
      operationsByHash,
      overlapDuplicateOnPage: true,
    })

    const { app } = createApp({ config, pricingConfig: {}, runHistoryStore: null, horizonServer })
    const httpServer = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const { port } = httpServer.address()
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      // 1. Default preview list response
      const listRes = await fetch(`${baseUrl}/api/wallet/transactions?address=${TEST_WALLET}`)
      assert.strictEqual(listRes.status, 200)
      const listBody = await listRes.json()

      assert.strictEqual(listBody.success, true)
      assert.strictEqual(listBody.count, 4)
      assert.strictEqual(listBody.operationsComplete, false)
      assert.strictEqual(listBody.incompleteTransactionsCount, 1)

      const tx15Preview = listBody.transactions.find((t) => t.hash === 'tx-15')
      assert.ok(tx15Preview)
      assert.strictEqual(tx15Preview.operations.length, 10)
      assert.strictEqual(tx15Preview.operationsComplete, false)
      assert.strictEqual(tx15Preview.operationsTruncated, true)
      assert.strictEqual(tx15Preview.hasMoreOperations, true)
      assert.strictEqual(tx15Preview.nextOperationsCursor, 'cursor-10')
      assert.strictEqual(tx15Preview.successful, false)
      assert.ok(
        tx15Preview.operationsContinuationUrl.startsWith(
          '/api/wallet/transactions/tx-15/operations?cursor=cursor-10'
        )
      )

      // 2. Follow continuation URL for remaining 5 operations
      const page2Res = await fetch(
        `${baseUrl}${tx15Preview.operationsContinuationUrl}&expectedCount=15&address=${TEST_WALLET}`
      )
      assert.strictEqual(page2Res.status, 200)
      const page2Body = await page2Res.json()
      assert.strictEqual(page2Body.success, true)
      assert.strictEqual(page2Body.hasMore, false)
      assert.strictEqual(page2Body.complete, true)

      const { operations: mergedOps } = deduplicateOperations([
        ...tx15Preview.operations,
        ...page2Body.operations,
      ])
      assert.strictEqual(mergedOps.length, 15)
      assert.deepStrictEqual(
        mergedOps.map((op) => op.id),
        Array.from({ length: 15 }, (_, i) => `op-${i + 1}`)
      )

      // 3. Fetch all operations in one request via ?all=true
      const allOpsRes = await fetch(
        `${baseUrl}/api/wallet/transactions/tx-15/operations?all=true&expectedCount=15&address=${TEST_WALLET}`
      )
      assert.strictEqual(allOpsRes.status, 200)
      const allOpsBody = await allOpsRes.json()
      assert.strictEqual(allOpsBody.success, true)
      assert.strictEqual(allOpsBody.complete, true)
      assert.strictEqual(allOpsBody.truncated, false)
      assert.strictEqual(allOpsBody.operations.length, 15)

      // 4. Single transaction detail endpoint GET /api/wallet/transactions/:hash
      const detailRes = await fetch(
        `${baseUrl}/api/wallet/transactions/tx-15?all=true&address=${TEST_WALLET}`
      )
      assert.strictEqual(detailRes.status, 200)
      const detailBody = await detailRes.json()
      assert.strictEqual(detailBody.success, true)
      assert.strictEqual(detailBody.transaction.hash, 'tx-15')
      assert.strictEqual(detailBody.transaction.successful, false)
      assert.strictEqual(detailBody.transaction.operationsComplete, true)
      assert.strictEqual(detailBody.transaction.operations.length, 15)

      // 5. getTransactionDetail helper direct check
      const directDetail = await getTransactionDetail('tx-10', {
        horizonServer,
        accountAddress: TEST_WALLET,
      })
      assert.strictEqual(directDetail.operationsComplete, true)
      assert.strictEqual(directDetail.operations.length, 10)
    } finally {
      await new Promise((resolve) => httpServer.close(resolve))
    }
  }
)

// ── 5. UI rendering in public/assets/js/pages.js ────────────────────────────

await runTest(
  'UI in public/assets/js/pages.js accurately summarizes 0, 1, 10, and >10 op transactions and paginates details',
  async () => {
    const pagesJsPath = path.join(repoRoot, 'public/assets/js/pages.js')
    const pagesJsCode = fs.readFileSync(pagesJsPath, 'utf8')

    const elements = {
      'tx-body': { innerHTML: '', children: [] },
      'tx-cnt': { textContent: '' },
      'tx-total': { textContent: '' },
      'tx-detail-modal': { style: { display: 'none' } },
      'tx-detail-meta': { innerHTML: '' },
      'tx-detail-ops': { innerHTML: '' },
      'tx-detail-actions': { innerHTML: '' },
    }

    const tx0 = {
      id: 'tx-0000000000000000',
      hash: 'tx-0000000000000000',
      operation_count: 0,
      loadedOperationCount: 0,
      operationsComplete: true,
      operationsTruncated: false,
      hasMoreOperations: false,
      successful: true,
      operations: [],
      created_at: '2026-03-29T12:00:00Z',
      memo_type: 'none',
    }

    const tx1 = {
      id: 'tx-1111111111111111',
      hash: 'tx-1111111111111111',
      operation_count: 1,
      loadedOperationCount: 1,
      operationsComplete: true,
      operationsTruncated: false,
      hasMoreOperations: false,
      successful: true,
      operations: [
        {
          id: 'op-single-1',
          paging_token: 'cursor-single-1',
          type: 'payment',
          asset_type: 'native',
          asset_code: 'XLM',
          amount: '42.5000000',
          from: TEST_WALLET,
          to: COUNTERPARTY_A,
          direction: 'outgoing',
        },
      ],
      created_at: '2026-03-29T12:01:00Z',
      memo_type: 'text',
      memo: 'one-op',
    }

    const tx10Ops = makeOperationSequence(10)
    const tx10 = {
      id: 'tx-1010101010101010',
      hash: 'tx-1010101010101010',
      operation_count: 10,
      loadedOperationCount: 10,
      operationsComplete: true,
      operationsTruncated: false,
      hasMoreOperations: false,
      successful: true,
      operations: tx10Ops,
      created_at: '2026-03-29T12:02:00Z',
      memo_type: 'text',
      memo: 'ten-ops',
    }

    const tx15AllOps = makeOperationSequence(15)
    const tx15Preview = {
      id: 'tx-1515151515151515',
      hash: 'tx-1515151515151515',
      operation_count: 15,
      loadedOperationCount: 10,
      operationsComplete: false,
      operationsTruncated: true,
      hasMoreOperations: true,
      nextOperationsCursor: 'cursor-10',
      operationsContinuationUrl:
        '/api/wallet/transactions/tx-1515151515151515/operations?cursor=cursor-10&limit=10',
      successful: false,
      operations: tx15AllOps.slice(0, 10),
      created_at: '2026-03-29T12:03:00Z',
      memo_type: 'text',
      memo: 'fifteen-ops',
    }

    const fetchCalls = []
    const fakeFetch = async (url) => {
      fetchCalls.push(url)
      if (url === '/api/wallet/transactions') {
        return {
          json: async () => ({
            success: true,
            address: TEST_WALLET,
            transactions: [tx0, tx1, tx10, tx15Preview],
          }),
        }
      }
      if (url.startsWith('/api/wallet/transactions/tx-1515151515151515/operations')) {
        // Return overlapping op-10 plus ops 11..15 to verify client-side deduplication as well
        return {
          json: async () => ({
            success: true,
            hash: 'tx-1515151515151515',
            operations: tx15AllOps.slice(9, 15),
            loadedCount: 6,
            totalCount: 15,
            complete: true,
            truncated: false,
            hasMore: false,
            nextCursor: null,
            continuationUrl: null,
          }),
        }
      }
      throw new Error(`Unexpected fetch URL in UI test: ${url}`)
    }

    const sandbox = {
      fetch: fakeFetch,
      console,
      URLSearchParams,
      document: {
        getElementById(id) {
          if (!elements[id]) {
            elements[id] = { innerHTML: '', textContent: '', style: {} }
          }
          return elements[id]
        },
        createElement() {
          return {}
        },
      },
    }

    vm.createContext(sandbox)
    vm.runInContext(pagesJsCode, sandbox)

    await sandbox.loadTxPage()

    const tableHtml = elements['tx-body'].innerHTML

    // Verify 0-op transaction summary
    assert.ok(tableHtml.includes('No operations (0 ops)'), '0-op row must state No operations')
    assert.ok(tableHtml.includes('0 ops'), '0-op row must show 0 ops count badge')

    // Verify 1-op transaction summary
    assert.ok(tableHtml.includes('42.50 XLM'), '1-op row must show single operation amount')
    assert.ok(tableHtml.includes('payment (outgoing)'), '1-op row must show type and direction')

    // Verify 10-op and 15-op transactions do NOT display ops[0].amount ("1.25 XLM") as the transaction amount
    assert.ok(
      !tableHtml.includes('<span class="tx-amount">1.25 XLM</span>'),
      'multi-operation transactions must NOT display ops[0].amount as the whole transaction amount'
    )
    assert.ok(
      tableHtml.includes('Multi-op (10 ops · XLM, USDC)'),
      '10-op row must summarize all 10 operations and assets'
    )
    assert.ok(
      tableHtml.includes('Multi-op (10 of 15 ops loaded · XLM, USDC)'),
      '15-op truncated row must explicitly state 10 of 15 ops loaded'
    )
    assert.ok(
      tableHtml.includes('10/15 ops (incomplete)'),
      '15-op truncated row must render an incomplete count badge'
    )
    assert.ok(tableHtml.includes('Failed'), 'failed transaction must render Failed status badge')

    // Open detail modal for the truncated 15-op transaction
    const initialDetail = await sandbox.openTxDetail('tx-1515151515151515')
    assert.strictEqual(initialDetail.summary.loadedOperationCount, 10)
    assert.strictEqual(initialDetail.summary.totalOperationCount, 15)
    assert.strictEqual(initialDetail.summary.operationsComplete, false)
    assert.ok(elements['tx-detail-meta'].innerHTML.includes('10 of 15 loaded'))
    assert.ok(elements['tx-detail-actions'].innerHTML.includes('Load Next Page'))

    // Load next page of operations and verify all 15 unique operations are rendered in order
    const updatedDetail = await sandbox.loadMoreTxOperations('tx-1515151515151515')
    assert.strictEqual(updatedDetail.operations.length, 15)
    assert.strictEqual(updatedDetail.summary.operationsComplete, true)
    assert.deepStrictEqual(
      Array.from(updatedDetail.operations, (op) => op.id),
      Array.from({ length: 15 }, (_, i) => `op-${i + 1}`)
    )
    assert.ok(elements['tx-detail-meta'].innerHTML.includes('15 of 15 loaded (Complete)'))
    assert.ok(elements['tx-detail-actions'].innerHTML.includes('All operations loaded'))
  }
)

console.log(`\nResults: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
