import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  FileRunHistoryStore,
  backupRunHistory,
  restoreRunHistory,
  verifyRunHistoryFile,
} from '../src/storage/run-history.js'
import { runHistoryCli } from '../src/run-history-backup.js'

async function withTempDirs(fn) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-backup-test-'))
  const sourceDir = path.join(baseDir, 'source')
  const backupDir = path.join(baseDir, 'backups')
  const restoreDir = path.join(baseDir, 'restored')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.mkdir(backupDir, { recursive: true })
  await fs.mkdir(restoreDir, { recursive: true })
  try {
    await fn({ baseDir, sourceDir, backupDir, restoreDir })
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true })
  }
}

async function seedMixedRunHistory(filePath) {
  const store = new FileRunHistoryStore(filePath, 200)
  await store.init()

  // 1. Completed run with payment proofs and output
  const completedRun = await store.createRun({
    task: 'Analyze Stellar micropayment adoption',
    budget: 0.15,
    source: 'api',
    idempotencyKey: 'idem-completed-1',
    idempotencyFingerprint: 'fp-completed-1',
  })
  await store.completeRun(completedRun.id, {
    task: completedRun.task,
    budget: 0.15,
    totalSpent: '0.06',
    quotedTotal: '0.06',
    settledTotals: [{ asset: 'USDC', amount: '0.06' }],
    settledSummary: '0.06 USDC',
    budgetExhausted: false,
    paymentProtocol: 'x402',
    txCount: 2,
    x402PaymentCount: 2,
    xlmFallbackCount: 0,
    unpaidCount: 0,
    elapsed: '410ms',
    plan: {
      plan: 'Research then analyze',
      subtasks: [
        { agentId: 'research-bot', input: 'Stellar adoption', cost: '0.01' },
        { agentId: 'analyst-bot', input: 'Stellar adoption', cost: '0.05' },
      ],
    },
    results: [
      { agentId: 'research-bot', result: 'Research output text' },
      { agentId: 'analyst-bot', result: 'Analysis output text' },
    ],
    output: [
      { agentId: 'research-bot', result: 'Research output text' },
      { agentId: 'analyst-bot', result: 'Analysis output text' },
    ],
    payments: [
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'tx_hash_research_001',
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/tx_hash_research_001',
        settledAmount: '0.01',
        settledAmountExact: '100000',
        settledAsset: 'USDC',
        settledNetwork: 'stellar:testnet',
        quotedAmount: '0.01',
        quotedAsset: 'USDC',
      },
      {
        paymentSuccess: true,
        paidVia: 'x402',
        txHash: 'tx_hash_analysis_002',
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/tx_hash_analysis_002',
        settledAmount: '0.05',
        settledAmountExact: '500000',
        settledAsset: 'USDC',
        settledNetwork: 'stellar:testnet',
        quotedAmount: '0.05',
        quotedAsset: 'USDC',
      },
    ],
  })

  // 2. Interrupted run recovered after restart
  const interruptedRun = await store.createRun({
    task: 'Summarize whitepaper',
    budget: 0.05,
    source: 'api',
  })
  await store.appendEvent(interruptedRun.id, {
    type: 'x402_payment',
    agentId: 'summary-bot',
    paidVia: 'x402',
    txHash: 'tx_hash_interrupted_003',
    amount: '0.01',
    asset: 'USDC',
  })
  await store.recoverInterruptedRuns()

  // 3. Failed run
  const failedRun = await store.createRun({
    task: 'Generate Soroban contract',
    budget: 0.05,
    source: 'api',
  })
  await store.failRun(
    failedRun.id,
    Object.assign(new Error('Provider timeout'), { code: 'TIMEOUT' })
  )

  await store.flush()
  return {
    store,
    completedRunId: completedRun.id,
    interruptedRunId: interruptedRun.id,
    failedRunId: failedRun.id,
  }
}

describe('Verified backup and restore workflow for file-based run history (#183)', () => {
  it('backs up completed, interrupted, and failed runs with payment proofs and restores into a fresh directory', async () => {
    await withTempDirs(async ({ sourceDir, backupDir, restoreDir }) => {
      const sourcePath = path.join(sourceDir, 'run-history.json')
      const backupPath = path.join(backupDir, 'run-history.backup.json')
      const restoredPath = path.join(restoreDir, 'run-history.json')

      const { store, completedRunId, interruptedRunId, failedRunId } =
        await seedMixedRunHistory(sourcePath)

      const backupReport = await store.createBackup(backupPath)
      assert.equal(backupReport.valid, true)
      assert.equal(backupReport.version, 1)
      assert.equal(backupReport.runCount, 3)
      assert.deepEqual(backupReport.statusCounts, {
        completed: 1,
        interrupted: 1,
        failed: 1,
        running: 0,
      })
      assert.equal(backupReport.txProofCount, 2)
      assert.equal(backupReport.outputAvailableCount, 1)
      assert.equal(backupReport.idempotencyCount, 1)
      assert.match(backupReport.checksum, /^[a-f0-9]{64}$/)

      const restoreReport = await restoreRunHistory(backupPath, restoredPath)
      assert.equal(restoreReport.valid, true)
      assert.equal(restoreReport.runCount, 3)
      assert.equal(restoreReport.txProofCount, 2)
      assert.equal(restoreReport.checksum, backupReport.checksum)
      assert.equal(restoreReport.previousBackupPath, null)

      const restoredStore = new FileRunHistoryStore(restoredPath, 200)
      await restoredStore.init()

      const restoredCompleted = await restoredStore.getRun(completedRunId)
      assert.equal(restoredCompleted.status, 'completed')
      assert.equal(restoredCompleted.outputAvailable, true)
      assert.equal(restoredCompleted.output.length, 2)
      assert.equal(restoredCompleted.txProofs.length, 2)
      assert.equal(restoredCompleted.txProofs[0].txHash, 'tx_hash_research_001')
      assert.equal(restoredCompleted.txProofs[1].txHash, 'tx_hash_analysis_002')

      const restoredInterrupted = await restoredStore.getRun(interruptedRunId)
      assert.equal(restoredInterrupted.status, 'interrupted')
      assert.equal(restoredInterrupted.events[0].txHash, 'tx_hash_interrupted_003')

      const restoredFailed = await restoredStore.getRun(failedRunId)
      assert.equal(restoredFailed.status, 'failed')
      assert.equal(restoredFailed.error.code, 'TIMEOUT')

      const idemRecord = await restoredStore.getIdempotencyRecord('idem-completed-1')
      assert.equal(idemRecord.runId, completedRunId)
    })
  })

  it('preserves an existing target history file before replacing it on valid restore', async () => {
    await withTempDirs(async ({ sourceDir, backupDir, restoreDir }) => {
      const sourcePath = path.join(sourceDir, 'run-history.json')
      const backupPath = path.join(backupDir, 'snapshot.backup.json')
      const targetPath = path.join(restoreDir, 'run-history.json')

      await seedMixedRunHistory(sourcePath)
      await backupRunHistory(sourcePath, backupPath)

      // Create an existing store at targetPath with 1 run
      const existingStore = new FileRunHistoryStore(targetPath, 200)
      await existingStore.init()
      const existingRun = await existingStore.createRun({
        task: 'Pre-existing run before restore',
        budget: 0.05,
      })
      await existingStore.flush()

      const restoreReport = await restoreRunHistory(backupPath, targetPath)
      assert.ok(restoreReport.previousBackupPath)
      const preservedPreRestore = JSON.parse(
        await fs.readFile(restoreReport.previousBackupPath, 'utf8')
      )
      assert.equal(preservedPreRestore.runs.length, 1)
      assert.equal(preservedPreRestore.runs[0].id, existingRun.id)
    })
  })

  it('leaves the existing store completely intact when restoring an invalid, corrupted, or incompatible backup', async () => {
    await withTempDirs(async ({ backupDir, restoreDir }) => {
      const targetPath = path.join(restoreDir, 'run-history.json')
      const { store, completedRunId } = await seedMixedRunHistory(targetPath)
      const originalBytes = await fs.readFile(targetPath, 'utf8')

      // Case 1: Malformed JSON backup
      const malformedBackup = path.join(backupDir, 'malformed.backup.json')
      await fs.writeFile(malformedBackup, '{ broken json ', 'utf8')
      await assert.rejects(
        () => store.restoreFromBackup(malformedBackup),
        (err) => err.code === 'INVALID_BACKUP_JSON'
      )
      assert.equal(await fs.readFile(targetPath, 'utf8'), originalBytes)

      // Case 2: Unsupported future schema version
      const futureBackup = path.join(backupDir, 'future.backup.json')
      await fs.writeFile(futureBackup, JSON.stringify({ version: 999, runs: [] }, null, 2), 'utf8')
      await assert.rejects(
        () => store.restoreFromBackup(futureBackup),
        (err) => err.code === 'UNSUPPORTED_SCHEMA_VERSION'
      )
      assert.equal(await fs.readFile(targetPath, 'utf8'), originalBytes)

      // Case 3: Invalid run record inside backup
      const badRecordBackup = path.join(backupDir, 'bad-record.backup.json')
      await fs.writeFile(
        badRecordBackup,
        JSON.stringify(
          {
            version: 1,
            runs: [{ id: 'run_bad_status', status: 'not_a_real_status' }],
          },
          null,
          2
        ),
        'utf8'
      )
      await assert.rejects(
        () => store.restoreFromBackup(badRecordBackup),
        (err) => err.code === 'INVALID_RUN_RECORD'
      )
      assert.equal(await fs.readFile(targetPath, 'utf8'), originalBytes)

      // Case 4: Tampered backup payload failing SHA-256 checksum
      const validBackup = path.join(backupDir, 'valid.backup.json')
      await store.createBackup(validBackup)
      const tamperedData = JSON.parse(await fs.readFile(validBackup, 'utf8'))
      const completedIdx = tamperedData.runs.findIndex((r) => r.id === completedRunId)
      tamperedData.runs[completedIdx].txProofs = []
      const tamperedBackup = path.join(backupDir, 'tampered.backup.json')
      await fs.writeFile(tamperedBackup, JSON.stringify(tamperedData, null, 2), 'utf8')

      await assert.rejects(
        () => store.restoreFromBackup(tamperedBackup),
        (err) => err.code === 'BACKUP_CHECKSUM_MISMATCH'
      )
      assert.equal(await fs.readFile(targetPath, 'utf8'), originalBytes)

      // Confirm in-memory store still has all original runs and proofs intact
      const stillIntact = await store.getRun(completedRunId)
      assert.equal(stillIntact.txProofs.length, 2)
    })
  })

  it('supports CLI backup, verify, and restore subcommands', async () => {
    await withTempDirs(async ({ sourceDir, backupDir, restoreDir }) => {
      const sourcePath = path.join(sourceDir, 'run-history.json')
      const backupPath = path.join(backupDir, 'cli.backup.json')
      const restoredPath = path.join(restoreDir, 'run-history.json')

      await seedMixedRunHistory(sourcePath)

      const cliBackup = await runHistoryCli(['backup', sourcePath, backupPath])
      assert.equal(cliBackup.runCount, 3)
      assert.equal(cliBackup.txProofCount, 2)

      const cliVerify = await runHistoryCli(['verify', backupPath])
      assert.equal(cliVerify.valid, true)
      assert.equal(cliVerify.checksum, cliBackup.checksum)

      const cliRestore = await runHistoryCli(['restore', backupPath, restoredPath])
      assert.equal(cliRestore.valid, true)
      assert.equal(cliRestore.runCount, 3)

      const verifiedRestored = await verifyRunHistoryFile(restoredPath)
      assert.equal(verifiedRestored.txProofCount, 2)
    })
  })
})
