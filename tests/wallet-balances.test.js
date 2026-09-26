/**
 * Wallet balance display: fixtures from issue #170.
 * Small nonzero amounts, both assets, zero USDC, missing trustline, upstream down.
 *
 * public/assets/js/wallet.js is a plain browser script (no module syntax), so the
 * test evaluates the shipped source instead of importing it: what is asserted here
 * is exactly what the browser runs.
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../public/assets/js/wallet.js', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
const { formatAmount, summariseWallet, settlementAssetCode } = new Function(
  source + '\nreturn { formatAmount, summariseWallet, settlementAssetCode }'
)()

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['pass', name])
  } catch (err) {
    results.push(['fail', name + ' -> ' + err.message])
  }
}

check('small nonzero USDC is never shown as an exact zero', () => {
  const out = summariseWallet(
    {
      balances: [
        { asset: 'USDC', balance: '0.4' },
        { asset: 'XLM', balance: '12.5' },
      ],
    },
    'USDC'
  )
  assert.ok(!/\b0 USDC\b/.test(out.text), 'rendered as zero: ' + out.text)
  assert.ok(out.text.includes('0.4 USDC'), out.text)
})

check('very small nonzero native balance keeps significant digits', () => {
  const out = summariseWallet(
    {
      balances: [
        { asset: 'XLM', balance: '0.004' },
        { asset: 'USDC', balance: '0' },
      ],
    },
    'USDC'
  )
  assert.ok(out.text.includes('0.004'), out.text)
  assert.notStrictEqual(formatAmount('0.004'), '0', 'mobile formatting rounded to zero')
})

check('both native and settlement balances are visible at once', () => {
  const out = summariseWallet(
    {
      balances: [
        { asset: 'USDC', balance: '10' },
        { asset: 'XLM', balance: '5' },
      ],
    },
    'USDC'
  )
  assert.ok(out.text.includes('10 USDC'), out.text)
  assert.ok(out.text.includes('5 XLM'), out.text)
})

check('a real zero is distinguishable from a missing trustline', () => {
  const zero = summariseWallet(
    {
      balances: [
        { asset: 'USDC', balance: '0' },
        { asset: 'XLM', balance: '1' },
      ],
    },
    'USDC'
  )
  assert.strictEqual(zero.parts[0].state, 'zero')
  const missing = summariseWallet({ balances: [{ asset: 'XLM', balance: '1' }] }, 'USDC')
  assert.strictEqual(missing.parts[0].state, 'no-trustline')
  assert.ok(missing.text.includes('no trustline'), missing.text)
})

check('unavailable data is distinguishable and never shown as a zero', () => {
  assert.strictEqual(summariseWallet(null, 'USDC').text, 'unavailable')
  assert.strictEqual(summariseWallet({}, 'USDC').state, 'unavailable')
  assert.strictEqual(summariseWallet({ balances: [] }, 'USDC').state, 'unavailable')
  // A missing settlement trustline and an unreadable native balance stay two
  // different states in the rendered string, which is the point of the criterion.
  const down = summariseWallet({ balances: [{ asset: 'XLM', balance: null }] }, 'USDC')
  assert.ok(down.text.includes('no trustline'), down.text)
  assert.ok(down.text.includes('unavailable'), down.text)
  assert.ok(!/\b0 XLM\b/.test(down.text), down.text)
})

check('settlement asset follows configuration instead of a hardcoded code', () => {
  assert.strictEqual(settlementAssetCode({ settlementAsset: 'usdc' }, 'XLM'), 'USDC')
  assert.strictEqual(settlementAssetCode({}, 'AQUA'), 'AQUA')
  const out = summariseWallet(
    {
      balances: [
        { asset: 'AQUA', balance: '3' },
        { asset: 'XLM', balance: '2' },
      ],
    },
    'AQUA'
  )
  assert.ok(out.text.includes('3 AQUA'), out.text)
})

const failed = results.filter(([s]) => s === 'fail')
for (const [s, n] of results) console.log((s === 'pass' ? '  ok   ' : '  FAIL ') + n)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
