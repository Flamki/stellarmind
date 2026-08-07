export function registerAuditRoutes(app, deps) {
  const { auditStore, runHistoryStore, adminAuth } = deps
  app.get('/api/audit/runs', adminAuth, async (req, res, next) => {
    try {
      const limit = Math.min(Number.parseInt(req.query.limit,10)||20, 100)
      const runs = await runHistoryStore.listRecent(limit)
      const enriched = await Promise.all(runs.map(async run => {
        const events = await auditStore.getRunEvents(run.id)
        return { ...run, auditEventCount: events.length, auditEvents: events.slice(0,10) }
      }))
      res.json({ count: enriched.length, runs: enriched })
    } catch(err) { next(err) }
  })
  app.get('/api/audit/runs/:id', adminAuth, async (req, res, next) => {
    try {
      const events = await auditStore.getRunEvents(req.params.id)
      if (!events.length) return res.status(404).json({ error: 'Run not found' })
      const timeline = events.map(e => ({
        timestamp: e.timestamp, type: e.type, agent: e.agent,
        cost: e.cost, paidVia: e.paidVia, txHash: e.txHash, explorerUrl: e.explorerUrl, status: e.status
      }))
      res.json({ runId: req.params.id, eventCount: events.length, timeline, events })
    } catch(err) { next(err) }
  })
  app.get('/api/audit/events', adminAuth, async (req, res, next) => {
    try {
      const { runId, type, agentId, limit, offset, since } = req.query
      const events = await auditStore.query({
        runId, type, agentId,
        limit: Number.parseInt(limit,10)||50,
        offset: Number.parseInt(offset,10)||0, since
      })
      const total = await auditStore.count()
      res.json({ total, count: events.length, events })
    } catch(err) { next(err) }
  })
  app.get('/api/audit/payments', adminAuth, async (req, res, next) => {
    try {
      const limit = Math.min(Number.parseInt(req.query.limit,10)||50, 200)
      const events = await auditStore.getPaymentEvents(limit)
      const totalPaid = events.reduce((s,e)=>s+(Number.parseFloat(e.cost)||0), 0)
      const byMethod = {}
      for (const e of events) { const m = e.paidVia||'unknown'; byMethod[m]=(byMethod[m]||0)+1 }
      res.json({ count: events.length, totalPaidUSDC: totalPaid.toFixed(6), byMethod, events })
    } catch(err) { next(err) }
  })
  app.get('/api/audit/stats', adminAuth, async (req, res, next) => {
    try {
      const stats = await auditStore.stats()
      const total = Object.values(stats).reduce((a,b)=>a+b,0)
      res.json({ total, byType: stats })
    } catch(err) { next(err) }
  })
}