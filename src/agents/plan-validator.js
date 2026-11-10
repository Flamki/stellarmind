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
import { AssetAmount, agentCost } from './budget.js'
import { pricingConfig } from '../pricing.config.js'

export const MAX_SUBTASKS = 6
export const MAX_INPUT_LENGTH = 4000

const FALLBACK_CANDIDATES = [
  {
    agentId: 'research-bot',
    buildInput: (task) => task,
  },
  {
    agentId: 'summary-bot',
    buildInput: (task) => `Summarize findings about: ${task}`,
  },
  {
    agentId: 'analyst-bot',
    buildInput: (task) => task,
  },
  {
    agentId: 'code-bot',
    buildInput: (task) => `Write an implementation related to: ${task}`,
  },
]

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
 *
 * Prices are resolved dynamically from the agent registry / pricing configuration
 * and compared using exact AssetAmount arithmetic (Issue #148).
 *
 * @param {string} task
 * @param {number|string} budget
 * @param {Object} [cfg=pricingConfig]
 * @returns {{ plan: string, subtasks: Array }}
 */
export function buildFallbackPlan(task, budget, cfg = pricingConfig) {
  const subtasks = []
  let remaining = AssetAmount.from(budget, 'USDC')

  for (const candidate of FALLBACK_CANDIDATES) {
    const agent = getAgentById(candidate.agentId, cfg)
    if (!agent) continue

    const cost = agentCost(agent)
    if (remaining.isGreaterThanOrEqualTo(cost)) {
      subtasks.push({
        agentId: candidate.agentId,
        input: candidate.buildInput(task),
      })
      remaining = remaining.minus(cost)
    }
  }

  const built = {
    plan: `Multi-agent workflow: ${subtasks.map((s) => s.agentId).join(' → ')} (${subtasks.length} agents, ${budget} USDC budget)`,
    subtasks,
  }

  const result = validatePlan(built)
  return result.valid ? result.plan : { plan: built.plan, subtasks: [] }
}
