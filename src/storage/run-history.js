import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

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
  }

  async init() {}

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
    return run
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
    run.txProofs = txProofs
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
  }

  async listRecent(limit = 20) {
    return this.runs.slice(0, normalizeLimit(limit, 20, this.maxRuns))
  }
}

export class FileRunHistoryStore extends InMemoryRunHistoryStore {
  constructor(filePath, maxRuns = 200) {
    super(maxRuns)
    this.filePath = filePath
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.runs)) this.runs = parsed.runs.slice(0, this.maxRuns)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`  run history load warning: ${err.message}`)
      }
      await this.persist()
    }
  }

  async persist() {
    const payload = JSON.stringify({ runs: this.runs.slice(0, this.maxRuns) }, null, 2)
    const tempPath = `${this.filePath}.tmp`
    await fs.writeFile(tempPath, payload, 'utf8')
    await fs.rename(tempPath, this.filePath)
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
