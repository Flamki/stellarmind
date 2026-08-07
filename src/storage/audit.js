import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
function createEventId() { return 'evt_'+Date.now()+'_'+crypto.randomBytes(4).toString('hex') }
export class AuditHistoryStore {
  constructor(options={}) {
    this.filePath = options.filePath || null
    this.maxEvents = options.maxEvents || 500
    this.persist = options.persist !== false
    this.events = []
    this._initialized = false
  }
  async init() {
    if (this._initialized) return
    if (this.filePath && this.persist) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      try {
        const raw = await fs.readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) this.events = parsed.slice(-this.maxEvents)
      } catch(err) {
        if (err.code !== 'ENOENT') console.warn('AuditHistoryStore load:', err.message)
      }
    }
    this._initialized = true
  }
  async _flush() {
    if (!this.filePath || !this.persist) return
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      const tmp = this.filePath + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(this.events, null, 2), 'utf8')
      await fs.rename(tmp, this.filePath)
    } catch(err) { console.warn('AuditHistoryStore flush:', err.message) }
  }
  async record(event) {
    if (!this._initialized) await this.init()
    const entry = {
      id: createEventId(),
      type: event.type || 'unknown',
      timestamp: event.timestamp || new Date().toISOString(),
      runId: event.runId || null,
      agentId: event.agentId || null,
      agent: event.agent || null,
      cost: event.cost || null,
      paidVia: event.paidVia || null,
      txHash: event.txHash || null,
      explorerUrl: event.explorerUrl || null,
      status: event.status || null,
      totalSpent: event.totalSpent || null,
      reason: event.reason || null,
      metadata: event.metadata || null,
    }
    this.events.push(entry)
    if (this.events.length > this.maxEvents) this.events = this.events.slice(-this.maxEvents)
    this._flush().catch(e => console.warn('AuditHistoryStore async flush:', e.message))
    return entry
  }
  async query(filters={}) {
    if (!this._initialized) await this.init()
    const { runId, type, agentId, limit=50, offset=0, since } = filters
    let results = [...this.events]
    if (runId) results = results.filter(e => e.runId === runId)
    if (type) results = results.filter(e => e.type === type)
    if (agentId) results = results.filter(e => e.agentId === agentId)
    if (since) results = results.filter(e => e.timestamp >= since)
    results.reverse()
    return results.slice(offset, offset+limit)
  }
  async stats() {
    if (!this._initialized) await this.init()
    const c = {}
    for (const e of this.events) c[e.type] = (c[e.type]||0)+1
    return c
  }
  async getRunEvents(runId) { return this.query({ runId, limit: 500 }) }
  async getPaymentEvents(limit=50) { return this.query({ type: 'payment_sent', limit }) }
  async count() { if (!this._initialized) await this.init(); return this.events.length }
}
export async function createAuditStore(config={}) {
  const store = new AuditHistoryStore({
    filePath: config.auditHistoryFile ||
      path.join(config.runHistoryFile ? path.dirname(config.runHistoryFile) : 'data', 'audit-history.json'),
    maxEvents: config.auditMaxEvents || 500,
    persist: true,
  })
  await store.init()
  return store
}