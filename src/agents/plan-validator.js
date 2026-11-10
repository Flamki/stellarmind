/**
 * Plan Validator — enforces a strict contract on model-generated orchestration
 * plans before any agent or payment call is made (Issue #145).
 *
 * A valid plan looks like:
 *   { plan: string, subtasks: [{ agentId: string, input: string }, ...] }
 *
 * Only known agent IDs (from the registry), bounded input strings, and an
 * array of subtasks within the size limit are accepted. Any model-supplied
 * `cost` field is dropped entirely — pricing always comes from the registry
 * via agentCost(), never from the plan itself.
 */
import { getAgentById } from './registry.js'

export const MAX_SUBTASKS = 6
export const MAX_INPUT_LENGTH = 4000

/**
 * Validates a raw parsed plan object and returns a normalized, safe plan.
 * @param {*} rawPlan - parsed JSON (or fallback-built) plan
 * @returns {{ valid: true, plan: { plan: string, subtasks: Array } } | { valid: false, reason: string }}
 */
export function validatePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return { valid: false, reason: 'plan_not_object' }
  }

  if (!Array.isArray(rawPlan.subtasks)) {
    return { valid: false, reason: 'subtasks_not_array' }
  }

  if (rawPlan.subtasks.length === 0) {
    return { valid: false, reason: 'subtasks_empty' }
  }

  if (rawPlan.subtasks.length > MAX_SUBTASKS) {
    return { valid: false, reason: 'too_many_subtasks' }
  }

  const steps = []
  const seenStepIds = new Set()
  for (let i = 0; i < rawPlan.subtasks.length; i++) {
    const raw = rawPlan.subtasks[i]

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, reason: `subtask_${i}_not_object` }
    }

    if (typeof raw.agentId !== 'string' || !getAgentById(raw.agentId)) {
      return { valid: false, reason: `subtask_${i}_unknown_agent` }
    }

    if (typeof raw.input !== 'string' || raw.input.length === 0) {
      return { valid: false, reason: `subtask_${i}_invalid_input` }
    }

    if (raw.input.length > MAX_INPUT_LENGTH) {
      return { valid: false, reason: `subtask_${i}_input_too_long` }
    }

    const stepId =
      typeof raw.stepId === 'string' && raw.stepId.trim().length > 0
        ? raw.stepId.trim()
        : `step-${i}`
    if (seenStepIds.has(stepId)) {
      return { valid: false, reason: `subtask_${i}_duplicate_step_id` }
    }
    seenStepIds.add(stepId)

    // Model-supplied `cost` is intentionally dropped here. Payment always
    // resolves from the registry via agentCost(agent) in orchestrator.js.
    steps.push({
      stepId,
      agentId: raw.agentId,
      input: raw.input,
    })
  }

  let finalStepId = steps[steps.length - 1].stepId
  if (rawPlan.finalStepId !== undefined && rawPlan.finalStepId !== null) {
    if (typeof rawPlan.finalStepId !== 'string' || !seenStepIds.has(rawPlan.finalStepId.trim())) {
      return { valid: false, reason: 'invalid_final_step_id' }
    }
    finalStepId = rawPlan.finalStepId.trim()
  }

  return {
    valid: true,
    plan: {
      plan: typeof rawPlan.plan === 'string' ? rawPlan.plan : '',
      subtasks: steps,
      finalStepId,
    },
  }
}

/**
 * Builds a bounded, budget-aware fallback plan using only known agents.
 * Used when the model's plan is missing, malformed, or fails validatePlan().
 * Routed back through validatePlan() so the fallback carries the same
 * stable step IDs and guarantees as a model-generated plan.
 * @param {string} task
 * @param {number} budget
 * @returns {{ plan: string, subtasks: Array, finalStepId: string | null }}
 */
export function buildFallbackPlan(task, budget) {
  const subtasks = []
  let remaining = budget

  if (remaining >= 0.01) {
    subtasks.push({ agentId: 'research-bot', input: task })
    remaining -= 0.01
  }
  if (remaining >= 0.01) {
    subtasks.push({
      agentId: 'summary-bot',
      input: `Summarize findings about: ${task}`,
    })
    remaining -= 0.01
  }
  if (remaining >= 0.05) {
    subtasks.push({ agentId: 'analyst-bot', input: task })
    remaining -= 0.05
  }
  if (remaining >= 0.03) {
    subtasks.push({
      agentId: 'code-bot',
      input: `Write an implementation related to: ${task}`,
    })
    remaining -= 0.03
  }

  const built = {
    plan: `Multi-agent workflow: ${subtasks.map((s) => s.agentId).join(' → ')} (${subtasks.length} agents, ${budget} USDC budget)`,
    subtasks,
  }

  const result = validatePlan(built)
  return result.valid ? result.plan : { plan: built.plan, subtasks: [], finalStepId: null }
}

/**
 * Determines whether a step result represents a failed execution rather than
 * a completed answer or a budget-skipped step (Issue #173).
 * @param {object} step
 * @returns {boolean}
 */
export function isFailedStepResult(step) {
  if (!step || typeof step !== 'object') return true
  if (step.skipped) return false
  if (step.failed === true || step.status === 'failed' || Boolean(step.error)) return true
  if (step.responseMeta?.empty) return true
  const text =
    typeof step.output === 'string'
      ? step.output.trim()
      : typeof step.result === 'string'
        ? step.result.trim()
        : step.output !== undefined && step.output !== null
          ? String(step.output).trim()
          : ''
  if (!text) return true
  if (/^Error:/i.test(text)) return true
  return false
}

/**
 * Resolves the explicit final output for a run from its validated plan and
 * step results without guessing based on agent type or invoking any unquoted
 * synthesis call (Issue #173).
 *
 * @param {{ subtasks?: Array, finalStepId?: string | null } | null | undefined} plan
 * @param {Array<object>} results
 * @returns {{
 *   available: boolean,
 *   status: 'completed' | 'failed' | 'skipped' | 'empty_plan' | 'not_executed' | 'invalid_final_step',
 *   stepId: string | null,
 *   agentId: string | null,
 *   agentName: string | null,
 *   output: string | null,
 *   reason: string | null,
 *   partialResultsAvailable: boolean,
 *   completedStepCount: number
 * }}
 */
export function resolveFinalOutput(plan, results = []) {
  const safeResults = Array.isArray(results) ? results : []
  const rawSubtasks = Array.isArray(plan?.subtasks) ? plan.subtasks : []
  const normalizedSubtasks = rawSubtasks.map((s, idx) => ({
    ...s,
    stepId:
      typeof s?.stepId === 'string' && s.stepId.trim().length > 0 ? s.stepId.trim() : `step-${idx}`,
  }))
  const normalizedResults = safeResults.map((r, idx) => ({
    ...r,
    stepId:
      typeof r?.stepId === 'string' && r.stepId.trim().length > 0
        ? r.stepId.trim()
        : normalizedSubtasks[idx]?.stepId || `step-${idx}`,
  }))

  const completedSteps = normalizedResults.filter((r) => !r.skipped && !isFailedStepResult(r))
  const completedStepCount = completedSteps.length

  if (normalizedSubtasks.length === 0 && normalizedResults.length === 0) {
    return {
      available: false,
      status: 'empty_plan',
      stepId: null,
      agentId: null,
      agentName: null,
      output: null,
      reason: 'Plan contained no executable steps.',
      partialResultsAvailable: false,
      completedStepCount: 0,
    }
  }

  const configuredFinalStepId =
    typeof plan?.finalStepId === 'string' && plan.finalStepId.trim().length > 0
      ? plan.finalStepId.trim()
      : null

  const fallbackFinalStepId =
    normalizedSubtasks.length > 0
      ? normalizedSubtasks[normalizedSubtasks.length - 1].stepId
      : normalizedResults[normalizedResults.length - 1].stepId

  const finalStepId = configuredFinalStepId || fallbackFinalStepId

  const targetSubtask = normalizedSubtasks.find((s) => s.stepId === finalStepId) || null
  const targetResult = normalizedResults.find((r) => r.stepId === finalStepId) || null

  if (configuredFinalStepId && !targetSubtask && !targetResult) {
    return {
      available: false,
      status: 'invalid_final_step',
      stepId: configuredFinalStepId,
      agentId: null,
      agentName: null,
      output: null,
      reason: `Configured final step '${configuredFinalStepId}' does not exist in the plan.`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  if (!targetResult) {
    const agentId = targetSubtask?.agentId || null
    const agentName = (agentId && getAgentById(agentId)?.name) || agentId || null
    return {
      available: false,
      status: 'not_executed',
      stepId: finalStepId,
      agentId,
      agentName,
      output: null,
      reason: `Final step ${finalStepId} (${agentId || 'unknown'}) was not executed.`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  const agentId = targetResult.agentId || targetSubtask?.agentId || null
  const agentName =
    targetResult.agentName || (agentId && getAgentById(agentId)?.name) || agentId || null

  if (targetResult.skipped) {
    return {
      available: false,
      status: 'skipped',
      stepId: finalStepId,
      agentId,
      agentName,
      output: null,
      reason:
        targetResult.reason || `Final step ${finalStepId} (${agentId || 'agent'}) was skipped.`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  if (isFailedStepResult(targetResult)) {
    const rawOutput =
      typeof targetResult.output === 'string'
        ? targetResult.output.trim()
        : typeof targetResult.result === 'string'
          ? targetResult.result.trim()
          : ''
    const detail =
      (typeof targetResult.error === 'string' && targetResult.error) ||
      targetResult.error?.message ||
      (/^Error:/i.test(rawOutput) ? rawOutput.replace(/^Error:\s*/i, '') : '') ||
      (targetResult.responseMeta?.empty ? 'Agent returned empty response content' : '') ||
      'Final step execution failed'
    return {
      available: false,
      status: 'failed',
      stepId: finalStepId,
      agentId,
      agentName,
      output: null,
      reason: `Final step ${finalStepId} (${agentId || 'agent'}) failed: ${detail}`,
      partialResultsAvailable: completedStepCount > 0,
      completedStepCount,
    }
  }

  const resolvedOutput =
    typeof targetResult.output === 'string'
      ? targetResult.output
      : typeof targetResult.result === 'string'
        ? targetResult.result
        : JSON.stringify(targetResult.output ?? targetResult.result)

  return {
    available: true,
    status: 'completed',
    stepId: finalStepId,
    agentId,
    agentName,
    output: resolvedOutput,
    reason: null,
    partialResultsAvailable: completedStepCount > 1,
    completedStepCount,
  }
}
