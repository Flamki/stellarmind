/**
 * Guards for issue #159: complete transaction operations with explicit paging.
 *
 * The transaction list used to fetch at most 10 operations per transaction and
 * the table showed the first one, so a multi-operation transaction looked like a
 * single payment with no sign that details were missing.
 *
 * Fixtures: transactions with zero, one, ten and 25 operations, plus a failed one.
 *
 * Run: node tests/transaction-operations.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  clearOperationsCache,
  getTransactionOperations,
  getTransactions,
} from '../src/stellar/wallet.js'
import {
  operationDirection,
  operationsAreComplete,
  summarizeOperations,
} from '../src/stellar/transaction-summary.js'
import { validateTransactionOperations } from '../src/requestValidation.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ME = 'GME'
const OTHER = 'GOTHER'

// ── Fixtures ────────────────────────────────────────────────────────────────

function payment(i, { from = ME, to = OTHER, asset = 'XLM' } = {}) {
  return {
    id: `op-${String(i).padStart(4, '0')}`,
    paging_token: `op-${String(i).padStart(4, '0')}`,
    type: 'payment',
    asset_type: asset === 'XLM' ? 'native' : 'credit_alphanum4',
    asset_code: asset === 'XLM' ? undefined : asset,
    amount: '1.0000000',
    from,
    to,
  }
}

function ops(prefix, count, options) {
  return Array.from({ length: count }, (_, i) => ({
    ...payment(i + 1, options),
    id: `${prefix}-${i + 1}`,
    paging_token: `${prefix}-${String(i + 1).padStart(4, '0')}`,
  }))
}

const TXS = {
  zero: { hash: 'a'.repeat(64), operation_count: 0, successful: true, ops: [] },
  one: { hash: 'b'.repeat(64), operation_count: 1, successful: true, ops: ops('one', 1) },
  ten: { hash: 'c'.repeat(64), operation_count: 10, successful: true, ops: ops('ten', 10) },
  many: {
    hash: 'd'.repeat(64),
    operation_count: 25,
    successful: true,
    ops: ops('many', 25, { from: OTHER, to: ME }),
  },
  failed: {
    hash: 'e'.repeat(64),
    operation_count: 1,
    successful: false,
    ops: ops('failed', 1),
  },
}

/** Stand-in for a Horizon server over the fixtures; cursors are exclusive like Horizon's. */
function fakeHorizon({ failOps = () => false } = {}) {
  const byHash = new Map(Object.values(TXS).map((tx) => [tx.hash, tx]))
  const opCalls = []

  const server = {
    serverURL: 'https://horizon.fake',
    transactions() {
      return {
        transaction: (hash) => ({
          call: async () => {
            const tx = byHash.get(hash)
            if (!tx) {
              const err = new Error('Resource Missing')
              err.response = { status: 404 }
              throw err
            }
            return { ...tx, created_at: '2026-01-01T00:00:00Z', fee_charged: '100', ledger_attr: 7 }
          },
        }),
        forAccount: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({
                records: Object.values(TXS).map((tx) => ({
                  hash: tx.hash,
                  paging_token: `tx-${tx.hash[0]}`,
                  ledger: 7,
                  created_at: '2026-01-01T00:00:00Z',
                  fee_charged: '100',
                  operation_count: tx.operation_count,
                  successful: tx.successful,
                  memo_type: 'none',
                })),
              }),
            }),
          }),
        }),
      }
    },
    operations() {
      return {
        forTransaction(hash) {
          const state = { order: 'asc', limit: 10, cursor: null }
          const chain = {
            order: (o) => ((state.order = o), chain),
            limit: (n) => ((state.limit = n), chain),
            cursor: (c) => ((state.cursor = c), chain),
            call: async () => {
              opCalls.push({ hash, ...state })
              if (failOps(hash)) throw new Error(`horizon exploded for ${hash}`)
              let records = [...(byHash.get(hash)?.ops ?? [])]
              if (state.order === 'desc') records.reverse()
              if (state.cursor) {
                const at = records.findIndex((r) => r.paging_token === state.cursor)
                records = at === -1 ? [] : records.slice(at + 1)
              }
              return { records: records.slice(0, state.limit) }
            },
          }
          return chain
        },
      }
    },
  }
  return { server, opCalls }
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// ── Pure summary rules ──────────────────────────────────────────────────────

await test('direction is relative to the account and null when there is no counterparty', () => {
  assert.strictEqual(operationDirection({ from: ME, to: OTHER }, ME), 'outgoing')
  assert.strictEqual(operationDirection({ from: OTHER, to: ME }, ME), 'incoming')
  assert.strictEqual(operationDirection({ from: ME, to: ME }, ME), 'self')
  assert.strictEqual(operationDirection({ from: OTHER, to: 'GX' }, ME), 'other')
  assert.strictEqual(operationDirection({ from: ME, to: null }, ME), null)
  assert.strictEqual(operationDirection({ from: ME, to: OTHER }, null), null)
})

await test('completeness uses operation_count, and a failed lookup is never complete', () => {
  assert.strictEqual(operationsAreComplete({ operations: [], operationCount: 0, limit: 10 }), true)
  assert.strictEqual(
    operationsAreComplete({ operations: new Array(10), operationCount: 10, limit: 10 }),
    true
  )
  assert.strictEqual(
    operationsAreComplete({ operations: new Array(10), operationCount: 11, limit: 10 }),
    false
  )
  assert.strictEqual(
    operationsAreComplete({ operations: [], operationCount: 0, error: 'x', limit: 10 }),
    false
  )
  // Unknown count: a full page may have more behind it.
  assert.strictEqual(
    operationsAreComplete({ operations: new Array(10), operationCount: undefined, limit: 10 }),
    false
  )
  assert.strictEqual(
    operationsAreComplete({ operations: new Array(3), operationCount: undefined, limit: 10 }),
    true
  )
})

await test('summary distinguishes none, single and multiple and only reports direction when complete', () => {
  const mk = (n, extra = {}) =>
    summarizeOperations({
      operations: ops('s', Math.min(n, 10)).map((o) => ({ ...o, direction: 'outgoing' })),
      operationCount: n,
      successful: true,
      ...extra,
    })
  assert.strictEqual(mk(0).kind, 'none')
  assert.strictEqual(mk(1).kind, 'single')
  assert.strictEqual(mk(1).direction, 'outgoing')
  assert.strictEqual(mk(10).kind, 'multiple')
  assert.strictEqual(mk(10).operationsComplete, true)
  const big = mk(25)
  assert.strictEqual(big.operationsComplete, false)
  assert.strictEqual(big.operationsIncluded, 10)
  assert.strictEqual(big.operationCount, 25)
  assert.strictEqual(big.direction, null, 'direction of unseen operations is unknown')
  const mixed = summarizeOperations({
    operations: [
      { type: 'payment', direction: 'incoming', asset_code: 'XLM' },
      { type: 'payment', direction: 'outgoing', asset_code: 'USDC' },
    ],
    operationCount: 2,
    successful: true,
  })
  assert.strictEqual(mixed.direction, 'mixed')
  assert.deepStrictEqual(mixed.assets, ['XLM', 'USDC'])
})

// ── Transaction list ────────────────────────────────────────────────────────

clearOperationsCache()
const list = await getTransactions(ME, 10, null, 'desc', fakeHorizon().server)
const byHash = Object.fromEntries(list.transactions.map((tx) => [tx.hash, tx]))

await test('list flags whether the included operations are complete', () => {
  assert.strictEqual(list.success, true)
  assert.strictEqual(byHash[TXS.zero.hash].operationsComplete, true)
  assert.strictEqual(byHash[TXS.one.hash].operationsComplete, true)
  assert.strictEqual(byHash[TXS.ten.hash].operationsComplete, true)
  const many = byHash[TXS.many.hash]
  assert.strictEqual(many.operationsComplete, false)
  assert.strictEqual(many.operations.length, 10)
  assert.strictEqual(many.operationCount, 25)
  assert.strictEqual(many.summary.kind, 'multiple')
})

await test('list represents count, asset, direction and success per transaction', () => {
  const one = byHash[TXS.one.hash]
  assert.strictEqual(one.summary.kind, 'single')
  assert.deepStrictEqual(one.summary.assets, ['XLM'])
  assert.strictEqual(one.operations[0].direction, 'outgoing')
  assert.strictEqual(byHash[TXS.many.hash].operations[0].direction, 'incoming')
  assert.strictEqual(byHash[TXS.failed.hash].summary.successful, false)
  assert.strictEqual(byHash[TXS.zero.hash].summary.kind, 'none')
})

await test('a failed operations lookup is reported as incomplete, not as "no operations"', async () => {
  clearOperationsCache()
  const quiet = console.warn
  console.warn = () => {}
  let result
  try {
    result = await getTransactions(
      ME,
      10,
      null,
      'desc',
      fakeHorizon({ failOps: () => true }).server
    )
  } finally {
    console.warn = quiet
  }
  const tx = result.transactions[1]
  assert.ok(tx.operationsError)
  assert.strictEqual(tx.operationsComplete, false)
  assert.strictEqual(tx.summary.kind, 'single', 'count still comes from the transaction record')
})

// ── Operation paging ────────────────────────────────────────────────────────

await test('pages through 25 operations without gaps or duplicates', async () => {
  const { server } = fakeHorizon()
  const seen = []
  let cursor = null
  const sizes = []
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await getTransactionOperations(
      TXS.many.hash,
      { limit: 10, cursor, account: ME },
      server
    )
    assert.strictEqual(page.success, true)
    sizes.push(page.operations.length)
    seen.push(...page.operations.map((o) => o.id))
    assert.strictEqual(page.transaction.operationCount, 25)
    if (!page.pagination.hasMore) {
      assert.strictEqual(page.pagination.nextCursor, null)
      break
    }
    cursor = page.pagination.nextCursor
    assert.strictEqual(cursor, page.operations[page.operations.length - 1].paging_token)
  }
  assert.deepStrictEqual(sizes, [10, 10, 5])
  assert.strictEqual(new Set(seen).size, 25)
  assert.deepStrictEqual(
    seen,
    TXS.many.ops.map((o) => o.id)
  )
})

await test('desc order pages the same operations in reverse', async () => {
  const { server } = fakeHorizon()
  const first = await getTransactionOperations(TXS.many.hash, { limit: 100, order: 'desc' }, server)
  assert.deepStrictEqual(
    first.operations.map((o) => o.id),
    [...TXS.many.ops].reverse().map((o) => o.id)
  )
})

await test('zero, one and exactly-ten operations each finish in a single page', async () => {
  const { server } = fakeHorizon()
  for (const [key, expected] of [
    ['zero', 0],
    ['one', 1],
    ['ten', 10],
  ]) {
    const page = await getTransactionOperations(TXS[key].hash, { limit: 10 }, server)
    assert.strictEqual(page.operations.length, expected, key)
    assert.strictEqual(page.pagination.hasMore, false, `${key}: no empty trailing page`)
    assert.strictEqual(page.pagination.nextCursor, null)
  }
})

await test('page size is capped and one extra record is read to detect the next page', async () => {
  const { server, opCalls } = fakeHorizon()
  await getTransactionOperations(TXS.many.hash, { limit: 5000 }, server)
  assert.strictEqual(opCalls[0].limit, 101)
  const page = await getTransactionOperations(TXS.many.hash, { limit: 10 }, server)
  assert.strictEqual(opCalls[1].limit, 11)
  assert.strictEqual(page.pagination.limit, 10)
})

await test('detail carries transaction success and operation direction', async () => {
  const { server } = fakeHorizon()
  const failed = await getTransactionOperations(TXS.failed.hash, { account: ME }, server)
  assert.strictEqual(failed.transaction.successful, false)
  assert.strictEqual(failed.operations[0].direction, 'outgoing')
  const anon = await getTransactionOperations(TXS.one.hash, {}, server)
  assert.strictEqual(anon.operations[0].direction, null)
})

await test('unknown transactions and upstream failures are classified', async () => {
  const quiet = console.error
  console.error = () => {}
  try {
    const { server } = fakeHorizon()
    const missing = await getTransactionOperations('f'.repeat(64), {}, server)
    assert.strictEqual(missing.success, false)
    assert.strictEqual(missing.errorType, 'TRANSACTION_NOT_FOUND')
    const broken = await getTransactionOperations(
      TXS.one.hash,
      {},
      fakeHorizon({ failOps: () => true }).server
    )
    assert.strictEqual(broken.errorType, 'UPSTREAM_ERROR')
  } finally {
    console.error = quiet
  }
})

// ── Query validation ────────────────────────────────────────────────────────

function validate(params, query = {}) {
  const req = { params, query }
  let error = null
  validateTransactionOperations(req, {}, (err) => {
    error = err || null
  })
  return { error, validated: req.validated?.transactionOperations }
}

await test('operations query is validated and defaulted', () => {
  const ok = validate({ hash: 'A'.repeat(64) })
  assert.deepStrictEqual(ok.validated, {
    hash: 'a'.repeat(64),
    limit: 20,
    order: 'asc',
    cursor: null,
    address: null,
  })
  assert.strictEqual(validate({ hash: 'a'.repeat(64) }, { limit: '500' }).validated.limit, 100)
  for (const [params, query] of [
    [{ hash: 'nothex' }, {}],
    [{ hash: 'a'.repeat(64) }, { limit: '0' }],
    [{ hash: 'a'.repeat(64) }, { limit: '2x' }],
    [{ hash: 'a'.repeat(64) }, { order: 'sideways' }],
    [{ hash: 'a'.repeat(64) }, { cursor: 'x'.repeat(129) }],
  ]) {
    const result = validate(params, query)
    assert.ok(result.error, JSON.stringify([params, query]))
    assert.strictEqual(result.error.status, 400)
  }
})

// ── Table and detail rendering (public/assets/js/tx-render.js) ───────────────

const sandbox = {}
vm.runInNewContext(
  fs.readFileSync(path.join(repoRoot, 'public/assets/js/tx-render.js'), 'utf8'),
  sandbox
)
sandbox.globalThis = sandbox
const { TxRender } = sandbox

const listTx = (key, extra = {}) => ({ ...byHash[TXS[key].hash], ...extra })

await test('table row: one operation shows its amount, asset and direction', () => {
  const html = TxRender.renderTxRow(listTx('one'))
  assert.match(html, /payment/)
  assert.match(html, /1\.00 XLM/)
  assert.match(html, /↑ out/)
  assert.doesNotMatch(html, /View all/)
})

await test('table row: multiple operations never present the first amount as the total', () => {
  for (const key of ['ten', 'many']) {
    const html = TxRender.renderTxRow(listTx(key))
    assert.match(html, new RegExp(`${TXS[key].operation_count} operations`))
    assert.match(html, /multiple operations/)
    assert.doesNotMatch(html, /1\.00 XLM/)
    assert.match(html, /tx-details-btn/)
  }
  assert.match(TxRender.renderTxRow(listTx('many')), /showing 10 of 25/)
  assert.doesNotMatch(TxRender.renderTxRow(listTx('ten')), /showing/)
})

await test('table row: zero operations, failed transactions and failed lookups are explicit', () => {
  assert.match(TxRender.renderTxRow(listTx('zero')), /no operations/)
  const failed = TxRender.renderTxRow(listTx('failed'))
  assert.match(failed, /failed/)
  assert.doesNotMatch(failed, /1\.00 XLM/, 'a failed transaction moved nothing')
  const lookup = TxRender.renderTxRow(
    listTx('one', {
      operations: [],
      operationsError: 'boom',
      operationsComplete: false,
      summary: { kind: 'unknown', operationsComplete: false },
    })
  )
  assert.match(lookup, /operations unavailable/)
})

await test('table row escapes user-controlled memo text', () => {
  const html = TxRender.renderTxRow(
    listTx('one', { memo: '<img src=x onerror=alert(1)>', memo_type: 'text' })
  )
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

await test('detail pager retrieves every operation exactly once through the API shape', async () => {
  const { server } = fakeHorizon()
  const fetchJson = async (url) => {
    const u = new URL(url, 'http://x')
    const hash = u.pathname.split('/')[4]
    const page = await getTransactionOperations(
      hash,
      { limit: Number(u.searchParams.get('limit')), cursor: u.searchParams.get('cursor') },
      server
    )
    return { ...page, count: page.operations.length }
  }
  const pager = TxRender.createOperationsPager(TXS.many.hash, fetchJson, { limit: 10 })
  const ids = []
  let pages = 0
  while (!pager.done && pages < 10) {
    ids.push(...(await pager.next()).operations.map((o) => o.id))
    pages += 1
  }
  assert.strictEqual(pages, 3)
  assert.strictEqual(new Set(ids).size, 25)
  assert.match(TxRender.renderOperationRows(TXS.many.ops.slice(0, 2)), /payment/)
  assert.strictEqual((await pager.next()).operations.length, 0, 'a finished pager stays finished')
})

console.log(`\nAll ${passed} transaction operation tests passed`)
