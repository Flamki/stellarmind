import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { summarizeUsageByPhase } from '../agents/usage.js'

// Schema versioning constants
const CURRENT_SCHEMA_VERSION = 1
const LEGACY_VERSION = 0 // Unversioned files

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
    return {
      ...run,
      runId: run.id,
      outputAvailable: Boolean(run.outputAvailable ?? (run.results && run.results.length > 0)),
    }
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
    run.results = result.results || []
    run.output = result.results || []
    run.result = result
    run.outputAvailable = true
    run.txProofs = txProofs
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
    run.outputAvailable = false
  }

  async listRecent(limit = 20) {
    return this.runs.slice(0, normalizeLimit(limit, 20, this.maxRuns)).map((run) => ({
      ...run,
      runId: run.id,
      outputAvailable: Boolean(run.outputAvailable ?? (run.results && run.results.length > 0)),
    }))
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
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const { version, runs, idempotency } = this.validateAndMigrate(parsed)
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
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist yet, create it
        await this.persist()
      } else if (err.message?.includes('Unsupported schema version')) {
        // Future version - fail without rewriting
        throw err
      } else {
        // File is corrupted or unreadable - preserve it and start fresh
        await this.handleCorruptedFile(err)
        await this.persist()
      }
    }
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
      return { version: LEGACY_VERSION, runs: data.runs || [], idempotency: data.idempotency || [] }
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
    return { version, runs: data.runs || [], idempotency: data.idempotency || [] }
  }

  /**
   * Handles corrupted or unreadable files by preserving them
   * @param {Error} err - The error that occurred
   */
  async handleCorruptedFile(err) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${this.filePath}.corrupted.${timestamp}`
    console.error(`  run history: file is corrupted, preserving at ${backupPath}`)
    console.error(`  run history: error was: ${err.message}`)
    try {
      await fs.rename(this.filePath, backupPath)
    } catch (renameErr) {
      console.warn(`  run history: failed to preserve corrupted file: ${renameErr.message}`)
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

  async completeRun(runId, result) {
    await super.completeRun(runId, result)
    await this.persist()
  }

  async failRun(runId, err) {
    await super.failRun(runId, err)
    await this.persist()
  }
}

export async function createRunHistoryStore(config) {
  const storage = (config.runHistoryStorage || 'file').toLowerCase()
  if (storage === 'memory') {
    const store = new InMemoryRunHistoryStore(config.runHistoryMaxRuns)
    await store.init()
    return store
  }

  const store = new FileRunHistoryStore(config.runHistoryFile, config.runHistoryMaxRuns)
  await store.init()
  return store
}
