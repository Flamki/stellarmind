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
import {
  formatSettledTotals,
  SETTLEMENT_CONVERSION_POLICY,
  summarizeSettledTotals,
} from '../agents/settlement.js'
import { DEFAULT_NETWORK, explorerTxUrl, getNetworkProfile } from '../stellar/network.js'

// Schema versioning constants
const CURRENT_SCHEMA_VERSION = 1
const LEGACY_VERSION = 0 // Unversioned files
export const REPORT_SCHEMA_VERSION = '1.0'

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
    // The settled asset and amount travel with the persisted event so a
    // payment proof keeps its asset across a restart (#130). `cost` above stays
    // the quoted price.
    amount: event.amount ?? null,
    asset: event.asset || event.settledAsset || null,
    issuer: event.issuer || event.settledIssuer || null,
    network: event.network || event.settledNetwork || null,
    quotedAmount: event.quotedAmount ?? null,
    quotedAsset: event.quotedAsset || event.currency || null,
    paidVia: event.paidVia || null,
    txHash: event.txHash || null,
    explorerUrl: event.explorerUrl || null,
    status: event.status || null,
    totalSpent: event.totalSpent || null,
    quotedTotal: event.quotedTotal || null,
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

    // A proof is only useful if it names the asset and amount that settled,
    // not the quote the run reserved (#130). Unpaid/pending steps never reach
    // this list because they are filtered out here.
    const txProofs = (result.payments || [])
      .filter((payment) => payment.paymentSuccess)
      .map((payment) => ({
        method: payment.paidVia || payment.paymentMethod || 'unknown',
        txHash: payment.txHash || null,
        explorerUrl: payment.explorerUrl || null,
        amount: payment.settledAmount ?? payment.settlement?.amount ?? null,
        amountExact: payment.settledAmountExact ?? payment.settlement?.amountExact ?? null,
        asset: payment.settledAsset ?? payment.settlement?.asset ?? null,
        issuer: payment.settledIssuer ?? payment.settlement?.issuer ?? null,
        network: payment.settledNetwork ?? payment.settlement?.network ?? null,
        quotedAmount: payment.quotedAmount ?? null,
        quotedAsset: payment.quotedAsset ?? null,
        settlementPolicy: payment.settlement?.policy ?? null,
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
      // `totalSpent` stays the quoted/reserved amount the budget guardrail
      // tracked. The per-asset settled totals below are the money that moved.
      totalSpent: result.totalSpent,
      quotedTotal: result.quotedTotal ?? result.totalSpent,
      settledTotals: result.settledTotals || [],
      settledSummary: result.settledSummary || 'none',
      settlementConversionPolicy: result.settlementConversionPolicy || {
        applied: false,
        reason: 'No cross-asset conversion is configured.',
      },
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

  async exportRun(runId, format = 'json', options = {}) {
    const run = await this.getRun(runId)
    if (!run) return null
    const report = buildRunReport(run, options)
    const normalizedFormat = String(format || 'json').toLowerCase()
    if (normalizedFormat === 'md' || normalizedFormat === 'markdown') {
      return {
        format: 'markdown',
        contentType: 'text/markdown; charset=utf-8',
        filename: `run-${report.runId}-report.md`,
        body: formatRunReportMarkdown(report),
        report,
      }
    }
    return {
      format: 'json',
      contentType: 'application/json; charset=utf-8',
      filename: `run-${report.runId}-report.json`,
      body: JSON.stringify(report, null, 2),
      report,
    }
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

/**
 * Redacts credentials (API keys, Stellar secret keys, bearer tokens) and
 * deployment filesystem paths from exported text fields.
 */
export function redactSensitiveText(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    try {
      return redactSensitiveText(JSON.stringify(value))
    } catch {
      return String(value)
    }
  }
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/\bS[A-Z2-7]{55}\b/g, '[REDACTED_STELLAR_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(?:file:\/\/)?\/(?:home|tmp|var|usr|opt|etc|root|app|srv|Users|private)\/[A-Za-z0-9._/-]+/g,
      '[REDACTED_PATH]'
    )
    .replace(/[A-Za-z]:\\[A-Za-z0-9._\\-]+/g, '[REDACTED_PATH]')
}

function isSyntheticReceipt(item) {
  if (!item || typeof item !== 'object') return false
  if (item.synthetic === true || item.isSynthetic === true || item.mode === 'demo') return true
  const method = String(item.method || item.paidVia || item.paymentMethod || '').toLowerCase()
  if (method.includes('stub') || method.includes('synthetic') || method.includes('demo')) {
    return true
  }
  const policy = String(item.settlementPolicy || item.policy || '').toLowerCase()
  if (policy.includes('synthetic') || policy.includes('stub')) return true
  const txHash = String(item.txHash || '')
  if (/^(?:stub|demo|synthetic|mock)[_-]/i.test(txHash)) return true
  return false
}

function resolveReceiptExplorerUrl(txHash, network, existingUrl, isSynthetic) {
  if (!txHash || isSynthetic) return null
  const profile = getNetworkProfile(network || DEFAULT_NETWORK)
  if (profile) {
    return explorerTxUrl(profile, txHash)
  }
  return existingUrl ? redactSensitiveText(existingUrl) : null
}

function detectStepProvenanceMode(step, outputText) {
  if (step?.synthetic === true || step?.isSynthetic === true) return 'synthetic'
  if (step?.demo === true || step?.isDemo === true || step?.mode === 'demo') return 'demo'
  const explicitMode =
    step?.provenance?.mode || step?.provenance?.responseType || step?.responseType
  if (explicitMode) return String(explicitMode)
  if (
    typeof outputText === 'string' &&
    /\[Demo Response|\bDemo mode\b|Canned response/i.test(outputText)
  ) {
    return 'demo'
  }
  return 'live'
}

/**
 * Generates a versioned, sanitized run report from a persisted run record.
 * Omits deployment filesystem paths and credentials while preserving step
 * outcomes, provenance, actual settled asset amounts, and verifiable receipts.
 */
export function buildRunReport(rawRun, options = {}) {
  if (!rawRun || typeof rawRun !== 'object') {
    throw new Error('Cannot build report from empty run record')
  }

  const run = normalizeRunRecord(rawRun)
  const defaultNetwork =
    options.network || run.network || run.summary?.network || run.result?.network || DEFAULT_NETWORK
  const exportedAt = options.exportedAt || new Date().toISOString()
  const runId = String(run.id || run.runId || 'unknown')

  const rawSteps =
    Array.isArray(run.results) && run.results.length > 0
      ? run.results
      : Array.isArray(run.output) && run.output.length > 0
        ? run.output
        : Array.isArray(run.result?.results)
          ? run.result.results
          : Array.isArray(run.result?.output)
            ? run.result.output
            : []

  const steps = rawSteps.map((step, index) => {
    const rawOutput =
      step.output ?? step.result ?? step.response ?? step.text ?? step.content ?? null
    const output =
      rawOutput !== null && rawOutput !== undefined ? redactSensitiveText(rawOutput) : null
    const skipped = Boolean(step.skipped)
    const hasError =
      Boolean(step.error) ||
      step.status === 'failed' ||
      (typeof output === 'string' && output.startsWith('Error:'))
    const outcome = skipped
      ? 'skipped'
      : hasError
        ? 'failed'
        : String(step.outcome || step.status || 'completed')

    const settledAmount = step.settledAmount ?? step.settlement?.amount ?? null
    const settledAsset = step.settledAsset ?? step.settlement?.asset ?? null
    const settledIssuer = step.settledIssuer ?? step.settlement?.issuer ?? null
    const settledNetwork =
      step.settledNetwork ??
      step.settlement?.network ??
      (settledAmount && settledAsset ? defaultNetwork : null)
    const txHash = step.txHash ?? step.settlement?.txHash ?? null
    const synthetic = isSyntheticReceipt(step) || isSyntheticReceipt(step.settlement)
    const settled = Boolean(
      !skipped &&
      (step.paymentSuccess || step.settlement?.success || (settledAmount && settledAsset))
    )
    const pending = Boolean(
      step.paymentReconciliationRequired ||
      step.paymentAttempt?.outcome === 'unknown' ||
      step.paymentAttempt?.outcome === 'pending'
    )

    const quotedAmount =
      step.quotedAmount !== undefined && step.quotedAmount !== null
        ? String(step.quotedAmount)
        : step.quote?.amount !== undefined && step.quote?.amount !== null
          ? String(step.quote.amount)
          : step.cost !== undefined && step.cost !== null
            ? String(step.cost)
            : null
    const quotedAsset = String(step.quotedAsset || step.quote?.asset || step.currency || 'USDC')

    const provenanceMode = detectStepProvenanceMode(step, output)

    return {
      stepId: String(step.stepId || `step-${index + 1}`),
      index: index + 1,
      agentId: step.agentId || step.agent || null,
      agentName: step.agentName || step.agent || step.agentId || `Step ${index + 1}`,
      outcome,
      skipped,
      skipReason: skipped ? redactSensitiveText(step.reason || 'budget_limit') : null,
      input:
        step.input !== undefined && step.input !== null ? redactSensitiveText(step.input) : null,
      output,
      error: step.error
        ? redactSensitiveText(
            typeof step.error === 'string' ? step.error : step.error.message || 'Step error'
          )
        : null,
      provenance: {
        mode: provenanceMode,
        responseType: provenanceMode,
        model: step.model || step.usage?.model || null,
        usage: step.usage
          ? {
              available: Boolean(step.usage.available),
              inputTokens: step.usage.inputTokens ?? null,
              outputTokens: step.usage.outputTokens ?? null,
              totalTokens: step.usage.totalTokens ?? null,
              unavailableReason: step.usage.unavailableReason || null,
            }
          : null,
      },
      quote: {
        amount: quotedAmount,
        asset: quotedAsset,
        issuer: step.quotedIssuer ?? step.quote?.issuer ?? null,
        network: step.quotedNetwork ?? step.quote?.network ?? defaultNetwork,
      },
      settlement: {
        settled,
        status: synthetic ? 'synthetic' : pending ? 'pending' : settled ? 'confirmed' : 'unsettled',
        amount:
          settledAmount !== null && settledAmount !== undefined ? String(settledAmount) : null,
        asset: settledAsset ? String(settledAsset) : null,
        issuer: settledIssuer || null,
        network: settledNetwork || null,
        method: step.paidVia || step.paymentMethod || step.settlement?.method || 'none',
        txHash: txHash || null,
        explorerUrl: settled
          ? resolveReceiptExplorerUrl(
              txHash,
              settledNetwork || defaultNetwork,
              step.explorerUrl || step.settlement?.explorerUrl,
              synthetic
            )
          : null,
      },
    }
  })

  // Collect receipts from txProofs, paymentAttempts, step settlements, and legacy events
  const receipts = []
  const seenKeys = new Set()

  const addReceipt = (raw, fallbackStepId = null) => {
    if (!raw || typeof raw !== 'object') return
    const synthetic = isSyntheticReceipt(raw)
    const outcome = String(raw.outcome || raw.status || '').toLowerCase()
    const isPending =
      outcome === 'unknown' || outcome === 'pending' || Boolean(raw.paymentReconciliationRequired)
    const isFailed = outcome === 'failed'
    const txHash = raw.txHash || raw.settlement?.txHash || null
    const method =
      raw.method || raw.paidVia || raw.paymentMethod || raw.settlement?.method || 'unknown'
    const amount =
      raw.amount ??
      raw.settledAmount ??
      raw.settlement?.amount ??
      (isPending || isFailed ? raw.quotedAmount : null) ??
      null
    const asset =
      raw.asset ||
      raw.settledAsset ||
      raw.settlement?.asset ||
      raw.currency ||
      raw.quotedAsset ||
      null
    const issuer = raw.issuer ?? raw.settledIssuer ?? raw.settlement?.issuer ?? null
    const network = raw.network || raw.settledNetwork || raw.settlement?.network || defaultNetwork
    const stepId = raw.stepId || fallbackStepId || null
    const agentId = raw.agentId || raw.agent || null

    const status = synthetic
      ? 'synthetic'
      : isPending
        ? 'pending'
        : isFailed
          ? 'failed'
          : 'confirmed'
    const label =
      status === 'synthetic'
        ? 'synthetic (demo/stub receipt)'
        : status === 'pending'
          ? 'pending (awaiting reconciliation)'
          : status === 'failed'
            ? 'failed'
            : 'confirmed'

    const dedupKey = raw.id
      ? `attempt:${raw.id}`
      : txHash
        ? `tx:${txHash}:${amount || ''}:${asset || ''}`
        : `step:${stepId || agentId || receipts.length}:${status}:${amount || ''}:${asset || ''}`
    if (seenKeys.has(dedupKey)) return
    if (txHash && seenKeys.has(`tx:${txHash}`)) return
    seenKeys.add(dedupKey)
    if (txHash) seenKeys.add(`tx:${txHash}`)

    const verifiable = status === 'confirmed' && Boolean(txHash && network)
    const explorerUrl =
      status === 'confirmed'
        ? resolveReceiptExplorerUrl(txHash, network, raw.explorerUrl, false)
        : null

    receipts.push({
      receiptId: raw.id || `rcpt_${receipts.length + 1}`,
      stepId,
      agentId,
      status,
      label,
      synthetic,
      verifiable,
      method,
      amount: amount !== null && amount !== undefined ? String(amount) : null,
      asset: asset ? String(asset) : null,
      issuer: issuer || null,
      quotedAmount:
        raw.quotedAmount !== undefined && raw.quotedAmount !== null
          ? String(raw.quotedAmount)
          : null,
      quotedAsset: raw.quotedAsset ? String(raw.quotedAsset) : null,
      network,
      txHash: txHash || null,
      explorerUrl,
      settlementPolicy: raw.settlementPolicy || raw.settlement?.policy || null,
      failureReason: raw.failureReason || null,
    })
  }

  for (const proof of run.txProofs || []) {
    addReceipt(proof)
  }
  for (const attempt of run.paymentAttempts || []) {
    if (
      attempt.outcome === 'confirmed' ||
      attempt.outcome === 'unknown' ||
      attempt.outcome === 'pending'
    ) {
      addReceipt(attempt, attempt.stepId)
    }
  }
  for (const pending of run.pendingPaymentAttempts || []) {
    addReceipt({ ...pending, outcome: pending.outcome || 'pending' }, pending.stepId)
  }
  for (const rawStep of rawSteps) {
    if (
      rawStep &&
      (rawStep.paymentSuccess ||
        rawStep.settlement?.success ||
        rawStep.paymentReconciliationRequired ||
        isSyntheticReceipt(rawStep))
    ) {
      addReceipt(
        {
          stepId: rawStep.stepId,
          agentId: rawStep.agentId,
          method: rawStep.paidVia || rawStep.paymentMethod || rawStep.settlement?.method,
          txHash: rawStep.txHash || rawStep.settlement?.txHash,
          explorerUrl: rawStep.explorerUrl || rawStep.settlement?.explorerUrl,
          amount: rawStep.settledAmount ?? rawStep.settlement?.amount ?? rawStep.cost,
          asset: rawStep.settledAsset ?? rawStep.settlement?.asset ?? rawStep.currency,
          issuer: rawStep.settledIssuer ?? rawStep.settlement?.issuer ?? null,
          network: rawStep.settledNetwork ?? rawStep.settlement?.network ?? defaultNetwork,
          quotedAmount: rawStep.quotedAmount ?? rawStep.cost,
          quotedAsset: rawStep.quotedAsset ?? rawStep.currency,
          settlementPolicy: rawStep.settlement?.policy || null,
          synthetic: isSyntheticReceipt(rawStep) || isSyntheticReceipt(rawStep.settlement),
          paymentReconciliationRequired: rawStep.paymentReconciliationRequired,
          outcome: rawStep.paymentAttempt?.outcome,
        },
        rawStep.stepId
      )
    }
  }
  // Legacy runs that only recorded payment audit events
  if (receipts.length === 0 && Array.isArray(run.events)) {
    for (const ev of run.events) {
      if (ev && (ev.type === 'payment' || ev.type === 'x402_payment')) {
        addReceipt({
          agentId: ev.agentId || ev.agent || null,
          method: ev.paidVia || ev.method || (ev.type === 'x402_payment' ? 'x402' : 'stellar'),
          txHash: ev.txHash || null,
          explorerUrl: ev.explorerUrl || null,
          amount: ev.amount ?? ev.cost ?? null,
          asset: ev.asset || ev.currency || 'USDC',
          issuer: ev.issuer || null,
          network: ev.network || defaultNetwork,
          quotedAmount: ev.quotedAmount ?? ev.cost ?? null,
          quotedAsset: ev.quotedAsset || 'USDC',
        })
      }
    }
  }

  // Settled totals: use stored summary.settledTotals if available, otherwise compute from confirmed non-synthetic receipts
  const storedSettledTotals =
    run.settledTotals || run.summary?.settledTotals || run.result?.settledTotals || []
  let settledTotals
  if (Array.isArray(storedSettledTotals) && storedSettledTotals.length > 0) {
    settledTotals = storedSettledTotals.map((t) => ({
      asset: t.asset,
      issuer: t.issuer || null,
      network: t.network || defaultNetwork,
      amount: String(t.amount),
      count: Number(t.count ?? 1),
      txCount: Number(t.txCount ?? t.count ?? 1),
    }))
  } else {
    const confirmedSettlements = receipts
      .filter((r) => r.status === 'confirmed' && r.amount && r.asset)
      .map((r) => ({
        success: true,
        asset: r.asset,
        issuer: r.issuer || null,
        network: r.network || defaultNetwork,
        amount: r.amount,
        txHash: r.txHash || null,
      }))
    settledTotals = summarizeSettledTotals(confirmedSettlements).map((t) => ({
      asset: t.asset,
      issuer: t.issuer || null,
      network: t.network || defaultNetwork,
      amount: t.amount,
      count: t.count,
      txCount: t.txCount,
    }))
  }

  const settledSummary =
    (run.summary?.settledSummary && run.summary.settledSummary !== 'none'
      ? run.summary.settledSummary
      : null) || formatSettledTotals(settledTotals)

  const quotedTotal = String(
    run.quotedTotal ??
      run.summary?.quotedTotal ??
      run.totalSpent ??
      run.summary?.totalSpent ??
      run.result?.quotedTotal ??
      run.result?.totalSpent ??
      '0'
  )

  const budgetValue =
    run.budget !== undefined && run.budget !== null ? run.budget : (run.summary?.budget ?? null)

  const hasDemoSteps = steps.some(
    (s) => s.provenance.mode === 'demo' || s.provenance.mode === 'synthetic'
  )
  const hasLiveSteps = steps.some((s) => s.provenance.mode === 'live')
  const hasSyntheticReceipts = receipts.some((r) => r.status === 'synthetic')
  const runMode =
    run.mode === 'demo' || run.demoMode || run.synthetic
      ? 'demo'
      : hasDemoSteps && hasLiveSteps
        ? 'mixed'
        : hasDemoSteps || hasSyntheticReceipts
          ? 'demo'
          : 'live'

  const errorRecord =
    run.error || run.status === 'failed' || run.summary?.error
      ? {
          code: run.error?.code || 'EXECUTION_FAILED',
          message: redactSensitiveText(
            run.error?.message || run.summary?.error || 'Execution failed'
          ),
        }
      : null

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: CURRENT_SCHEMA_VERSION,
    exportedAt,
    runId,
    id: runId,
    status: run.status || 'unknown',
    task: redactSensitiveText(run.task || ''),
    budget: budgetValue,
    quotedTotal,
    settledTotals,
    settledSummary,
    timestamps: {
      createdAt: run.createdAt || null,
      updatedAt: run.updatedAt || null,
      completedAt: run.completedAt || null,
      interruptedAt: run.interruptedAt || null,
    },
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
    completedAt: run.completedAt || null,
    interruptedAt: run.interruptedAt || null,
    interruptedReason: run.interruptedReason || null,
    plan: run.plan ? redactSensitiveText(run.plan) : null,
    error: errorRecord,
    provenance: {
      mode: runMode,
      source: redactSensitiveText(run.source || 'api'),
      network: defaultNetwork,
      usage: run.usage?.summary || run.result?.usage?.summary || null,
    },
    summary: {
      quotedTotal,
      totalSpent: quotedTotal,
      settledTotals,
      settledSummary,
      budget: budgetValue,
      budgetExhausted: Boolean(
        run.summary?.budgetExhausted ?? run.result?.budgetExhausted ?? false
      ),
      paymentProtocol: run.summary?.paymentProtocol || run.result?.paymentProtocol || 'none',
      settlementConversionPolicy:
        run.summary?.settlementConversionPolicy || SETTLEMENT_CONVERSION_POLICY,
      stepCount: steps.length,
      completedStepCount: steps.filter((s) => s.outcome === 'completed').length,
      skippedStepCount: steps.filter((s) => s.outcome === 'skipped').length,
      failedStepCount: steps.filter((s) => s.outcome === 'failed').length,
      receiptCount: receipts.length,
      confirmedReceiptCount: receipts.filter((r) => r.status === 'confirmed').length,
      pendingReceiptCount: receipts.filter((r) => r.status === 'pending').length,
      syntheticReceiptCount: receipts.filter((r) => r.status === 'synthetic').length,
    },
    steps,
    receipts,
  }
}

/**
 * Renders a run report as human-readable Markdown suitable for sharing or
 * reconciliation.
 */
export function formatRunReportMarkdown(report) {
  const lines = [
    `# StellarMind Run Report: ${report.runId}`,
    '',
    `- **Run ID:** \`${report.runId}\``,
    `- **Schema Version:** \`${report.schemaVersion}\``,
    `- **Status:** \`${report.status}\``,
    `- **Task:** ${report.task || '—'}`,
    `- **Budget:** ${report.budget ?? '—'} USDC`,
    `- **Quoted Total:** ${report.quotedTotal} USDC`,
    `- **Settled Totals:** ${report.settledSummary}`,
    `- **Provenance Mode:** \`${report.provenance?.mode || 'live'}\``,
    `- **Network:** \`${report.provenance?.network || DEFAULT_NETWORK}\``,
    `- **Created At:** ${report.timestamps?.createdAt || '—'}`,
    `- **Updated At:** ${report.timestamps?.updatedAt || '—'}`,
    `- **Completed At:** ${report.timestamps?.completedAt || '—'}`,
  ]

  if (report.timestamps?.interruptedAt) {
    lines.push(
      `- **Interrupted At:** ${report.timestamps.interruptedAt} (${report.interruptedReason || 'unknown'})`
    )
  }

  if (report.error) {
    lines.push(
      '',
      '## Error',
      '',
      `- **Code:** \`${report.error.code}\``,
      `- **Message:** ${report.error.message}`
    )
  }

  if (report.plan) {
    lines.push('', '## Execution Plan', '', report.plan)
  }

  lines.push('', '## Step Outcomes', '')
  if (!Array.isArray(report.steps) || report.steps.length === 0) {
    lines.push('_No step outcomes recorded for this run._')
  } else {
    for (const step of report.steps) {
      const settledLabel = step.settlement?.settled
        ? `${step.settlement.amount} ${step.settlement.asset} (${step.settlement.status})`
        : step.settlement?.status || 'unsettled'
      lines.push(
        `### ${step.index}. ${step.agentName} (\`${step.stepId}\`) — [${step.outcome.toUpperCase()}]`,
        `- **Agent ID:** \`${step.agentId || 'unknown'}\``,
        `- **Outcome:** \`${step.outcome}\``,
        `- **Provenance:** \`${step.provenance?.mode || 'live'}\`${step.provenance?.model ? ` (model: \`${step.provenance.model}\`)` : ''}`,
        `- **Quoted:** ${step.quote?.amount ?? '0'} ${step.quote?.asset || 'USDC'}`,
        `- **Settled:** ${settledLabel}`
      )
      if (step.skipped && step.skipReason) {
        lines.push(`- **Skip Reason:** ${step.skipReason}`)
      }
      if (step.error) {
        lines.push(`- **Error:** ${step.error}`)
      }
      if (step.output) {
        lines.push('', '```text', String(step.output), '```')
      }
      lines.push('')
    }
  }

  lines.push('## Payment Receipts', '')
  if (!Array.isArray(report.receipts) || report.receipts.length === 0) {
    lines.push('_No payment receipts recorded for this run._')
  } else {
    for (const receipt of report.receipts) {
      const badge = `[${receipt.status.toUpperCase()}]`
      const amountLabel =
        receipt.amount && receipt.asset ? `${receipt.amount} ${receipt.asset}` : 'amount unrecorded'
      lines.push(
        `- **${badge}** \`${receipt.receiptId}\` — **${amountLabel}** via \`${receipt.method}\` (${receipt.label})`
      )
      lines.push(`  - **Network:** \`${receipt.network || 'unknown'}\``)
      lines.push(`  - **Transaction Hash:** ${receipt.txHash ? `\`${receipt.txHash}\`` : 'none'}`)
      if (receipt.explorerUrl) {
        lines.push(`  - **Explorer Link:** ${receipt.explorerUrl}`)
      }
    }
  }

  return `${lines.join('\n').trim()}\n`
}
