import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { summarizeUsageByPhase } from '../agents/usage.js'
import {
  reconcilePaymentAttempt,
  selectPendingAttempts,
  summarizePaymentAttempts,
  upsertPaymentAttempt,
} from '../agents/payment-attempts.js'

// Schema versioning constants
const CURRENT_SCHEMA_VERSION = 1
const LEGACY_VERSION = 0 // Unversioned files

// Machine-readable recovery reason (issue #139). A run left `status:
// 'running'` in persisted history when the store is (re)initialized never
// had its in-process orchestration work survive the restart — there is no
// promise, no timer, nothing left executing it — so it must not be allowed
// to look like it is still progressing forever.
export const INTERRUPTED_REASON_SERVER_RESTART = 'server_restart'

function createRunId() {
  return `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

function normalizeLimit(limit, fallback = 20, max = 200) {
  const parsed = Number.parseInt(limit, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

function toAuditEvent(event) {
  return {
    type: event.type || 'unknown',
    timestamp: event.timestamp || new Date().toISOString(),
    agentId: event.agentId || null,
    agent: event.agent || null,
    cost: event.cost || null,
    paidVia: event.paidVia || null,
    txHash: event.txHash || null,
    explorerUrl: event.explorerUrl || null,
    status: event.status || null,
    totalSpent: event.totalSpent || null,
    reason: event.reason || null,
  }
}

function hasPersistedRunOutput(run) {
  if (!run || typeof run !== 'object') return false

  const outputCandidates = [run.output, run.result?.output, run.result?.results, run.plan]

  return outputCandidates.some((value) => {
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === 'object') return true
    return Boolean(value)
  })
}

function normalizeRunRecord(run) {
  if (!run || typeof run !== 'object') return run

  const hasExplicitOutput = Object.prototype.hasOwnProperty.call(run, 'output')
  const explicitOutput = hasExplicitOutput ? run.output : undefined
  const outputFromRun = hasExplicitOutput
    ? Array.isArray(explicitOutput)
      ? explicitOutput
      : (explicitOutput ?? null)
    : Array.isArray(run.result?.output)
      ? run.result.output
      : Array.isArray(run.result?.results)
        ? run.result.results
        : Array.isArray(run.results) && run.results.length > 0
          ? run.results
          : null

  const normalized = {
    ...run,
    plan: run.plan ?? run.result?.plan ?? null,
    results: Array.isArray(run.results) ? run.results : (outputFromRun ?? []),
    output: outputFromRun ?? null,
    error: run.error ?? null,
    summary: run.summary ?? null,
    usage: run.usage ?? null,
    txProofs: Array.isArray(run.txProofs) ? run.txProofs : [],
    events: Array.isArray(run.events) ? run.events : [],
  }

  normalized.outputAvailable = Boolean(
    run.outputAvailable ?? (run.status === 'completed' && hasPersistedRunOutput(normalized))
  )

  if (normalized.status === 'failed') {
    normalized.outputAvailable = false
  }

  if (!normalized.output && normalized.status !== 'completed') {
    normalized.output = null
  }

  if (!normalized.results && normalized.status === 'completed' && !normalized.output) {
    normalized.results = []
  }

  return normalized
}

export class InMemoryRunHistoryStore {
  constructor(maxRuns = 200) {
    this.maxRuns = maxRuns
    this.runs = []
    this.idempotencyMap = new Map()
  }

  async init() {}

  async createRun({ task, budget, source, idempotencyKey, idempotencyFingerprint }) {
    const now = new Date().toISOString()
    const run = {
      id: createRunId(),
      task,
      budget,
      source: source || 'api',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      summary: null,
      plan: null,
      results: null,
      output: null,
      outputAvailable: false,
      error: null,
      events: [],
      txProofs: [],
      // Payment attempts for this run (#131). Each entry is one logical
      // charge; an `unknown` attempt stays here until reconciliation
      // resolves it, so it is never silently settled twice.
      paymentAttempts: [],
      // Provider token usage — kept separate from `summary` (settled
      // marketplace charges) so it never alters or masquerades as those
      // totals. Absent/unknown usage is represented explicitly, not as 0.
      usage: null,
      idempotencyKey: idempotencyKey || null,
      idempotencyFingerprint: idempotencyFingerprint || null,
    }
    this.runs.unshift(run)
    this.runs = this.runs.slice(0, this.maxRuns)
    if (idempotencyKey) {
      this.idempotencyMap.set(idempotencyKey, {
        runId: run.id,
        fingerprint: idempotencyFingerprint,
        createdAt: now,
      })
    }
    return { ...run, runId: run.id }
  }

  async getRun(runId) {
    const run = this.runs.find((entry) => entry.id === runId)
    if (!run) return null
    return normalizeRunRecord({
      ...run,
      runId: run.id,
    })
  }

  async getIdempotencyRecord(key) {
    if (!key) return null
    return this.idempotencyMap.get(key) || null
  }

  async appendEvent(runId, event) {
    const run = this.runs.find((entry) => entry.id === runId)
    if (!run) return
    run.events.push(toAuditEvent(event))
    run.updatedAt = new Date().toISOString()
  }

  /**
   * Persists one payment attempt, upserted by its id.
   *
   * Upsert-by-id is what keeps "one logical charge, one record" true across
   * retries, recovery, and restarts: a recovered settlement replaces the
   * original attempt instead of appending a second one.
   */
  async recordPaymentAttempt(runId, attempt) {
    const run = this.runs.find((entry) => entry.id === runId)
    if (!run || !attempt) return null
    run.paymentAttempts = upsertPaymentAttempt(run.paymentAttempts, attempt)
    run.pendingPaymentAttempts = selectPendingAttempts(run.paymentAttempts)
    run.updatedAt = new Date().toISOString()
    return attempt
  }

  /** Every attempt still awaiting reconciliation, newest run first. */
  async getPendingPayments() {
    return this.runs.flatMap((run) =>
      selectPendingAttempts(run.paymentAttempts).map((attempt) => ({
        runId: run.id,
        task: run.task,
        attempt,
      }))
    )
  }

  /**
   * Runs one reconciliation pass over attempts that are still pending.
   *
   * `probe(attempt)` is read-only by contract: it answers whether the earlier
   * settlement completed and never starts a new one. Attempts it cannot
   * resolve stay pending, which is what keeps a later fallback settlement
   * from charging the same logical call twice.
   */
  async reconcilePendingPayments(probe, { runId } = {}) {
    const runs = runId ? this.runs.filter((entry) => entry.id === runId) : this.runs
    const reconciled = []
    for (const run of runs) {
      for (const attempt of selectPendingAttempts(run.paymentAttempts)) {
        const resolved = await reconcilePaymentAttempt(attempt, { probe })
        if (resolved && resolved !== attempt) {
          run.paymentAttempts = upsertPaymentAttempt(run.paymentAttempts, resolved)
          reconciled.push(resolved)
        }
      }
      if (reconciled.length > 0) {
        run.pendingPaymentAttempts = selectPendingAttempts(run.paymentAttempts)
        run.paymentAttemptSummary = summarizePaymentAttempts(run.paymentAttempts)
        run.updatedAt = new Date().toISOString()
      }
    }
    return reconciled
  }

  async completeRun(runId, result) {
    const run = this.runs.find((entry) => entry.id === runId)
    if (!run) return

    const txProofs = (result.payments || [])
      .filter((payment) => payment.paymentSuccess)
      .map((payment) => ({
        method: payment.paidVia || payment.paymentMethod || 'unknown',
        txHash: payment.txHash || null,
        explorerUrl: payment.explorerUrl || null,
      }))

    const completedOutput = Array.isArray(result.output)
      ? result.output
      : Array.isArray(result.results)
        ? result.results
        : null

    run.status = 'completed'
    run.completedAt = new Date().toISOString()
    run.updatedAt = run.completedAt
    run.summary = {
      totalSpent: result.totalSpent,
      budget: result.budget,
      budgetExhausted: result.budgetExhausted,
      paymentProtocol: result.paymentProtocol,
      txCount: result.txCount,
      x402PaymentCount: result.x402PaymentCount,
      xlmFallbackCount: result.xlmFallbackCount,
      unpaidCount: result.unpaidCount,
      elapsed: result.elapsed,
    }
    run.plan = result.plan || null
    run.results = Array.isArray(result.results) ? result.results : completedOutput || []
    run.output = completedOutput || run.results || null
    run.result = result
    run.outputAvailable = true
    run.txProofs = txProofs
    // Attempts produced by this run. `unknown` ones stay pending so a later
    // reconciliation pass can resolve them without a second settlement
    // (#131) — they are never reported as settled charges.
    run.paymentAttempts = (result.paymentAttempts || []).reduce(
      (list, attempt) => upsertPaymentAttempt(list, attempt),
      run.paymentAttempts || []
    )
    run.pendingPaymentAttempts = selectPendingAttempts(run.paymentAttempts)
    run.paymentAttemptSummary = summarizePaymentAttempts(run.paymentAttempts)
    // Persist provider usage as its own field — never folded into
    // `run.summary`'s settled marketplace totals above. If the orchestrator
    // result carries no usage (defensive default), fall back to an
    // explicitly-empty summary rather than fabricating zeros for a run that
    // may well have made real provider calls.
    run.usage = {
      entries: result.usage?.entries || [],
      summary: result.usage?.summary || summarizeUsageByPhase([]),
    }
  }

  async failRun(runId, err) {
    const run = this.runs.find((entry) => entry.id === runId)
    if (!run) return
    run.status = 'failed'
    run.completedAt = new Date().toISOString()
    run.updatedAt = run.completedAt
    run.summary = {
      error: err?.message || 'unknown error',
    }
    run.error = {
      message: err?.message || 'unknown error',
      code: err?.code || 'EXECUTION_FAILED',
    }
    run.output = null
    run.results = Array.isArray(run.results) ? run.results : []
    run.outputAvailable = false
  }

  /**
   * Recover runs that were left `status: 'running'` when this store was
   * (re)initialized — orphaned by a previous process exiting or crashing
   * mid-orchestration (issue #139).
   *
   * This never replays or re-drives agent/payment work (out of scope for
   * this issue) and never touches anything already captured for the run —
   * `events`, `results`, `plan`, `usage`, `txProofs` are left exactly as
   * they were, so confirmed payment proofs and completed step outputs
   * survive untouched and any payment whose outcome was still uncertain at
   * the time of the crash remains visible for manual/future reconciliation
   * rather than being overwritten or silently discarded. Only a terminal
   * `status` plus a timestamped, machine-readable reason are added, so the
   * run stops looking like it is executing forever and no automatic new
   * charge or retry is triggered.
   *
   * @returns {Promise<string[]>} ids of runs that were recovered
   */
  async recoverInterruptedRuns() {
    const recoveredIds = []
    const now = new Date().toISOString()

    for (const run of this.runs) {
      if (run.status !== 'running') continue

      run.status = 'interrupted'
      run.interruptedAt = now
      run.interruptedReason = INTERRUPTED_REASON_SERVER_RESTART
      run.updatedAt = now
      run.events.push(
        toAuditEvent({
          type: 'run_interrupted',
          reason: INTERRUPTED_REASON_SERVER_RESTART,
          status: 'interrupted',
          timestamp: now,
        })
      )
      recoveredIds.push(run.id)
    }

    return recoveredIds
  }

  async listRecent(limit = 20) {
    return this.runs
      .slice(0, normalizeLimit(limit, 20, this.maxRuns))
      .map((run) => normalizeRunRecord({ ...run, runId: run.id }))
  }

  async flush() {
    return Promise.resolve()
  }
}

export class FileRunHistoryStore extends InMemoryRunHistoryStore {
  constructor(filePath, maxRuns = 200) {
    super(maxRuns)
    this.filePath = filePath
    this._writeQueue = Promise.resolve()
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })

    // Step 1: read the file. Distinguish "doesn't exist yet" (first startup)
    // from permission/I-O failures (fail-start, never overwrite) from a
    // readable-but-corrupt file (recovery mode, see below).
    let raw
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        // First startup: nothing to preserve, safe to create a fresh store.
        await this.persist()
        return
      }
      // Inaccessible file (permissions, I/O error, etc). This is NOT a
      // first startup and NOT corruption we can safely recover from — the
      // file may be perfectly readable once the underlying problem is
      // fixed. Fail loudly, leave the file untouched, and let the operator
      // decide instead of silently replacing it with an empty history.
      this.failStart(
        `unable to read history file at ${this.filePath} (${err.code || err.name || 'read error'}). ` +
          'Check file permissions/disk health and restart; the file was left untouched.',
        err
      )
    }

    // Step 2: parse. A read that succeeds but doesn't parse is malformed
    // JSON — preserve the original bytes before attempting recovery.
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      await this.handleCorruptedFile('malformed JSON', err)
      await this.persist()
      return
    }

    // Step 3: validate/migrate. An incompatible-but-newer schema fails
    // without touching the file; anything else that fails validation is
    // treated like corruption — preserved, then recovered.
    let version, runs, idempotency
    try {
      ;({ version, runs, idempotency } = this.validateAndMigrate(parsed))
    } catch (err) {
      if (err.message?.includes('Unsupported schema version')) {
        // Newer format than we understand - fail without rewriting.
        console.error(`  run history: ${err.message}`)
        throw err
      }
      await this.handleCorruptedFile('invalid schema', err)
      await this.persist()
      return
    }

    if (Array.isArray(runs)) {
      this.runs = runs.slice(0, this.maxRuns)
    }
    if (Array.isArray(idempotency)) {
      for (const [key, record] of idempotency) {
        this.idempotencyMap.set(key, record)
      }
    }
    for (const run of this.runs) {
      if (run.idempotencyKey && !this.idempotencyMap.has(run.idempotencyKey)) {
        this.idempotencyMap.set(run.idempotencyKey, {
          runId: run.id,
          fingerprint: run.idempotencyFingerprint,
          createdAt: run.createdAt,
        })
      }
    }
    // If migration occurred, persist the new format
    if (version === LEGACY_VERSION) {
      await this.persist()
    }
  }

  /**
   * Raises an actionable, task-content-free error for conditions the
   * operator must resolve manually (permissions, I/O failures). Never
   * includes file contents — only path and error code/name.
   * @param {string} message
   * @param {Error} [cause]
   */
  failStart(message, cause) {
    const actionable = new Error(`run history: ${message}`)
    if (cause) actionable.cause = cause
    if (cause?.code) actionable.code = cause.code
    console.error(actionable.message)
    throw actionable
  }

  /**
   * Validates schema version and migrates if needed
   * @param {object} data - Parsed file content
   * @returns {object} { version, runs } - Validated and potentially migrated data
   */
  validateAndMigrate(data) {
    // Check for version field
    if (data.version === undefined) {
      // Legacy unversioned format (version 0)
      console.warn('  run history: migrating legacy unversioned format to version 1')
      return {
        version: LEGACY_VERSION,
        runs: (data.runs || []).map((run) => normalizeRunRecord(run)),
        idempotency: data.idempotency || [],
      }
    }

    // Validate version is a number
    const version = Number.parseInt(data.version, 10)
    if (!Number.isFinite(version)) {
      throw new Error(`Invalid schema version: ${data.version}`)
    }

    // Check if version is newer than what we support
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported schema version ${version}. Current supported version is ${CURRENT_SCHEMA_VERSION}. ` +
          'Please upgrade the application to support this format.'
      )
    }

    // Version is within supported range
    return {
      version,
      runs: (data.runs || []).map((run) => normalizeRunRecord(run)),
      idempotency: data.idempotency || [],
    }
  }

  /**
   * Preserves a readable-but-unusable file (malformed JSON or an
   * incompatible/invalid schema) before recovery starts a fresh store.
   * The original bytes are moved aside, never discarded, so an operator
   * can inspect or repair them later. Only the error's category/code is
   * logged — never file contents — since a run's `task` field may hold
   * arbitrary operator-supplied text.
   * @param {string} reason - short category, e.g. "malformed JSON"
   * @param {Error} err - the error that occurred
   */
  async handleCorruptedFile(reason, err) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.filePath}.corrupted.${timestamp}`
    console.error(`  run history: ${reason} detected, preserving original at ${backupPath}`)
    console.error(`  run history: reason: ${err.code || err.name || err.message}`)
    try {
      await fs.rename(this.filePath, backupPath)
    } catch (renameErr) {
      // Could not move the original aside — refuse to overwrite it with a
      // fresh empty store, since that would destroy the only copy.
      this.failStart(
        `failed to preserve unreadable file before recovery (${renameErr.code || renameErr.message}). ` +
          `Refusing to overwrite ${this.filePath}; move or fix it manually and restart.`,
        renameErr
      )
    }
  }

  async persist() {
    const writeOp = async () => {
      const payload = JSON.stringify(
        {
          version: CURRENT_SCHEMA_VERSION,
          runs: this.runs.slice(0, this.maxRuns),
          idempotency: Array.from(this.idempotencyMap.entries()).slice(0, this.maxRuns),
        },
        null,
        2
      )
      const tempPath = `${this.filePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fs.writeFile(tempPath, payload, 'utf8')
        await fs.rename(tempPath, this.filePath)
      } catch (err) {
        try {
          await fs.unlink(tempPath).catch(() => {})
        } catch {}
        throw err
      }
    }

    this._writeQueue = this._writeQueue.catch(() => {}).then(writeOp)
    return this._writeQueue
  }

  async flush() {
    return this._writeQueue
  }

  async createRun(payload) {
    const run = await super.createRun(payload)
    await this.persist()
    return run
  }

  async appendEvent(runId, event) {
    await super.appendEvent(runId, event)
    await this.persist()
  }

  async recordPaymentAttempt(runId, attempt) {
    const result = await super.recordPaymentAttempt(runId, attempt)
    await this.persist()
    return result
  }

  async reconcilePendingPayments(probe, options) {
    const reconciled = await super.reconcilePendingPayments(probe, options)
    if (reconciled.length > 0) await this.persist()
    return reconciled
  }

  async completeRun(runId, result) {
    await super.completeRun(runId, result)
    await this.persist()
  }

  async failRun(runId, err) {
    await super.failRun(runId, err)
    await this.persist()
  }

  async recoverInterruptedRuns() {
    const recoveredIds = await super.recoverInterruptedRuns()
    if (recoveredIds.length > 0) {
      await this.persist()
    }
    return recoveredIds
  }
}

export async function createRunHistoryStore(config) {
  const storage = (config.runHistoryStorage || 'file').toLowerCase()
  const store =
    storage === 'memory'
      ? new InMemoryRunHistoryStore(config.runHistoryMaxRuns)
      : new FileRunHistoryStore(config.runHistoryFile, config.runHistoryMaxRuns)

  await store.init()

  // Startup recovery (issue #139): any run still `status: 'running'` at this
  // point belongs to a process that no longer exists.
  const recoveredIds = await store.recoverInterruptedRuns()
  if (recoveredIds.length > 0) {
    console.warn(
      `  run history: recovered ${recoveredIds.length} interrupted run(s) left "running" by a previous restart: ${recoveredIds.join(', ')}`
    )
  }

  return store
}
