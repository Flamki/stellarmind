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
export const MAX_CONTEXT_CHARS = 3000
export const DEPENDENCY_FAILURE_POLICIES = ['skip', 'continue']

function detectCycle(stepIds, rawDependsOnByStepId) {
  const visiting = new Set()
  const visited = new Set()

  function dfs(stepId) {
    if (visiting.has(stepId)) return true
    if (visited.has(stepId)) return false
    visiting.add(stepId)
    const deps = rawDependsOnByStepId.get(stepId) || []
    for (const depId of deps) {
      if (rawDependsOnByStepId.has(depId) && dfs(depId)) {
        return true
      }
    }
    visiting.delete(stepId)
    visited.add(stepId)
    return false
  }

  for (const stepId of stepIds) {
    if (dfs(stepId)) return true
  }
  return false
}

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

  const assignedStepIds = []
  const seenStepIds = new Set()

  for (let i = 0; i < rawPlan.subtasks.length; i++) {
    const raw = rawPlan.subtasks[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, reason: `subtask_${i}_not_object` }
    }
    const candidateStepId = raw.stepId !== undefined ? raw.stepId : `step-${i}`
    if (typeof candidateStepId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(candidateStepId)) {
      return { valid: false, reason: `subtask_${i}_invalid_step_id` }
    }
    if (seenStepIds.has(candidateStepId)) {
      return { valid: false, reason: `subtask_${i}_duplicate_step_id` }
    }
    seenStepIds.add(candidateStepId)
    assignedStepIds.push(candidateStepId)
  }

  const stepIndexById = new Map(assignedStepIds.map((id, idx) => [id, idx]))
  const rawDependsOnByStepId = new Map()

  const steps = []
  for (let i = 0; i < rawPlan.subtasks.length; i++) {
    const raw = rawPlan.subtasks[i]
    const stepId = assignedStepIds[i]

    if (typeof raw.agentId !== 'string' || !getAgentById(raw.agentId)) {
      return { valid: false, reason: `subtask_${i}_unknown_agent` }
    }

    if (typeof raw.input !== 'string' || raw.input.length === 0) {
      return { valid: false, reason: `subtask_${i}_invalid_input` }
    }

    if (raw.input.length > MAX_INPUT_LENGTH) {
      return { valid: false, reason: `subtask_${i}_input_too_long` }
    }

    const explicitDependsOn = raw.dependsOn !== undefined
    let dependsOn
    if (explicitDependsOn) {
      if (!Array.isArray(raw.dependsOn)) {
        return { valid: false, reason: `subtask_${i}_invalid_depends_on` }
      }
      const depSeen = new Set()
      for (const depId of raw.dependsOn) {
        if (typeof depId !== 'string' || depId.trim().length === 0) {
          return { valid: false, reason: `subtask_${i}_invalid_depends_on` }
        }
        if (depSeen.has(depId)) {
          return { valid: false, reason: `subtask_${i}_duplicate_dependency` }
        }
        depSeen.add(depId)
        if (!stepIndexById.has(depId)) {
          return { valid: false, reason: `subtask_${i}_unknown_dependency` }
        }
        if (depId === stepId) {
          return { valid: false, reason: `subtask_${i}_cyclic_dependency` }
        }
      }
      dependsOn = [...raw.dependsOn]
    } else {
      dependsOn = i > 0 ? [assignedStepIds[i - 1]] : []
    }

    rawDependsOnByStepId.set(stepId, dependsOn)

    let onDependencyFailure = raw.onDependencyFailure
    if (onDependencyFailure !== undefined) {
      if (!DEPENDENCY_FAILURE_POLICIES.includes(onDependencyFailure)) {
        return { valid: false, reason: `subtask_${i}_invalid_dependency_policy` }
      }
    } else {
      onDependencyFailure = explicitDependsOn ? 'skip' : 'continue'
    }

    // Model-supplied `cost` is intentionally dropped here. Payment always
    // resolves from the registry via agentCost(agent) in orchestrator.js.
    steps.push({
      stepId,
      agentId: raw.agentId,
      input: raw.input,
      dependsOn,
      explicitDependsOn,
      onDependencyFailure,
    })
  }

  // Check for cycles across declared dependencies before checking sequential order
  if (detectCycle(assignedStepIds, rawDependsOnByStepId)) {
    return { valid: false, reason: 'cyclic_dependency' }
  }

  // Enforce sequential execution order: a step can only depend on earlier steps
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    for (const depId of step.dependsOn) {
      const depIdx = stepIndexById.get(depId)
      if (depIdx > i) {
        return { valid: false, reason: `subtask_${i}_forward_dependency` }
      }
    }
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
 * Deterministically assembles context for a step from its declared `dependsOn` outputs
 * within a documented character budget (`MAX_CONTEXT_CHARS`), signaling any truncated
 * or omitted content and evaluating the step's `onDependencyFailure` policy (Issue #147).
 *
 * @param {Object} subtask - Validated subtask descriptor
 * @param {Map<string, Object>|Object} stepOutcomesById - Map or record of earlier step outcomes
 * @param {{ maxContextChars?: number }} [options]
 * @returns {{
 *   shouldSkip: boolean,
 *   skipReason: string | null,
 *   contextText: string,
 *   contextMeta: {
 *     dependsOn: string[],
 *     sourceStepIds: string[],
 *     failedStepIds: string[],
 *     truncatedStepIds: string[],
 *     truncated: boolean,
 *     maxChars: number,
 *     totalChars: number,
 *     includedChars: number,
 *     omittedChars: number,
 *     onDependencyFailure: string
 *   }
 * }}
 */
export function assembleStepContext(subtask, stepOutcomesById, options = {}) {
  const maxChars =
    Number.isInteger(options.maxContextChars) && options.maxContextChars > 0
      ? options.maxContextChars
      : MAX_CONTEXT_CHARS
  const dependsOn = Array.isArray(subtask?.dependsOn) ? subtask.dependsOn : []
  const policy = subtask?.onDependencyFailure || (subtask?.explicitDependsOn ? 'skip' : 'continue')

  const getOutcome = (id) =>
    stepOutcomesById instanceof Map ? stepOutcomesById.get(id) : stepOutcomesById?.[id]

  const succeededDeps = []
  const failedStepIds = []

  for (const depId of dependsOn) {
    const outcome = getOutcome(depId)
    if (!outcome || outcome.status !== 'succeeded' || outcome.skipped || outcome.error) {
      failedStepIds.push(depId)
      continue
    }
    const rawOutput =
      typeof outcome.output === 'string'
        ? outcome.output
        : outcome.output != null
          ? JSON.stringify(outcome.output)
          : ''
    succeededDeps.push({
      stepId: depId,
      agentId: outcome.agentId || 'agent',
      rawOutput,
    })
  }

  if (failedStepIds.length > 0 && policy === 'skip') {
    return {
      shouldSkip: true,
      skipReason: 'dependency_failed',
      contextText: '',
      contextMeta: {
        dependsOn: [...dependsOn],
        sourceStepIds: [],
        failedStepIds,
        truncatedStepIds: [],
        truncated: false,
        maxChars,
        totalChars: 0,
        includedChars: 0,
        omittedChars: 0,
        onDependencyFailure: policy,
      },
    }
  }

  if (succeededDeps.length === 0) {
    return {
      shouldSkip: false,
      skipReason: null,
      contextText: '',
      contextMeta: {
        dependsOn: [...dependsOn],
        sourceStepIds: [],
        failedStepIds,
        truncatedStepIds: [],
        truncated: false,
        maxChars,
        totalChars: 0,
        includedChars: 0,
        omittedChars: 0,
        onDependencyFailure: policy,
      },
    }
  }

  // Format each dependency block deterministically in declared `dependsOn` order
  const useLabeledSections = !!subtask?.explicitDependsOn || succeededDeps.length > 1
  const formattedEntries = succeededDeps.map((dep) => {
    const header = useLabeledSections ? `[${dep.stepId} (${dep.agentId})]:\n` : ''
    return {
      ...dep,
      header,
      fullBlock: `${header}${dep.rawOutput}`,
    }
  })

  const separator = '\n\n'
  const totalSeparatorChars = separator.length * Math.max(0, formattedEntries.length - 1)
  const fullJoined = formattedEntries.map((e) => e.fullBlock).join(separator)
  const totalChars = fullJoined.length

  if (totalChars <= maxChars) {
    return {
      shouldSkip: false,
      skipReason: null,
      contextText: fullJoined,
      contextMeta: {
        dependsOn: [...dependsOn],
        sourceStepIds: formattedEntries.map((e) => e.stepId),
        failedStepIds,
        truncatedStepIds: [],
        truncated: false,
        maxChars,
        totalChars,
        includedChars: totalChars,
        omittedChars: 0,
        onDependencyFailure: policy,
      },
    }
  }

  // Fair per-dependency allocation within maxChars so earlier dependencies
  // cannot starve later dependencies when multiple outputs are combined.
  const availableBlockBudget = Math.max(0, maxChars - totalSeparatorChars)
  const baseQuota = Math.floor(availableBlockBudget / formattedEntries.length)
  let remainderPool = availableBlockBudget - baseQuota * formattedEntries.length

  // First pass: entries shorter than baseQuota donate their unused chars to remainderPool
  const allocations = formattedEntries.map((entry) => {
    if (entry.fullBlock.length <= baseQuota) {
      remainderPool += baseQuota - entry.fullBlock.length
      return entry.fullBlock.length
    }
    return baseQuota
  })

  // Second pass: distribute remainderPool deterministically across entries that need more space
  for (let i = 0; i < formattedEntries.length && remainderPool > 0; i++) {
    const needed = formattedEntries[i].fullBlock.length - allocations[i]
    if (needed > 0) {
      const extra = Math.min(needed, remainderPool)
      allocations[i] += extra
      remainderPool -= extra
    }
  }

  const truncatedStepIds = []
  let omittedRawChars = 0
  const renderedBlocks = formattedEntries.map((entry, idx) => {
    const allowed = allocations[idx]
    if (entry.fullBlock.length <= allowed) {
      return entry.fullBlock
    }
    truncatedStepIds.push(entry.stepId)
    const sliceLen = Math.max(0, allowed)
    const sliced = entry.fullBlock.slice(0, sliceLen)
    omittedRawChars += entry.fullBlock.length - sliced.length
    return sliced
  })

  const contextText = renderedBlocks.join(separator).slice(0, maxChars)
  const includedChars = contextText.length
  const omittedChars = Math.max(omittedRawChars, totalChars - includedChars)

  return {
    shouldSkip: false,
    skipReason: null,
    contextText,
    contextMeta: {
      dependsOn: [...dependsOn],
      sourceStepIds: formattedEntries.map((e) => e.stepId),
      failedStepIds,
      truncatedStepIds,
      truncated: true,
      maxChars,
      totalChars,
      includedChars,
      omittedChars,
      onDependencyFailure: policy,
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
