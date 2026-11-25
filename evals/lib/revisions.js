/**
 * Prompt and model revisions currently configured for each agent (issue #154).
 *
 * The prompt revision is the same digest that #153 stores on every live agent
 * result (`provenance.promptRevision`), so an evaluation report can be tied to
 * the exact wording and model that produced real outputs. The planner prompt
 * is built inline in orchestrator.js and has no revision yet; the report says so
 * explicitly instead of inventing one.
 */
import { AGENT_MODELS, PROMPT_TEMPLATES } from '../../src/agents/services.js'
import { PLANNING_MODEL } from '../../src/agents/orchestrator.js'
import { AGENTS } from '../../src/agents/registry.js'
import { promptDigest } from '../../src/agents/provenance.js'
import { PLANNER_ID } from './load.js'

const AGENT_PROMPTS = {
  'research-bot': { template: 'research', model: AGENT_MODELS.research, fallback: null },
  'summary-bot': { template: 'summary', model: AGENT_MODELS.summary, fallback: null },
  'analyst-bot': {
    template: 'analysis',
    model: AGENT_MODELS.analysisPrimary,
    fallback: AGENT_MODELS.analysisFallback,
  },
  'code-bot': { template: 'code', model: AGENT_MODELS.code, fallback: null },
}

/** @returns {Record<string, {model: string, fallbackModel: string|null, promptRevision: string|null, note?: string}>} */
export function currentRevisions() {
  const revisions = {}
  for (const agent of AGENTS) {
    const entry = AGENT_PROMPTS[agent.id]
    if (!entry) throw new Error(`No prompt mapping for registry agent "${agent.id}"`)
    revisions[agent.id] = {
      model: entry.model,
      fallbackModel: entry.fallback,
      promptRevision: promptDigest(PROMPT_TEMPLATES[entry.template]),
    }
  }
  revisions[PLANNER_ID] = {
    model: PLANNING_MODEL,
    fallbackModel: null,
    promptRevision: null,
    note: 'planner prompt is built inline in orchestrator.js and has no revision yet',
  }
  return Object.fromEntries(
    Object.entries(revisions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
}
