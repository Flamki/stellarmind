/**
 * Cross-platform & Windows compatibility regression tests (Issue #176)
 *
 * Covers:
 * - FileRunHistoryStore persistence and reload in workspace paths containing spaces
 * - Windows atomic file-replacement retry and copy+unlink fallback (EPERM/EACCES/EBUSY)
 * - CRLF line-ending tolerance in persisted run-history files
 * - Child-process cleanup and shell-agnostic contributor scripts
 * - CI matrix coverage for Ubuntu and Windows
 *
 * Run: node tests/windows-compat.test.js
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FileRunHistoryStore,
  createRunHistoryStore,
  replaceFileWithTemp,
} from '../src/storage/run-history.js'
import { terminateChildProcess } from './smoke.test.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
  }
}

console.log('Testing Windows & cross-platform compatibility (issue #176)...')

await test('FileRunHistoryStore persists and reloads across restarts in a path containing spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-win-spaces-'))
  try {
    const dirWithSpaces = path.join(tempRoot, 'StellarMind Contributor Workspace', 'Run History')
    const historyFile = path.join(dirWithSpaces, 'run-history.json')

    const store1 = await createRunHistoryStore({
      runHistoryStorage: 'file',
      runHistoryFile: historyFile,
      runHistoryMaxRuns: 50,
    })

    const created = await store1.createRun({
      task: 'Verify Windows path with spaces',
      budget: 5,
      source: 'test',
    })
    await store1.appendEvent(created.id, {
      type: 'agent_payment',
      agent: 'research-bot',
      paidVia: 'x402',
      txHash: 'tx_win_1',
      status: 'success',
    })
    await store1.completeRun(created.id, {
      totalSpent: '0.01',
      budget: 5,
      results: [{ agentId: 'research-bot', result: 'ok' }],
      payments: [{ paymentSuccess: true, paidVia: 'x402', txHash: 'tx_win_1' }],
    })
    await store1.flush()

    const store2 = await createRunHistoryStore({
      runHistoryStorage: 'file',
      runHistoryFile: historyFile,
      runHistoryMaxRuns: 50,
    })

    const reloaded = await store2.getRun(created.id)
    assert.ok(reloaded, 'Run should be reloaded from path containing spaces')
    assert.equal(reloaded.status, 'completed')
    assert.equal(reloaded.task, 'Verify Windows path with spaces')
    assert.equal(reloaded.txProofs.length, 1)
    assert.equal(reloaded.txProofs[0].txHash, 'tx_win_1')
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

await test('replaceFileWithTemp retries transient EPERM/EBUSY and falls back to copyFile + unlink', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-win-replace-'))
  try {
    const targetPath = path.join(tempRoot, 'run-history.json')
    const tempPath1 = path.join(tempRoot, 'run-history.json.1.tmp')
    const tempPath2 = path.join(tempRoot, 'run-history.json.2.tmp')

    await fs.writeFile(targetPath, '{"version":1,"runs":[]}', 'utf8')
    await fs.writeFile(tempPath1, '{"version":1,"runs":[{"id":"r1"}]}', 'utf8')

    // Case 1: transient EPERM succeeds on retry
    let renameCalls = 0
    await replaceFileWithTemp(tempPath1, targetPath, {
      ...fs,
      async rename(src, dest) {
        renameCalls += 1
        if (renameCalls < 2) {
          const err = new Error('EPERM: operation not permitted, rename')
          err.code = 'EPERM'
          throw err
        }
        return fs.rename(src, dest)
      },
    })
    assert.equal(renameCalls, 2)
    assert.equal(
      JSON.parse(await fs.readFile(targetPath, 'utf8')).runs[0].id,
      'r1',
      'Transient EPERM retry should replace target file'
    )

    // Case 2: persistent EPERM falls back to copyFile + unlink
    await fs.writeFile(tempPath2, '{"version":1,"runs":[{"id":"r2"}]}', 'utf8')
    await replaceFileWithTemp(tempPath2, targetPath, {
      ...fs,
      async rename() {
        const err = new Error('EPERM: persistent Windows destination lock')
        err.code = 'EPERM'
        throw err
      },
    })
    assert.equal(
      JSON.parse(await fs.readFile(targetPath, 'utf8')).runs[0].id,
      'r2',
      'copyFile + unlink fallback should replace target file when rename persistently fails with EPERM'
    )
    const remainingFiles = await fs.readdir(tempRoot)
    assert.deepEqual(remainingFiles, ['run-history.json'], 'Temporary file should be cleaned up')
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

await test('FileRunHistoryStore tolerates CRLF line endings in persisted history files', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-win-crlf-'))
  try {
    const historyFile = path.join(tempRoot, 'run-history.json')
    const crlfPayload = [
      '{',
      '  "version": 1,',
      '  "runs": [',
      '    {',
      '      "id": "run_crlf_1",',
      '      "task": "CRLF line ending check",',
      '      "budget": 10,',
      '      "status": "completed",',
      '      "createdAt": "2025-01-01T00:00:00.000Z",',
      '      "updatedAt": "2025-01-01T00:00:01.000Z",',
      '      "completedAt": "2025-01-01T00:00:01.000Z",',
      '      "results": [{"agentId": "summary-bot", "result": "ok"}],',
      '      "output": [{"agentId": "summary-bot", "result": "ok"}],',
      '      "outputAvailable": true,',
      '      "events": [],',
      '      "txProofs": []',
      '    }',
      '  ],',
      '  "idempotency": []',
      '}',
    ].join('\r\n')

    await fs.writeFile(historyFile, crlfPayload, 'utf8')

    const store = new FileRunHistoryStore(historyFile, 50)
    await store.init()

    const loaded = await store.getRun('run_crlf_1')
    assert.ok(loaded, 'Run should load from CRLF-formatted file')
    assert.equal(loaded.task, 'CRLF line ending check')
    assert.equal(loaded.outputAvailable, true)
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

await test('terminateChildProcess cleans up spawned child process in a cwd with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-win-proc-'))
  try {
    const cwdWithSpaces = path.join(tempRoot, 'Child Process Workspace')
    await fs.mkdir(cwdWithSpaces, { recursive: true })

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: cwdWithSpaces,
      stdio: 'ignore',
    })

    assert.ok(child.pid, 'Child process should start')
    await terminateChildProcess(child, 1000)
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      'Child process should be terminated and cleaned up'
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

await test('CI workflow exercises Ubuntu and Windows on the pinned Node runtime', async () => {
  const ciYaml = await fs.readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ciYaml, /windows-latest/, 'CI workflow should include windows-latest')
  assert.match(ciYaml, /ubuntu-latest/, 'CI workflow should include ubuntu-latest')
  assert.match(ciYaml, /node-version-file:\s*['"]?\.nvmrc['"]?/, 'CI should use .nvmrc runtime')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
