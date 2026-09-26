import crypto from 'node:crypto'
import { validateOrchestrate } from '../requestValidation.js'
import { logger } from '../logger.js'
import { config } from '../config.js'
import { OrchestrationAdmissionQueue } from '../agents/orchestration-queue.js'

export function registerOrchestrationRoutes(app, deps = {}) {
  const {
    runHistoryStore,
    orchestrate: orchestrateFn,
    broadcast = () => {},
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
      }

      // 4. Detached background execution promise with admission queue
      let queueSubmissionError = null
      const executionPromise = (async () => {
        try {
          const result = await admissionQueue.run(
            async ({ signal }) => {
              return orchestrateFn(task, budget, runBroadcast, {
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

    // If still running without active execution (e.g. recovered), return 202 handle
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

  // ─── Endpoints ──────────────────────────────────────────────
  app.post('/api/orchestrate', validateOrchestrate, handleSubmission)
  app.get('/api/orchestrate', validateOrchestrate, handleSubmission)

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
}
