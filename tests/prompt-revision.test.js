/**
 * Prompt revisions: issue #153 wants every live output to carry a reproducible
 * prompt revision, and differing prompt content to produce a different one.
 */
import assert from 'node:assert'
import { revision, renderWithRevision, listTemplates } from '../src/prompts/index.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['pass', name])
  } catch (err) {
    results.push(['fail', name + ' -> ' + err.message])
  }
}

check('the same prompt always yields the same revision', () => {
  const text = 'Summarise the Stellar network profile.'
  assert.strictEqual(revision(text), revision(text))
})

check('differing prompt content yields a different revision', () => {
  assert.notStrictEqual(revision('Use model A.'), revision('Use model B.'))
})

check('a revision is 16 hex characters and holds no prompt text', () => {
  const text = 'Never store this exact sentence in metadata.'
  const rev = revision(text)
  assert.match(rev, /^[0-9a-f]{16}$/)
  assert.ok(!rev.includes('Never'), 'revision leaked prompt text')
})

check('renderWithRevision returns the prompt, its revision and the template name', () => {
  const names = listTemplates()
  assert.ok(names.length > 0, 'no templates found')
  const out = renderWithRevision(names[0], {})
  assert.strictEqual(typeof out.prompt, 'string')
  assert.strictEqual(out.template, names[0])
  assert.strictEqual(out.revision, revision(out.prompt), 'revision must match the rendered prompt')
})

check('the same template with different variables gets a different revision', () => {
  const names = listTemplates()
  const a = renderWithRevision(names[0], { transaction: 'tx-a' })
  const b = renderWithRevision(names[0], { transaction: 'tx-b' })
  if (a.prompt === b.prompt) {
    // the template may not use that variable at all - then the revisions must match
    assert.strictEqual(a.revision, b.revision)
  } else {
    assert.notStrictEqual(a.revision, b.revision)
  }
})

const failed = results.filter(([s]) => s === 'fail')
for (const [s, n] of results) console.log((s === 'pass' ? '  ok   ' : '  FAIL ') + n)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
