/**
 * Versioned Offline Evaluation Set for Agent Output Quality (#154)
 *
 * Provides:
 * - Curated non-sensitive benchmark tasks across planning, research, summary,
 *   analysis, and code-assistance phases.
 * - Concrete automated structural checks that run 100% offline without API keys,
 *   Stellar wallets, or network access.
 * - Explicit separation between automated structural checks and human-judgment
 *   review criteria.
 * - Prompt and model revision tracking + baseline comparison so intentional
 *   quality or prompt updates follow a documented review process.
 * - Opt-in, separately cost-controlled live model evaluation guardrails.
 */

import crypto from 'node:crypto'
import { AGENT_MODELS, FALLBACKS } from './services.js'
import { parsePlanResponse } from './orchestrator.js'
import { validatePlan } from './plan-validator.js'
import { AGENTS, getAgentById } from './registry.js'

export const EVALUATION_SUITE_VERSION = '1.0.0'
export const EVALUATION_SCHEMA_VERSION = 'stellarmind.agent-quality-eval.v1'

export const PROMPT_REVISIONS = Object.freeze({
  planning: 'planning-prompt-v1.0.0',
  'research-bot': 'research-prompt-v1.0.0',
  'summary-bot': 'summary-prompt-v1.0.0',
  'analyst-bot': 'analysis-prompt-v1.0.0',
  'code-bot': 'code-prompt-v1.0.0',
})

export const MODEL_REVISIONS = Object.freeze({
  planning: 'claude-haiku-4-5-20251001',
  'research-bot': AGENT_MODELS.research,
  'summary-bot': AGENT_MODELS.summary,
  'analyst-bot': AGENT_MODELS.analysisPrimary,
  'analyst-bot-fallback': AGENT_MODELS.analysisFallback,
  'code-bot': AGENT_MODELS.code,
})

/**
 * Compute a deterministic digest of the active prompt & model revisions so
 * reports always identify the exact revision under test.
 */
export function getEvaluationRevisionManifest() {
  const payload = {
    suiteVersion: EVALUATION_SUITE_VERSION,
    prompts: PROMPT_REVISIONS,
    models: MODEL_REVISIONS,
  }
  const revisionDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16)

  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    revisionDigest: `rev-${revisionDigest}`,
    prompts: { ...PROMPT_REVISIONS },
    models: { ...MODEL_REVISIONS },
  }
}

/**
 * Curated, non-sensitive evaluation cases covering every StellarMind phase/agent.
 * Each case defines:
 *   - `id`, `title`, `phase`, `agentId`, `task`, optional `budget`
 *   - `promptRevision` and `modelRevision`
 *   - `expectedProperties`: concrete structural properties verified automatically offline
 *   - `humanReviewCriteria`: qualitative dimensions that require human judgment
 *   - `baselineFixtureOutput`: canonical offline output satisfying the baseline contract
 */
export const OFFLINE_EVALUATION_SET = Object.freeze([
  Object.freeze({
    id: 'eval-planning-01',
    title: 'Multi-agent x402 research, summary, and analysis plan under 0.08 USDC',
    phase: 'planning',
    agentId: 'orchestrator-planner',
    task: 'Decompose a multi-agent workflow to research Stellar x402 micropayments, summarize the protocol flow, and analyze enterprise adoption risks within a 0.08 USDC budget.',
    budget: 0.08,
    promptRevision: PROMPT_REVISIONS.planning,
    modelRevision: MODEL_REVISIONS.planning,
    expectedProperties: Object.freeze({
      validPlanJson: true,
      minSubtasks: 2,
      maxSubtasks: 3,
      budgetCeiling: 0.08,
      requiredAgents: Object.freeze(['research-bot', 'summary-bot']),
      requiredTerms: Object.freeze(['x402', 'stellar']),
      minLength: 80,
      maxLength: 2000,
      forbidPlaceholders: true,
    }),
    humanReviewCriteria: Object.freeze([
      'Subtask sequence follows logical dependency order (research before summary and analysis).',
      'Subtask input instructions are scoped clearly without redundant work across agents.',
    ]),
    baselineFixtureOutput: JSON.stringify({
      plan: 'Research Stellar x402 micropayment flows, summarize protocol mechanics, and analyze enterprise adoption risks within 0.08 USDC.',
      subtasks: [
        {
          agentId: 'research-bot',
          input: 'Research Stellar x402 micropayment settlement flows and fee structure',
          cost: '0.01',
        },
        {
          agentId: 'summary-bot',
          input: 'Summarize the Stellar x402 protocol flow in concise executive bullets',
          cost: '0.01',
        },
        {
          agentId: 'analyst-bot',
          input: 'Analyze enterprise adoption risks and controls for Stellar x402 payments',
          cost: '0.05',
        },
      ],
    }),
  }),

  Object.freeze({
    id: 'eval-planning-02',
    title: 'Tight 0.02 USDC budget-constrained planning avoids expensive agents',
    phase: 'planning',
    agentId: 'orchestrator-planner',
    task: 'Create a budget-capped 0.02 USDC workflow to research and summarize Soroban smart contract resource fee limits on Stellar.',
    budget: 0.02,
    promptRevision: PROMPT_REVISIONS.planning,
    modelRevision: MODEL_REVISIONS.planning,
    expectedProperties: Object.freeze({
      validPlanJson: true,
      minSubtasks: 1,
      maxSubtasks: 2,
      budgetCeiling: 0.02,
      requiredAgents: Object.freeze(['research-bot']),
      forbiddenAgents: Object.freeze(['analyst-bot', 'code-bot']),
      requiredTerms: Object.freeze(['soroban', 'stellar']),
      minLength: 60,
      maxLength: 1500,
      forbidPlaceholders: true,
    }),
    humanReviewCriteria: Object.freeze([
      'Planner respects the 0.02 USDC cap by selecting 0.01 USDC agents rather than proposing unaffordable steps.',
      'Plan description states how the task is covered within the constrained budget.',
    ]),
    baselineFixtureOutput: JSON.stringify({
      plan: 'Use research-bot and summary-bot within the 0.02 USDC budget to investigate and condense Soroban resource fee limits on Stellar.',
      subtasks: [
        {
          agentId: 'research-bot',
          input: 'Research Soroban smart contract resource fee limits on Stellar',
          cost: '0.01',
        },
        {
          agentId: 'summary-bot',
          input: 'Summarize findings on Soroban smart contract resource fee limits on Stellar',
          cost: '0.01',
        },
      ],
    }),
  }),

  Object.freeze({
    id: 'eval-research-01',
    title: 'Research synthesis on HTTP 402 micropayment settlement on Stellar',
    phase: 'agent',
    agentId: 'research-bot',
    task: 'HTTP 402 micropayment settlement flows on Stellar Testnet and stablecoin finality',
    promptRevision: PROMPT_REVISIONS['research-bot'],
    modelRevision: MODEL_REVISIONS['research-bot'],
    expectedProperties: Object.freeze({
      minLength: 180,
      maxLength: 2500,
      minBulletPoints: 3,
      minSentences: 3,
      maxSentences: 15,
      requiredTerms: Object.freeze(['x402', 'stellar', 'settlement']),
      requiresSourceAttribution: true,
      forbidPlaceholders: true,
    }),
    humanReviewCriteria: Object.freeze([
      'Factual accuracy of Stellar ledger close times and micropayment fee economics.',
      'Relevance of cited sources and absence of speculative claims presented as facts.',
    ]),
    baselineFixtureOutput: FALLBACKS.research(
      'HTTP 402 micropayment settlement flows on Stellar Testnet and stablecoin finality'
    ),
  }),

  Object.freeze({
    id: 'eval-summary-01',
    title: 'Concise executive summary of x402 payment challenge and reconciliation flow',
    phase: 'agent',
    agentId: 'summary-bot',
    task: 'Autonomous AI agents require programmable HTTP 402 payment rails on Stellar to discover endpoint pricing, sign USDC transactions, and reconcile payment proofs without manual intervention.',
    promptRevision: PROMPT_REVISIONS['summary-bot'],
    modelRevision: MODEL_REVISIONS['summary-bot'],
    expectedProperties: Object.freeze({
      minLength: 120,
      maxLength: 900,
      minSentences: 2,
      maxSentences: 6,
      requiredSections: Object.freeze(['Key Takeaway']),
      requiredTerms: Object.freeze(['x402', 'stellar', 'payment']),
      forbidPlaceholders: true,
    }),
    humanReviewCriteria: Object.freeze([
      'Fidelity to source text without introducing unsupported claims.',
      'Readability and conciseness suitable for dashboard result cards.',
    ]),
    baselineFixtureOutput: FALLBACKS.summary(
      'Autonomous AI agents require programmable HTTP 402 payment rails on Stellar to discover endpoint pricing, sign USDC transactions, and reconcile payment proofs without manual intervention.'
    ),
  }),

  Object.freeze({
    id: 'eval-analysis-01',
    title: 'Structured strategic analysis with Key Findings, Risks, and Opportunities',
    phase: 'agent',
    agentId: 'analyst-bot',
    task: 'Cross-asset fallback policies and budget enforcement for autonomous AI agent marketplaces on Stellar',
    promptRevision: PROMPT_REVISIONS['analyst-bot'],
    modelRevision: MODEL_REVISIONS['analyst-bot'],
    expectedProperties: Object.freeze({
      minLength: 250,
      maxLength: 3000,
      requiredSections: Object.freeze(['Key Findings', 'Risks', 'Opportunities']),
      minBulletPoints: 6,
      requiredTerms: Object.freeze(['x402', 'stellar', 'budget']),
      forbidPlaceholders: true,
    }),
    humanReviewCriteria: Object.freeze([
      'Depth of risk identification (latency, liquidity, provider dependencies).',
      'Practicality and specificity of strategic opportunities.',
    ]),
    baselineFixtureOutput: FALLBACKS.analysis(
      'Cross-asset fallback policies and budget enforcement for autonomous AI agent marketplaces on Stellar'
    ),
  }),

  Object.freeze({
    id: 'eval-code-01',
    title: 'Working Stellar SDK payment helper with fenced JavaScript code and explanation',
    phase: 'agent',
    agentId: 'code-bot',
    task: 'Write an async JavaScript helper that builds, signs, and submits a Stellar Testnet payment transaction using @stellar/stellar-sdk.',
    promptRevision: PROMPT_REVISIONS['code-bot'],
    modelRevision: MODEL_REVISIONS['code-bot'],
    expectedProperties: Object.freeze({
      minLength: 200,
      maxLength: 3500,
      requiresCodeBlock: true,
      requiredCodeTokens: Object.freeze([
        'TransactionBuilder',
        'Operation.payment',
        'Networks.TESTNET',
        'async function',
      ]),
      balancedBraces: true,
      requiresExplanationText: true,
      forbidPlaceholders: true,
    }),
    humanReviewCriteria: Object.freeze([
      'Correctness of @stellar/stellar-sdk transaction construction and timeout configuration.',
      'Security posture (accepts secret/keypair via parameters rather than hardcoding secrets).',
    ]),
    baselineFixtureOutput: FALLBACKS.code(
      'Write an async JavaScript helper that builds, signs, and submits a Stellar Testnet payment transaction using @stellar/stellar-sdk.'
    ),
  }),
])

/**
 * Deliberately incomplete or malformed fixture outputs used by validation suites
 * to prove that automated structural checks detect regressions and fail loudly.
 */
export const DELIBERATELY_INCOMPLETE_FIXTURES = Object.freeze({
  'eval-planning-01': JSON.stringify({
    plan: 'Incomplete over-budget plan missing required terms',
    subtasks: [
      { agentId: 'analyst-bot', input: 'Do analysis', cost: '0.05' },
      { agentId: 'analyst-bot', input: 'Do more analysis', cost: '0.05' },
    ],
  }),
  'eval-planning-02': JSON.stringify({
    plan: 'Violates 0.02 USDC cap by picking analyst-bot',
    subtasks: [{ agentId: 'analyst-bot', input: 'Analyze fee limits', cost: '0.05' }],
  }),
  'eval-research-01':
    'Short unverified paragraph with no bullet points, no settlement details, and no source attribution.',
  'eval-summary-01': 'Too short and missing takeaway.',
  'eval-analysis-01': `[Analysis Agent]\n\n**Key Findings:**\n• Only one bullet point is included here and the other two required sections were left out.`,
  'eval-code-01':
    'You can use the Stellar SDK to send a payment by creating a TransactionBuilder, but no fenced code block is provided here.',
})

/**
 * Checked-in baseline summary for `EVALUATION_SUITE_VERSION = 1.0.0`.
 */
export const EVALUATION_BASELINE_SUMMARY = Object.freeze({
  suiteVersion: EVALUATION_SUITE_VERSION,
  totalCases: 6,
  passedCases: 6,
  failedCases: 0,
  totalAutomatedChecks: 49,
  passedAutomatedChecks: 49,
  failedAutomatedChecks: 0,
  passRate: 1,
  score: 100,
  caseIds: Object.freeze(OFFLINE_EVALUATION_SET.map((c) => c.id)),
})

function countSentences(text) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .trim()
  if (!cleaned) return 0
  return cleaned
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3).length
}

function countBulletPoints(text) {
  const lines = String(text || '').split('\n')
  return lines.filter((line) => /^\s*(?:[•*-]|\d+\.)\s+\S+/.test(line)).length
}

function extractFencedCodeBlocks(text) {
  const blocks = []
  const regex = /```(?:javascript|js|ts|typescript)?\n([\s\S]*?)```/gi
  let match = regex.exec(String(text || ''))
  while (match !== null) {
    blocks.push(match[1])
    match = regex.exec(String(text || ''))
  }
  return blocks
}

function hasBalancedDelimiters(code) {
  const pairs = { '{': '}', '(': ')', '[': ']' }
  const closers = new Set(Object.values(pairs))
  const stack = []
  for (const ch of String(code || '')) {
    if (pairs[ch]) {
      stack.push(pairs[ch])
    } else if (closers.has(ch)) {
      if (stack.pop() !== ch) return false
    }
  }
  return stack.length === 0
}

function containsForbiddenPlaceholder(text) {
  const raw = String(text || '')
  return (
    /\b(?:TODO|FIXME|TBD|INSERT_HERE|PLACEHOLDER)\b/.test(raw) ||
    /sk-ant-[a-zA-Z0-9_-]{10,}/.test(raw)
  )
}

/**
 * Evaluate a single evaluation case against a candidate output string.
 * Runs 100% offline using deterministic structural checks.
 */
export function evaluateOutputQualityCase(evalCase, rawOutput) {
  const output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? '')
  const props = evalCase.expectedProperties || {}
  const checks = []

  const addCheck = (name, passed, expected, actual, message) => {
    checks.push({
      name,
      passed: Boolean(passed),
      expected,
      actual,
      message,
    })
  }

  // 1. Non-empty & length bounds
  const trimmedLength = output.trim().length
  addCheck(
    'non_empty_output',
    trimmedLength > 0,
    '> 0 chars',
    `${trimmedLength} chars`,
    trimmedLength > 0 ? 'Output is non-empty' : 'Output is empty'
  )

  if (typeof props.minLength === 'number') {
    addCheck(
      'min_length',
      trimmedLength >= props.minLength,
      `>= ${props.minLength} chars`,
      `${trimmedLength} chars`,
      trimmedLength >= props.minLength
        ? `Length (${trimmedLength}) meets minimum (${props.minLength})`
        : `Length (${trimmedLength}) is below minimum (${props.minLength})`
    )
  }

  if (typeof props.maxLength === 'number') {
    addCheck(
      'max_length',
      trimmedLength <= props.maxLength,
      `<= ${props.maxLength} chars`,
      `${trimmedLength} chars`,
      trimmedLength <= props.maxLength
        ? `Length (${trimmedLength}) is within maximum (${props.maxLength})`
        : `Length (${trimmedLength}) exceeds maximum (${props.maxLength})`
    )
  }

  // 2. Placeholder / secret hygiene check
  if (props.forbidPlaceholders) {
    const hasPlaceholder = containsForbiddenPlaceholder(output)
    addCheck(
      'no_placeholders_or_secrets',
      !hasPlaceholder,
      'no TODO/FIXME/secret tokens',
      hasPlaceholder ? 'placeholder or secret pattern found' : 'clean',
      !hasPlaceholder
        ? 'Output contains no forbidden placeholder or secret patterns'
        : 'Output contains forbidden placeholder or secret pattern'
    )
  }

  // 3. Required terms (case-insensitive)
  if (Array.isArray(props.requiredTerms) && props.requiredTerms.length > 0) {
    const lower = output.toLowerCase()
    const missingTerms = props.requiredTerms.filter((t) => !lower.includes(t.toLowerCase()))
    addCheck(
      'required_terms',
      missingTerms.length === 0,
      props.requiredTerms.join(', '),
      missingTerms.length === 0 ? 'all present' : `missing: ${missingTerms.join(', ')}`,
      missingTerms.length === 0
        ? 'All required domain terms are present'
        : `Missing required domain terms: ${missingTerms.join(', ')}`
    )
  }

  // 4. Planning-specific structural checks
  if (props.validPlanJson) {
    let parsedPlan = null
    let validated = null
    let parseError = null
    try {
      parsedPlan = parsePlanResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: output }],
      })
      validated = validatePlan(parsedPlan)
    } catch (err) {
      parseError = err.message
    }

    const planValid = Boolean(parsedPlan && validated?.valid)
    addCheck(
      'valid_plan_schema',
      planValid,
      'valid JSON plan with registered subtasks',
      planValid ? 'valid' : parseError || validated?.reason || 'invalid',
      planValid
        ? 'Plan parses and passes validatePlan schema checks'
        : `Plan validation failed: ${parseError || validated?.reason || 'unknown'}`
    )

    const subtasks = validated?.plan?.subtasks || parsedPlan?.subtasks || []
    if (typeof props.minSubtasks === 'number' || typeof props.maxSubtasks === 'number') {
      const count = Array.isArray(subtasks) ? subtasks.length : 0
      const minOk = typeof props.minSubtasks === 'number' ? count >= props.minSubtasks : true
      const maxOk = typeof props.maxSubtasks === 'number' ? count <= props.maxSubtasks : true
      addCheck(
        'subtask_count_bounds',
        minOk && maxOk,
        `${props.minSubtasks ?? 1}..${props.maxSubtasks ?? '∞'} subtasks`,
        `${count} subtasks`,
        minOk && maxOk
          ? `Subtask count (${count}) is within expected bounds`
          : `Subtask count (${count}) is outside expected bounds`
      )
    }

    if (typeof props.budgetCeiling === 'number') {
      const totalPlannedCost = Array.isArray(subtasks)
        ? subtasks.reduce((sum, st) => {
            const agent = getAgentById(st.agentId)
            const price = Number(agent?.price ?? st.cost ?? 0)
            return sum + (Number.isFinite(price) ? price : 0)
          }, 0)
        : Number.POSITIVE_INFINITY
      const roundedCost = Number(totalPlannedCost.toFixed(4))
      const withinBudget = planValid && roundedCost <= props.budgetCeiling + 1e-9
      addCheck(
        'plan_within_budget_ceiling',
        withinBudget,
        `<= ${props.budgetCeiling.toFixed(4)} USDC`,
        Number.isFinite(roundedCost) ? `${roundedCost.toFixed(4)} USDC` : 'invalid',
        withinBudget
          ? `Planned cost (${roundedCost.toFixed(4)} USDC) fits within budget (${props.budgetCeiling.toFixed(4)} USDC)`
          : `Planned cost (${roundedCost} USDC) exceeds budget ceiling (${props.budgetCeiling} USDC)`
      )
    }

    if (Array.isArray(props.requiredAgents) && props.requiredAgents.length > 0) {
      const selectedIds = new Set(Array.isArray(subtasks) ? subtasks.map((s) => s.agentId) : [])
      const missingAgents = props.requiredAgents.filter((id) => !selectedIds.has(id))
      addCheck(
        'required_agents_selected',
        missingAgents.length === 0,
        props.requiredAgents.join(', '),
        [...selectedIds].join(', ') || 'none',
        missingAgents.length === 0
          ? 'Plan includes all required specialist agents'
          : `Plan is missing required agents: ${missingAgents.join(', ')}`
      )
    }

    if (Array.isArray(props.forbiddenAgents) && props.forbiddenAgents.length > 0) {
      const selectedIds = new Set(Array.isArray(subtasks) ? subtasks.map((s) => s.agentId) : [])
      const presentForbidden = props.forbiddenAgents.filter((id) => selectedIds.has(id))
      addCheck(
        'forbidden_agents_excluded',
        presentForbidden.length === 0,
        `none of [${props.forbiddenAgents.join(', ')}]`,
        presentForbidden.length === 0 ? 'none present' : `present: ${presentForbidden.join(', ')}`,
        presentForbidden.length === 0
          ? 'Plan excludes unaffordable/forbidden agents'
          : `Plan includes forbidden agents: ${presentForbidden.join(', ')}`
      )
    }
  }

  // 5. Required headings / sections
  if (Array.isArray(props.requiredSections) && props.requiredSections.length > 0) {
    const missingSections = props.requiredSections.filter(
      (section) => !output.toLowerCase().includes(section.toLowerCase())
    )
    addCheck(
      'required_sections',
      missingSections.length === 0,
      props.requiredSections.join(', '),
      missingSections.length === 0 ? 'all present' : `missing: ${missingSections.join(', ')}`,
      missingSections.length === 0
        ? 'All required structural sections are present'
        : `Missing required sections: ${missingSections.join(', ')}`
    )
  }

  // 6. Bullet point count
  if (typeof props.minBulletPoints === 'number') {
    const bullets = countBulletPoints(output)
    addCheck(
      'min_bullet_points',
      bullets >= props.minBulletPoints,
      `>= ${props.minBulletPoints} bullets`,
      `${bullets} bullets`,
      bullets >= props.minBulletPoints
        ? `Bullet count (${bullets}) meets minimum (${props.minBulletPoints})`
        : `Bullet count (${bullets}) is below minimum (${props.minBulletPoints})`
    )
  }

  // 7. Sentence count bounds
  if (typeof props.minSentences === 'number' || typeof props.maxSentences === 'number') {
    const sentences = countSentences(output)
    const minOk = typeof props.minSentences === 'number' ? sentences >= props.minSentences : true
    const maxOk = typeof props.maxSentences === 'number' ? sentences <= props.maxSentences : true
    addCheck(
      'sentence_count_bounds',
      minOk && maxOk,
      `${props.minSentences ?? 1}..${props.maxSentences ?? '∞'} sentences`,
      `${sentences} sentences`,
      minOk && maxOk
        ? `Sentence count (${sentences}) is within expected range`
        : `Sentence count (${sentences}) is outside expected range`
    )
  }

  // 8. Source attribution check (research-bot)
  if (props.requiresSourceAttribution) {
    const hasSources = /\b(?:sources|references|citations)\s*:/i.test(output)
    addCheck(
      'source_attribution',
      hasSources,
      'explicit Sources:/References: line',
      hasSources ? 'present' : 'missing',
      hasSources
        ? 'Output includes explicit source attribution'
        : 'Output is missing a Sources:/References: attribution line'
    )
  }

  // 9. Code assistance checks (code-bot)
  if (props.requiresCodeBlock) {
    const codeBlocks = extractFencedCodeBlocks(output)
    const hasBlock = codeBlocks.length > 0 && codeBlocks[0].trim().length > 0
    addCheck(
      'fenced_code_block',
      hasBlock,
      'at least 1 non-empty fenced code block',
      `${codeBlocks.length} block(s)`,
      hasBlock
        ? 'Output contains a non-empty fenced code block'
        : 'Output is missing a fenced code block'
    )

    const combinedCode = codeBlocks.join('\n')
    if (Array.isArray(props.requiredCodeTokens) && props.requiredCodeTokens.length > 0) {
      const missingTokens = props.requiredCodeTokens.filter(
        (token) => !combinedCode.includes(token)
      )
      addCheck(
        'required_code_tokens',
        hasBlock && missingTokens.length === 0,
        props.requiredCodeTokens.join(', '),
        missingTokens.length === 0 ? 'all present' : `missing: ${missingTokens.join(', ')}`,
        hasBlock && missingTokens.length === 0
          ? 'Code block contains all expected SDK/language constructs'
          : `Code block is missing expected constructs: ${missingTokens.join(', ')}`
      )
    }

    if (props.balancedBraces) {
      const balanced = hasBlock && hasBalancedDelimiters(combinedCode)
      addCheck(
        'balanced_code_delimiters',
        balanced,
        'balanced {}, (), []',
        balanced ? 'balanced' : 'unbalanced or missing code',
        balanced
          ? 'Code block has balanced braces, parentheses, and brackets'
          : 'Code block has unbalanced delimiters or is missing'
      )
    }

    if (props.requiresExplanationText) {
      const proseOutsideCode = output.replace(/```[\s\S]*?```/g, '').trim()
      const hasProse = proseOutsideCode.length >= 25
      addCheck(
        'code_explanation_prose',
        hasProse,
        '>= 25 chars of explanation outside code block',
        `${proseOutsideCode.length} chars`,
        hasProse
          ? 'Output includes prose context explaining the code solution'
          : 'Output lacks explanatory prose outside the code block'
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const totalCount = checks.length
  const allPassed = totalCount > 0 && passedCount === totalCount
  const score = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0

  return {
    id: evalCase.id,
    title: evalCase.title,
    phase: evalCase.phase,
    agentId: evalCase.agentId,
    task: evalCase.task,
    budget: evalCase.budget ?? null,
    promptRevision: evalCase.promptRevision,
    modelRevision: evalCase.modelRevision,
    automatedEvaluation: {
      verificationType: 'automated_structural',
      passed: allPassed,
      score,
      passedChecks: passedCount,
      totalChecks: totalCount,
      failedChecks: totalCount - passedCount,
      checks,
    },
    humanEvaluation: {
      verificationType: 'human_judgment_required',
      status: 'pending_human_review',
      automatedCannotVerify: true,
      criteria: [...(evalCase.humanReviewCriteria || [])],
    },
  }
}

/**
 * Compare an evaluation run summary against the checked-in baseline.
 */
export function compareWithBaseline(summary, baseline = EVALUATION_BASELINE_SUMMARY) {
  const caseDelta = summary.passedCases - baseline.passedCases
  const checkDelta = summary.passedAutomatedChecks - baseline.passedAutomatedChecks
  const scoreDelta = summary.score - baseline.score
  const regressed =
    summary.passedCases < baseline.passedCases ||
    summary.passedAutomatedChecks < baseline.passedAutomatedChecks ||
    summary.failedCases > baseline.failedCases

  return {
    baselineSuiteVersion: baseline.suiteVersion,
    currentSuiteVersion: summary.suiteVersion,
    matchesBaseline:
      !regressed &&
      summary.totalCases === baseline.totalCases &&
      summary.passedAutomatedChecks === baseline.passedAutomatedChecks,
    regressed,
    caseDelta,
    checkDelta,
    scoreDelta,
    status: regressed
      ? 'regression_detected'
      : checkDelta > 0
        ? 'improved_over_baseline'
        : 'matches_baseline',
  }
}

/**
 * Run the full offline evaluation suite deterministically without API keys,
 * Stellar wallets, or network access.
 *
 * @param {Object} [options]
 * @param {Array} [options.cases] - Custom evaluation cases (defaults to OFFLINE_EVALUATION_SET)
 * @param {Object} [options.fixtureOutputs] - Optional map of `{ [caseId]: outputString }` overrides
 * @param {Object} [options.baseline] - Baseline summary to compare against
 */
export function runOfflineQualityEvaluation(options = {}) {
  const cases = options.cases || OFFLINE_EVALUATION_SET
  const fixtureOutputs = options.fixtureOutputs || {}
  const revisionManifest = getEvaluationRevisionManifest()

  const caseResults = cases.map((evalCase) => {
    const candidateOutput = Object.prototype.hasOwnProperty.call(fixtureOutputs, evalCase.id)
      ? fixtureOutputs[evalCase.id]
      : evalCase.baselineFixtureOutput
    return evaluateOutputQualityCase(evalCase, candidateOutput)
  })

  const totalCases = caseResults.length
  const passedCases = caseResults.filter((r) => r.automatedEvaluation.passed).length
  const failedCases = totalCases - passedCases
  const totalAutomatedChecks = caseResults.reduce(
    (sum, r) => sum + r.automatedEvaluation.totalChecks,
    0
  )
  const passedAutomatedChecks = caseResults.reduce(
    (sum, r) => sum + r.automatedEvaluation.passedChecks,
    0
  )
  const failedAutomatedChecks = totalAutomatedChecks - passedAutomatedChecks
  const passRate =
    totalAutomatedChecks > 0 ? Number((passedAutomatedChecks / totalAutomatedChecks).toFixed(4)) : 0
  const score =
    totalAutomatedChecks > 0 ? Math.round((passedAutomatedChecks / totalAutomatedChecks) * 100) : 0

  const summary = {
    suiteVersion: EVALUATION_SUITE_VERSION,
    totalCases,
    passedCases,
    failedCases,
    totalAutomatedChecks,
    passedAutomatedChecks,
    failedAutomatedChecks,
    passRate,
    score,
    allPassed: failedCases === 0 && totalCases > 0,
    humanReviewStatus: 'pending_human_review',
    automatedCheckScopeNote:
      'Automated checks verify deterministic structural, schema, budget, and section invariants only. Factual accuracy, nuance, and domain appropriateness require human review against each case’s humanEvaluation.criteria.',
  }

  const baselineComparison = compareWithBaseline(
    summary,
    options.baseline || EVALUATION_BASELINE_SUMMARY
  )

  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    suiteVersion: EVALUATION_SUITE_VERSION,
    executionMode: 'offline-fixture',
    networkAccessRequired: false,
    apiKeysRequired: false,
    walletsRequired: false,
    revisions: revisionManifest,
    summary,
    baselineComparison,
    cases: caseResults,
  }
}

/**
 * Optional, separately cost-controlled live model evaluation runner.
 * Never runs unless `allowLiveModelCalls: true` (or `LIVE_EVAL_ENABLED=true`)
 * is explicitly passed and cost/call caps are within bounds.
 */
export async function runLiveQualityEvaluation(options = {}) {
  const liveEnabled =
    options.allowLiveModelCalls === true ||
    String(options.env?.LIVE_EVAL_ENABLED || process.env.LIVE_EVAL_ENABLED || '')
      .trim()
      .toLowerCase() === 'true'

  if (!liveEnabled) {
    const err = new Error(
      'Live model evaluation is disabled by default. Set allowLiveModelCalls: true or LIVE_EVAL_ENABLED=true to opt in.'
    )
    err.code = 'LIVE_EVAL_DISABLED'
    throw err
  }

  const maxCases = options.maxCases ?? 6
  const maxTotalTokens = options.maxTotalTokens ?? 4000
  const maxEstimatedUsd = options.maxEstimatedUsd ?? 0.05
  const cases = (options.cases || OFFLINE_EVALUATION_SET).slice(0, maxCases)

  if (cases.length > maxCases) {
    const err = new Error(`Requested ${cases.length} cases, exceeding maxCases=${maxCases}`)
    err.code = 'LIVE_EVAL_COST_CAP_EXCEEDED'
    throw err
  }

  const liveGenerator = options.generateOutput
  if (typeof liveGenerator !== 'function') {
    const err = new Error(
      'runLiveQualityEvaluation requires an explicit generateOutput(evalCase) function when live evaluation is opted in.'
    )
    err.code = 'LIVE_EVAL_GENERATOR_REQUIRED'
    throw err
  }

  const fixtureOutputs = {}
  let totalTokensUsed = 0
  let totalEstimatedUsd = 0

  for (const evalCase of cases) {
    const generated = await liveGenerator(evalCase)
    const text = typeof generated === 'string' ? generated : generated?.text || ''
    const tokens = Number(generated?.tokens || 0)
    const estimatedUsd = Number(generated?.estimatedUsd || 0)

    totalTokensUsed += tokens
    totalEstimatedUsd = Number((totalEstimatedUsd + estimatedUsd).toFixed(6))

    if (totalTokensUsed > maxTotalTokens || totalEstimatedUsd > maxEstimatedUsd) {
      const err = new Error(
        `Live evaluation cost cap exceeded (tokens: ${totalTokensUsed}/${maxTotalTokens}, est USD: ${totalEstimatedUsd}/${maxEstimatedUsd})`
      )
      err.code = 'LIVE_EVAL_COST_CAP_EXCEEDED'
      throw err
    }

    fixtureOutputs[evalCase.id] = text
  }

  const baseReport = runOfflineQualityEvaluation({
    cases,
    fixtureOutputs,
    baseline: options.baseline,
  })

  return {
    ...baseReport,
    executionMode: 'live-model',
    costControls: {
      maxCases,
      maxTotalTokens,
      maxEstimatedUsd,
      totalTokensUsed,
      totalEstimatedUsd,
    },
  }
}

/**
 * Format an evaluation report as reviewable Markdown that clearly separates
 * automated structural verification from human judgment criteria.
 */
export function formatQualityEvaluationReport(report) {
  const lines = [
    `# StellarMind Agent Output Quality Evaluation Report`,
    ``,
    `- **Schema Version**: \`${report.schemaVersion}\``,
    `- **Suite Version**: \`${report.suiteVersion}\``,
    `- **Execution Mode**: \`${report.executionMode}\``,
    `- **Revision Digest**: \`${report.revisions.revisionDigest}\``,
    `- **Automated Score**: **${report.summary.score}/100** (${report.summary.passedAutomatedChecks}/${report.summary.totalAutomatedChecks} checks passed across ${report.summary.passedCases}/${report.summary.totalCases} cases)`,
    `- **Baseline Status**: \`${report.baselineComparison.status}\` (case delta: ${report.baselineComparison.caseDelta}, check delta: ${report.baselineComparison.checkDelta})`,
    `- **Human Judgment Status**: \`${report.summary.humanReviewStatus}\``,
    ``,
    `## Prompt & Model Revisions`,
    ``,
    `| Phase / Agent | Prompt Revision | Model Revision |`,
    `| --- | --- | --- |`,
    `| \`planning\` | \`${report.revisions.prompts.planning}\` | \`${report.revisions.models.planning}\` |`,
    ...AGENTS.map(
      (agent) =>
        `| \`${agent.id}\` | \`${report.revisions.prompts[agent.id]}\` | \`${report.revisions.models[agent.id]}\` |`
    ),
    ``,
    `## Automated Checks vs. Human Judgment`,
    ``,
    `> ${report.summary.automatedCheckScopeNote}`,
    ``,
    `## Case Breakdown`,
    ``,
  ]

  for (const c of report.cases) {
    const badge = c.automatedEvaluation.passed ? 'PASS' : 'FAIL'
    lines.push(`### [${badge}] \`${c.id}\` — ${c.title}`)
    lines.push(``)
    lines.push(
      `- **Phase / Agent**: \`${c.phase}\` / \`${c.agentId}\` (\`${c.promptRevision}\`, \`${c.modelRevision}\`)`
    )
    lines.push(`- **Task**: ${c.task}`)
    lines.push(
      `- **Automated Structural Checks**: ${c.automatedEvaluation.passedChecks}/${c.automatedEvaluation.totalChecks} passed (${c.automatedEvaluation.score}%)`
    )
    for (const chk of c.automatedEvaluation.checks) {
      lines.push(
        `  - [${chk.passed ? 'x' : ' '}] \`${chk.name}\`: ${chk.message} (expected: \`${chk.expected}\`, actual: \`${chk.actual}\`)`
      )
    }
    lines.push(`- **Human Judgment Criteria (Manual Review Required)**:`)
    for (const criterion of c.humanEvaluation.criteria) {
      lines.push(`  - [ ] ${criterion}`)
    }
    lines.push(``)
  }

  return lines.join('\n')
}
