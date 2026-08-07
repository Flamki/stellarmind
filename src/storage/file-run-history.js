import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

/**
 * FileRunHistoryStore — durable run history persisted to a JSON file.
 *
 * Survives process restarts. Uses atomic file writes (write tmp -> rename)
 * to prevent corruption from concurrent or interrupted writes.
 */
export class FileRunHistoryStore {
  constructor({ filePath, maxRuns = 200 }) {
    this.filePath =
      filePath ||
      path.join(__dirname, '..', '..', 'data', 'run-history.json')
    this.maxRuns = Math.max(10, maxRuns)
    this.runs = []
  }

  async init() {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      this.runs = Array.isArray(parsed) ? parsed : []
      console.log(
        `[run-history] Loaded ${this.runs.length} runs from ${this.filePath}`
      )
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.runs = []
        console.log('[run-history] No existing history file, starting fresh')
      } else {
        console.error(`[run-history] Failed to load: ${err.message}`)
        this.runs = []
      }
    }
  }

  async _persist() {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(
      tmp,
      JSON.stringify(this.runs, null, 2),
      'utf-8'
    )
    await fs.rename(tmp, this.filePath)
  }

  async createRun({ task, budget, source }) {
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
      events: [],
      txProofs: [],
    }
    this.runs.unshift(run)
    this.runs = this.runs.slice(0, this.maxRuns)
    await this._persist()
    return run
  }

  async appendEvent(runId, event) {
    const run = this.runs.find((e) => e.id === runId)
    if (!run) return
    run.events.push(toAuditEvent(event))
    run.updatedAt = new Date().toISOString()
    await this._persist()
  }

  async completeRun(runId, result) {
    const run = this.runs.find((e) => e.id === runId)
    if (!run) return
    const txProofs = (result.payments || [])
      .filter((p) => p.paymentSuccess)
      .map((p) => ({
        method: p.paidVia || p.paymentMethod || 'unknown',
        txHash: p.txHash || null,
        explorerUrl: p.explorerUrl || null,
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
    run.txProofs = txProofs
    await this._persist()
  }

  async failRun(runId, err) {
    const run = this.runs.find((e) => e.id === runId)
    if (!run) return
    run.status = 'failed'
    run.completedAt = new Date().toISOString()
    run.updatedAt = run.completedAt
    run.summary = { error: err?.message || 'unknown error' }
    await this._persist()
  }

  async listRecent(limit = 20) {
    return this.runs.slice(0, normalizeLimit(limit, 20, this.maxRuns))
  }

  async getRun(id) {
    return this.runs.find((e) => e.id === id) || null
  }
}

/**
 * Factory that creates a FileRunHistoryStore from the standard config shape.
 */
export async function createFileRunHistoryStore(cfg) {
  const store = new FileRunHistoryStore({
    filePath: cfg.runHistoryFile,
    maxRuns: cfg.runHistoryMaxRuns,
  })
  await store.init()
  return store
}
