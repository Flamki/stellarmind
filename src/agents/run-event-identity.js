/**
 * Run and step identity for orchestration events (Issue #163)
 *
 * The dashboard tracked live progress with sets keyed by agent id, so two steps
 * that happened to use the same agent counted as one, and events from any run
 * could move the progress of the run on screen. Both problems come from the same
 * gap: events carried no step identity.
 *
 * `createRunEventIdentifier(runId)` returns a function that stamps every event
 * with:
 *
 *   - `runId`      — which run the event belongs to (also added by the route
 *                    before this change; kept here so one call does both)
 *   - `stepIndex`  — monotonic position of the event within the run
 *   - `stepId`     — identity of the *step* (call) it belongs to. An
 *                    `agent_response` pairs with the oldest still-unpaired
 *                    `agent_call` for the same agent, so a call and its response
 *                    share one step id.
 *
 * Step ids are per-run and stable within it, which is what lets the dashboard
 * count distinct steps instead of distinct agent names and ignore events from
 * runs it did not start.
 */

function agentKeyOf(event) {
  return event.agentId || event.agent || null
}

export function createRunEventIdentifier(runId) {
  if (!runId) throw new Error('createRunEventIdentifier requires a runId')

  let stepCounter = 0
  /** agentKey -> FIFO queue of step ids whose call has not been answered yet. */
  const openCalls = new Map()

  return function identify(event) {
    if (!event || typeof event !== 'object') return event

    const identified = { ...event, runId }
    stepCounter += 1
    identified.stepIndex = stepCounter

    if (event.type === 'agent_call') {
      identified.stepId = `s${stepCounter}`
      const key = agentKeyOf(event)
      if (key) {
        const queue = openCalls.get(key) || []
        queue.push(identified.stepId)
        openCalls.set(key, queue)
      }
      return identified
    }

    if (event.type === 'agent_response') {
      const key = agentKeyOf(event)
      const queue = key ? openCalls.get(key) || [] : []
      const paired = queue.length > 0 ? queue.shift() : null
      if (key && paired) openCalls.set(key, queue)
      // Pair with the call it answers when there is one; otherwise the response
      // is its own step (an agent can be reported without a preceding call in a
      // resumed or partially observed run).
      identified.stepId = paired || `s${stepCounter}`
      identified.stepPaired = Boolean(paired)
      return identified
    }

    // Every other event (plan, payment, budget limit, completion) is its own
    // position in the stream and carries no step id.
    return identified
  }
}

/**
 * Count the steps a stream of identified events describes. Mirrors what the
 * dashboard reducer does, and is the part that has to be right for the
 * acceptance criteria: distinct step ids, not distinct agent names.
 */
export function summarizeRunSteps(events) {
  const started = new Set()
  const completed = new Set()
  let spent = 0

  for (const event of events || []) {
    if (!event || !event.stepId) continue
    if (event.type === 'agent_call') started.add(event.stepId)
    if (event.type === 'agent_response') {
      completed.add(event.stepId)
      spent += Number.parseFloat(event.cost || '0') || 0
    }
  }

  return { started: started.size, completed: completed.size, spent }
}
