import crypto from 'node:crypto'
import { validateOrchestrate, validateOrchestrateExecute } from '../requestValidation.js'
import { logger } from '../logger.js'
import { config } from '../config.js'
import { OrchestrationAdmissionQueue } from '../agents/orchestration-queue.js'
import { previewOrchestration, executePlan, activePlansStore } from '../agents/orchestrator.js'

export function registerOrchestrationRoutes(app, deps = {}) {
  const {
    runHistoryStore,
    orchestrate: orchestrateFn,
    broadcast = () => {},
    // Optional read-only probe: (attempt) => { settled, txHash?, proof? }.
    // See the reconcile endpoint below and docs/architecture.md (#131).
    paymentProbe,
    admissionQueue = new OrchestrationAdmissionQueue(config.orchestrationQueue),
  } = deps

  const activeExecutions = new Map() // runId -> Promise<result>
  const inFlightIdempotentRequests = new Map() // key -> Promise<{ run, fingerprint }>

  async function handleSubmission(req, res, next) {
    const isAsync = req.validated?.mode === 'async'
    const clientAbortController = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) {
        clientAbortController.abort(new Error('Client disconnected'))
      }
    }

    if (!isAsync) {
      res.on('close', onClose)
      req.on('aborted', onClose)
    }

    try {
      const { task, budget, idempotencyKey } = req.validated
      const source = `${req.method} /api/orchestrate`

      const fingerprint = idempotencyKey
        ? crypto
            .createHash('sha256')
            .update(JSON.stringify({ task: task.trim(), budget: String(budget) }))
            .digest('hex')
        : null

      if (idempotencyKey) {
        // 1. Check in-flight concurrent submissions for the same key
        if (inFlightIdempotentRequests.has(idempotencyKey)) {
          const inFlight = await inFlightIdempotentRequests.get(idempotencyKey)
          if (inFlight.fingerprint !== fingerprint) {
            const err = new Error('Idempotency key reused with different request parameters')
            err.status = 409
            err.code = 'IDEMPOTENCY_KEY_CONFLICT'
            err.details = [
              {
                field: 'idempotencyKey',
                reason: 'Key already in flight with different parameters',
                originalRunId: inFlight.run.id,
              },
            ]
            return next(err)
          }

          return sendIdempotentResponse(req, res, next, inFlight.run, isAsync)
        }

        // 2. Check persisted idempotency records
        const existingRecord = await runHistoryStore.getIdempotencyRecord(idempotencyKey)
        if (existingRecord) {
          if (existingRecord.fingerprint !== fingerprint) {
            const err = new Error('Idempotency key reused with different request parameters')
            err.status = 409
            err.code = 'IDEMPOTENCY_KEY_CONFLICT'
            err.details = [
              {
                field: 'idempotencyKey',
                reason: 'Key already associated with different task or budget',
                originalRunId: existingRecord.runId,
              },
            ]
            return next(err)
          }

          const existingRun = await runHistoryStore.getRun(existingRecord.runId)
          if (existingRun) {
            return sendIdempotentResponse(req, res, next, existingRun, isAsync)
          }
        }
      }

      // 3. Create fresh run (startup step)
      let run
      if (idempotencyKey) {
        const creationPromise = (async () => {
          const created = await runHistoryStore.createRun({
            task,
            budget,
            source,
            idempotencyKey,
            idempotencyFingerprint: fingerprint,
          })
          return { run: created, fingerprint }
        })()
        inFlightIdempotentRequests.set(idempotencyKey, creationPromise)
        try {
          const createdResult = await creationPromise
          run = createdResult.run
        } finally {
          inFlightIdempotentRequests.delete(idempotencyKey)
        }
      } else {
        run = await runHistoryStore.createRun({
          task,
          budget,
          source,
        })
      }

      const runBroadcast = (event) => {
        const eventWithRun = { ...event, runId: run.id }
        broadcast(eventWithRun)
        runHistoryStore.appendEvent(run.id, eventWithRun).catch((persistErr) => {
          logger.warn('run_history_append_failed', { runId: run.id, error: persistErr.message })
        })
        // Payment attempts are persisted as soon as they are observed, so an
        // attempt whose outcome is still unknown survives a crash mid-run
        // and can be reconciled instead of being settled twice (#131).
        if (eventWithRun.paymentAttempt) {
          runHistoryStore
            .recordPaymentAttempt(run.id, eventWithRun.paymentAttempt)
            .catch((persistErr) => {
              logger.warn('payment_attempt_persist_failed', {
                runId: run.id,
                attemptId: eventWithRun.paymentAttempt.id,
                error: persistErr.message,
              })
            })
        }
      }

      // 4. Detached background execution promise with admission queue
      let queueSubmissionError = null
      const executionPromise = (async () => {
        try {
          const result = await admissionQueue.run(
            async ({ signal }) => {
              return orchestrateFn(task, budget, runBroadcast, {
                correlationId: req.requestId,
                // Links every payment attempt to this run, and lets the
                // orchestrator reconcile an unresolved outcome *before* it
                // decides whether a fallback settlement is permitted (#131).
                runId: run.id,
                paymentProbe,
                signal,
              })
            },
            {
              id: run.id,
              signal: isAsync ? undefined : clientAbortController.signal,
              onQueued: ({ position, queueLength, activeCount }) => {
                runBroadcast({
                  type: 'orchestration_queued',
                  runId: run.id,
                  position,
                  queueLength,
                  activeCount,
                  timestamp: new Date().toISOString(),
                })
              },
              onAdmitted: ({ waitDurationMs, activeCount, queued }) => {
                if (queued) {
                  runBroadcast({
                    type: 'orchestration_admitted',
                    runId: run.id,
                    waitDurationMs,
                    activeCount,
                    timestamp: new Date().toISOString(),
                  })
                }
              },
            }
          )

          result.runId = run.id
          await runHistoryStore.completeRun(run.id, result)
          return result
        } catch (err) {
          logger.error('orchestration_execution_failed', { runId: run.id, error: err.message })
          await runHistoryStore.failRun(run.id, err).catch((storeErr) => {
            logger.error('run_history_fail_persist_failed', {
              runId: run.id,
              error: storeErr.message,
            })
          })
          throw err
        } finally {
          activeExecutions.delete(run.id)
          if (!isAsync) {
            res.off?.('close', onClose)
            req.off?.('aborted', onClose)
          }
        }
      })()

      activeExecutions.set(run.id, executionPromise)

      // Catch immediate queue rejection (e.g. QueueCapacityExceededError)
      executionPromise.catch((err) => {
        queueSubmissionError = err
      })

      // Yield to allow synchronous queue capacity check to reject if full
      await Promise.resolve()

      if (queueSubmissionError) {
        return next(queueSubmissionError)
      }

      // 5. Return outcome according to submission mode
      if (isAsync) {
        res.setHeader('Location', `/api/runs/${run.id}`)
        if (req.header('prefer')?.toLowerCase().includes('respond-async')) {
          res.setHeader('Preference-Applied', 'respond-async')
        }
        return res.status(202).json({
          runId: run.id,
          status: run.status || 'running',
          url: `/api/runs/${run.id}`,
          runUrl: `/api/runs/${run.id}`,
          task,
          budget,
          createdAt: run.createdAt,
          mode: 'async',
        })
      }

      // Synchronous mode: await completion
      const result = await executionPromise
      res.json(result)
    } catch (err) {
      next(err)
    }
  }

  async function sendIdempotentResponse(req, res, next, run, isAsync) {
    res.setHeader('X-Idempotent-Replay', 'true')

    if (isAsync) {
      res.setHeader('Location', `/api/runs/${run.id}`)
      if (req.header('prefer')?.toLowerCase().includes('respond-async')) {
        res.setHeader('Preference-Applied', 'respond-async')
      }
      return res.status(202).json({
        runId: run.id,
        status: run.status,
        url: `/api/runs/${run.id}`,
        runUrl: `/api/runs/${run.id}`,
        task: run.task,
        budget: run.budget,
        createdAt: run.createdAt,
        mode: 'async',
        idempotent: true,
      })
    }

    // Synchronous mode
    if (run.status === 'completed') {
      return res.json(run.result || run)
    }
    if (run.status === 'failed') {
      const err = new Error(run.summary?.error || 'Run failed')
      err.status = 500
      err.code = run.error?.code || 'EXECUTION_FAILED'
      return next(err)
    }
    if (activeExecutions.has(run.id)) {
      try {
        const result = await activeExecutions.get(run.id)
        return res.json(result)
      } catch (err) {
        return next(err)
      }
    }

    res.setHeader('Location', `/api/runs/${run.id}`)
    return res.status(202).json({
      runId: run.id,
      status: run.status,
      url: `/api/runs/${run.id}`,
      runUrl: `/api/runs/${run.id}`,
      task: run.task,
      budget: run.budget,
      createdAt: run.createdAt,
      mode: 'async',
      idempotent: true,
    })
  }

  async function handlePreviewSubmission(req, res, next) {
    try {
      const { task, budget } = req.validated
      const preview = await previewOrchestration(task, budget, (event) => {
        broadcast(event)
      }, {
        correlationId: req.requestId,
      })
      res.json(preview)
    } catch (err) {
      next(err)
    }
  }

  async function handleExecutionSubmission(req, res, next) {
    const isAsync = req.validated?.mode === 'async'
    const clientAbortController = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) {
        clientAbortController.abort(new Error('Client disconnected'))
      }
    }

    if (!isAsync) {
      res.on('close', onClose)
      req.on('aborted', onClose)
    }

    try {
      const { planId, idempotencyKey } = req.validated
      const source = `${req.method} /api/orchestrate/execute`

      const planRecord = activePlansStore.get(planId)
      if (!planRecord) {
        const err = new Error(`Plan '${planId}' not found or already executed`)
        err.status = 404
        err.code = 'PLAN_NOT_FOUND'
        return next(err)
      }

      const task = planRecord.task
      const budget = planRecord.budget

      const fingerprint = idempotencyKey
        ? crypto
            .createHash('sha256')
            .update(JSON.stringify({ planId, task: task.trim(), budget: String(budget) }))
            .digest('hex')
        : null

      if (idempotencyKey) {
        const existingRecord = await runHistoryStore.getIdempotencyRecord(idempotencyKey)
        if (existingRecord) {
          if (existingRecord.fingerprint !== fingerprint) {
            const err = new Error('Idempotency key reused with different request parameters')
            err.status = 409
            err.code = 'IDEMPOTENCY_KEY_CONFLICT'
            return next(err)
          }
          const existingRun = await runHistoryStore.getRun(existingRecord.runId)
          if (existingRun) {
            return sendIdempotentResponse(req, res, next, existingRun, isAsync)
          }
        }
      }

      const run = await runHistoryStore.createRun({
        task,
        budget,
        source,
        idempotencyKey,
        idempotencyFingerprint: fingerprint,
      })

      const runBroadcast = (event) => {
        const eventWithRun = { ...event, runId: run.id }
        broadcast(eventWithRun)
        runHistoryStore.appendEvent(run.id, eventWithRun).catch((persistErr) => {
          logger.warn('run_history_append_failed', { runId: run.id, error: persistErr.message })
        })
      }

      let queueSubmissionError = null
      const executionPromise = (async () => {
        try {
          const result = await admissionQueue.run(
            async ({ signal }) => {
              return executePlan(planId, runBroadcast, {
                correlationId: req.requestId,
                signal,
              })
            },
            {
              id: run.id,
              signal: isAsync ? undefined : clientAbortController.signal,
              onQueued: ({ position, queueLength, activeCount }) => {
                runBroadcast({
                  type: 'orchestration_queued',
                  runId: run.id,
                  position,
                  queueLength,
                  activeCount,
                  timestamp: new Date().toISOString(),
                })
              },
              onAdmitted: ({ waitDurationMs, activeCount, queued }) => {
                if (queued) {
                  runBroadcast({
                    type: 'orchestration_admitted',
                    runId: run.id,
                    waitDurationMs,
                    activeCount,
                    timestamp: new Date().toISOString(),
                  })
                }
              },
            }
          )

          result.runId = run.id
          await runHistoryStore.completeRun(run.id, result)
          return result
        } catch (err) {
          logger.error('orchestration_execution_failed', { runId: run.id, error: err.message })
          await runHistoryStore.failRun(run.id, err).catch((storeErr) => {
            logger.error('run_history_fail_persist_failed', {
              runId: run.id,
              error: storeErr.message,
            })
          })
          throw err
        } finally {
          activeExecutions.delete(run.id)
          if (!isAsync) {
            res.off?.('close', onClose)
            req.off?.('aborted', onClose)
          }
        }
      })()

      activeExecutions.set(run.id, executionPromise)
      executionPromise.catch((err) => {
        queueSubmissionError = err
      })

      await Promise.resolve()

      if (queueSubmissionError) {
        return next(queueSubmissionError)
      }

      if (isAsync) {
        res.setHeader('Location', `/api/runs/${run.id}`)
        if (req.header('prefer')?.toLowerCase().includes('respond-async')) {
          res.setHeader('Preference-Applied', 'respond-async')
        }
        return res.status(202).json({
          runId: run.id,
          status: run.status || 'running',
          url: `/api/runs/${run.id}`,
          runUrl: `/api/runs/${run.id}`,
          task,
          budget,
          createdAt: run.createdAt,
          mode: 'async',
        })
      }

      const result = await executionPromise
      res.json(result)
    } catch (err) {
      next(err)
    }
  }

  // ─── Endpoints ──────────────────────────────────────────────
  app.post('/api/orchestrate', validateOrchestrate, handleSubmission)
  app.get('/api/orchestrate', validateOrchestrate, handleSubmission)
  app.post('/api/orchestrate/preview', validateOrchestrate, handlePreviewSubmission)
  app.get('/api/orchestrate/preview', validateOrchestrate, handlePreviewSubmission)
  app.post('/api/orchestrate/execute', validateOrchestrateExecute, handleExecutionSubmission)

  app.get('/api/orchestrate/queue', (req, res) => {
    res.json({
      ...admissionQueue.getState(),
      multiReplicaCoordination: false,
      note: 'In-process admission queue bounds concurrency on this server instance; no cross-node distributed coordination.',
      retryAfterDefaultSec: Math.max(1, Math.ceil(admissionQueue.queueTimeoutMs / 1000)),
    })
  })

  app.post('/api/orchestrate/:id/cancel', async (req, res, next) => {
    try {
      const { id } = req.params
      const reason = req.body?.reason || 'User cancelled orchestration'
      const cancelResult = admissionQueue.cancel(id, reason)

      if (cancelResult.cancelled) {
        broadcast({
          type: 'orchestration_cancelled',
          runId: id,
          phase: cancelResult.phase,
          reason,
          timestamp: new Date().toISOString(),
        })
        return res.json({
          success: true,
          runId: id,
          phase: cancelResult.phase,
          message: `Orchestration run ${id} was cancelled (${cancelResult.phase} phase)`,
        })
      }

      const run = await runHistoryStore.getRun(id)
      if (!run) {
        const err = new Error(`Orchestration run ${id} not found`)
        err.status = 404
        err.code = 'NOT_FOUND'
        return next(err)
      }

      return res.status(409).json({
        success: false,
        runId: id,
        status: run.status,
        message: `Run ${id} cannot be cancelled because it is already ${run.status}`,
      })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/runs', async (req, res, next) => {
    try {
      const limit = req.query.limit || 20
      const runs = await runHistoryStore.listRecent(limit)
      res.json({
        storage: config.runHistoryStorage,
        file: config.runHistoryStorage === 'file' ? config.runHistoryFile : null,
        count: runs.length,
        runs,
      })
    } catch (err) {
      next(err)
    }
  })

  // Attempts whose outcome is unresolved (#131). Not settled charges: they
  // may or may not have been paid, so they are reported separately from
  // `summary` until reconciliation resolves them.
  app.get('/api/runs/pending-payments', async (req, res, next) => {
    try {
      const attempts = await runHistoryStore.getPendingPayments()
      res.json({ count: attempts.length, attempts })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/runs/:id', async (req, res, next) => {
    try {
      const run = await runHistoryStore.getRun(req.params.id)
      if (!run) {
        const err = new Error(`Run '${req.params.id}' not found`)
        err.status = 404
        err.code = 'RUN_NOT_FOUND'
        return next(err)
      }
      res.json(run)
    } catch (err) {
      next(err)
    }
  })

  // Runs one reconciliation pass over this run's pending attempts. The
  // probe is injected because only a caller that can query the payment
  // path can answer "did this settlement complete?" — and answering it is
  // what authorises a fallback settlement. Without a probe configured the
  // attempts stay visibly pending rather than being guessed at.
  app.post('/api/runs/:id/reconcile-payments', async (req, res, next) => {
    try {
      if (typeof paymentProbe !== 'function') {
        const err = new Error(
          'No payment reconciliation probe is configured, so unresolved attempts stay pending'
        )
        err.status = 503
        err.code = 'PAYMENT_PROBE_UNAVAILABLE'
        return next(err)
      }

      const run = await runHistoryStore.getRun(req.params.id)
      if (!run) {
        const err = new Error(`Run '${req.params.id}' not found`)
        err.status = 404
        err.code = 'RUN_NOT_FOUND'
        return next(err)
      }

      const reconciled = await runHistoryStore.reconcilePendingPayments(paymentProbe, {
        runId: run.id,
      })
      const updated = await runHistoryStore.getRun(run.id)
      res.json({
        runId: run.id,
        reconciledCount: reconciled.length,
        pendingPaymentAttempts: updated?.pendingPaymentAttempts || [],
      })
    } catch (err) {
      next(err)
    }
  })
}
