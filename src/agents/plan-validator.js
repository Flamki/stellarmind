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

    // Model-supplied `cost` is intentionally dropped here. Payment always
    // resolves from the registry via agentCost(agent) in orchestrator.js.
    steps.push({
      stepId: `step-${i}`,
      agentId: raw.agentId,
      input: raw.input,
    })
  }

  return {
    valid: true,
    plan: {
      plan: typeof rawPlan.plan === 'string' ? rawPlan.plan : '',
      subtasks: steps,
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
 * @returns {{ plan: string, subtasks: Array }}
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
  return result.valid ? result.plan : { plan: built.plan, subtasks: [] }
}
