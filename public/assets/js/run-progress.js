/**
 * Live run progress reducer (Issue #163)
 *
 * The dashboard used sets keyed by agent id to count progress, so two steps that
 * used the same agent counted as one, and events from any run could move the run
 * on screen. Progress is now derived from *run and step identity*:
 *
 *   - every event the server streams carries `runId` and (for agent steps)
 *     `stepId` / `stepIndex` — see `src/agents/run-event-identity.js`;
 *   - an event only moves the selected run's progress if its `runId` matches;
 *   - a step is counted by `stepId`, so the same agent twice is two steps.
 *
 * Loaded by `public/index.html` as a classic script; exposed as
 * `window.RunProgress` and unit-tested in `tests/run-progress.test.js` by
 * evaluating this file with a `window` stub.
 */
;(function (global) {
  'use strict'

  /** Progress state for a run the dashboard started. */
  function createRunProgress(task, budget) {
    return {
      task,
      budget,
      startedAt: Date.now(),
      lastUpdateAt: Date.now(),
      planned: 0,
      completed: 0,
      spent: 0,
      running: true,
      // Identity of the run the dashboard is following. Adopted from the first
      // event that carries one; events with a different id are ignored.
      runId: null,
      // stepId -> { agentId, agent, state }
      steps: new Map(),
      completedStepIds: new Set(),
      // Events dropped because they belonged to another run, and events with no
      // identity at all that arrived after a run was selected.
      ignoredEvents: 0,
      anonymousStepSeq: 0,
    }
  }

  /**
   * Identity of the step an event describes. Falls back to a per-event key when
   * the server sends no step identity (older builds) — still one step per event,
   * which keeps two calls to the same agent apart.
   */
  function stepKeyFor(run, ev) {
    if (!run || !ev) return null
    if (ev.stepId) return `step:${ev.stepId}`
    if (ev.stepIndex !== undefined && ev.stepIndex !== null) return `index:${ev.stepIndex}`
    run.anonymousStepSeq += 1
    return `anon:${ev.type}:${ev.agentId || ev.agent || 'agent'}:${run.anonymousStepSeq}`
  }

  /**
   * Whether an event may move the progress of the run on screen. The first
   * identified event claims the dashboard's run id; anything from a different
   * run is ignored and counted.
   */
  function eventBelongsToActiveRun(run, ev) {
    if (!run || !ev) return false
    const evRunId = ev.runId || null
    if (!evRunId) return !run.runId
    if (!run.runId) {
      run.runId = evRunId
      return true
    }
    if (evRunId === run.runId) return true
    run.ignoredEvents += 1
    return false
  }

  /**
   * Apply one event to the progress state.
   *
   * Returns what happened so the caller can decide what to render:
   *   { accepted, ignored, stepKey, stepStarted, stepCompleted, spentDelta }
   */
  function reduceLiveEvent(run, ev) {
    const result = {
      accepted: false,
      ignored: false,
      stepKey: null,
      stepStarted: false,
      stepCompleted: false,
      spentDelta: 0,
    }
    if (!run || !ev) return result

    if (!eventBelongsToActiveRun(run, ev)) {
      result.ignored = true
      return result
    }

    result.accepted = true
    run.lastUpdateAt = Date.now()

    if (ev.type === 'orchestrator_plan') {
      run.planned = Number(ev.subtaskCount) || run.planned
      return result
    }

    if (ev.type === 'agent_call') {
      const stepKey = stepKeyFor(run, ev)
      result.stepKey = stepKey
      if (!run.steps.has(stepKey)) {
        run.steps.set(stepKey, {
          agentId: ev.agentId || null,
          agent: ev.agent || null,
          state: 'running',
        })
        result.stepStarted = true
      }
      return result
    }

    if (ev.type === 'agent_response') {
      const stepKey = stepKeyFor(run, ev)
      result.stepKey = stepKey
      if (!run.completedStepIds.has(stepKey)) {
        run.completedStepIds.add(stepKey)
        const step = run.steps.get(stepKey)
        if (step) {
          step.state = 'completed'
        } else {
          run.steps.set(stepKey, {
            agentId: ev.agentId || null,
            agent: ev.agent || null,
            state: 'completed',
          })
        }
        run.completed = run.completedStepIds.size
        const delta = Number.parseFloat(ev.cost || '0') || 0
        run.spent += delta
        result.spentDelta = delta
        result.stepCompleted = true
      }
      return result
    }

    if (ev.type === 'orchestrator_complete') {
      run.running = false
    }

    return result
  }

  const api = {
    createRunProgress,
    eventBelongsToActiveRun,
    stepKeyFor,
    reduceLiveEvent,
  }

  global.RunProgress = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
