/**
 * Guard tests for the default offline gate (#175).
 *
 * They exist so a regression suite can never quietly fall out of `npm test`:
 * discovery must pick up a brand-new file with no list to edit, an unexpected
 * test-shaped file must be reported instead of skipped, and a failing suite must
 * make the gate exit non-zero while naming itself.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverSuites,
  findUnclassifiedSuites,
  OPT_IN_DIRS,
} from '../scripts/run-offline-tests.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-offline-tests.js')

function makeTempRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stellarmind-gate-'))
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
  return root
}

describe('default offline gate', () => {
  it('runs the suites that used to sit outside the default gate', () => {
    const suites = discoverSuites({ repoRoot: REPO_ROOT })

    for (const expected of [
      'tests/sse-heartbeat.test.js',
      'tests/api.validation.test.js',
      'tests/docker-run-history.test.js',
      'src/agents/settlement-header.test.js',
    ]) {
      assert.ok(suites.includes(expected), `${expected} must be in the default gate`)
    }
    assert.ok(
      !suites.some((suite) => suite.startsWith('tests/load/')),
      'load scenarios stay opt-in'
    )
  })

  it('leaves no test-shaped file unclassified', () => {
    assert.deepStrictEqual(findUnclassifiedSuites({ repoRoot: REPO_ROOT }), [])
  })

  it('picks up a newly added suite without editing any list', () => {
    const root = makeTempRepo({
      'tests/new-regression.test.js': 'process.exit(0)\n',
      'tests/load/load-test.js': 'process.exit(0)\n',
    })

    assert.deepStrictEqual(discoverSuites({ repoRoot: root }), ['tests/new-regression.test.js'])
  })

  it('reports a test-shaped file that no discovery rule covers', () => {
    const root = makeTempRepo({
      'tests/new-regression.test.js': 'process.exit(0)\n',
      'tests/legacy-check-test.js': 'process.exit(0)\n',
    })

    assert.deepStrictEqual(findUnclassifiedSuites({ repoRoot: root }), [
      'tests/legacy-check-test.js',
    ])
  })

  it('exits non-zero and names the failing suite', () => {
    const root = makeTempRepo({
      'tests/passes.test.js': "console.log('all good')\nprocess.exit(0)\n",
      'tests/broken.test.js': "console.log('boom: broken expectation')\nprocess.exit(3)\n",
    })

    const result = spawnSync(process.execPath, [RUNNER, '--repo-root', root], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    const output = `${result.stdout}${result.stderr}`

    assert.strictEqual(result.status, 1, 'a failing suite must fail the gate')
    assert.match(output, /tests\/broken\.test\.js/, 'the failing suite must be named')
    assert.match(output, /Failed suites: tests\/broken\.test\.js/)
    assert.match(output, /✔ tests\/passes\.test\.js/, 'passing suites still run')
  })

  it('keeps opt-in directories explicit', () => {
    assert.ok(OPT_IN_DIRS.includes('tests/load'))
  })
})
