# Agent Output Quality Evaluation Suite

StellarMind includes a versioned, deterministic offline evaluation suite
(`src/agents/quality-eval.js`, re-exported from `src/agents/orchestrator.js`) to benchmark output
quality across orchestrator planning and all four specialist agents (`research-bot`, `summary-bot`,
`analyst-bot`, and `code-bot`).

## Design Goals

1. **Zero External Dependencies Offline**: Offline structural evaluation runs without an Anthropic
   API key, Stellar wallets, Horizon/RPC endpoints, or network access.
2. **Explicit Case Contracts**: Each benchmark case defines a non-sensitive `task`, `phase`,
   `agentId`, `promptRevision`, `modelRevision`, concrete `expectedProperties` for automated
   checking, and `humanReviewCriteria` for manual review.
3. **Automated Structural Checks vs. Human Judgment**: Scoring reports explicitly separate what
   deterministic automated checks verify (JSON schema validity, budget adherence, required sections,
   bullet counts, sentence bounds, source attribution, fenced code blocks, balanced delimiters, and
   placeholder/secret hygiene) from qualitative dimensions that require human judgment (factual
   accuracy, analytical nuance, and idiomatic SDK usage).
4. **Opt-In, Cost-Controlled Live Model Evaluation**: Live provider evaluation is disabled by
   default (`LIVE_EVAL_DISABLED`) and guarded by explicit call, token, and USD caps when opted in.

## Running the Offline Evaluation Suite

```bash
npm run test:eval
# or directly:
node tests/offline-eval-set.test.js
```

## Curated Benchmark Cases (`v1.0.0`)

| Case ID            | Phase / Agent                       | Prompt Revision          | Model Revision               | Automated Structural Properties                                                                                                                                     | Human Judgment Criteria                                            |
| ------------------ | ----------------------------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `eval-planning-01` | `planning` / `orchestrator-planner` | `planning-prompt-v1.0.0` | `claude-haiku-4-5-20251001`  | Valid plan JSON, 2–3 subtasks, total planned cost `<= 0.0800 USDC`, includes `research-bot` & `summary-bot`, mentions `x402` & `stellar`                            | Logical dependency ordering and non-redundant subtask instructions |
| `eval-planning-02` | `planning` / `orchestrator-planner` | `planning-prompt-v1.0.0` | `claude-haiku-4-5-20251001`  | Valid plan JSON, 1–2 subtasks, total planned cost `<= 0.0200 USDC`, includes `research-bot`, excludes unaffordable `analyst-bot` & `code-bot`                       | Respects tight budget without dropping core task intent            |
| `eval-research-01` | `agent` / `research-bot`            | `research-prompt-v1.0.0` | `claude-haiku-4-5-20251001`  | 180–2500 chars, `>= 3` bullets, 3–15 sentences, required terms (`x402`, `stellar`, `settlement`), `Sources:` attribution                                            | Factual accuracy of Stellar finality and fee economics             |
| `eval-summary-01`  | `agent` / `summary-bot`             | `summary-prompt-v1.0.0`  | `claude-haiku-4-5-20251001`  | 120–900 chars, 2–6 sentences, `Key Takeaway` section, required terms (`x402`, `stellar`, `payment`)                                                                 | Fidelity to source text and concise executive tone                 |
| `eval-analysis-01` | `agent` / `analyst-bot`             | `analysis-prompt-v1.0.0` | `claude-sonnet-4-5-20250929` | 250–3000 chars, `Key Findings`, `Risks`, and `Opportunities` sections, `>= 6` bullets, required terms (`x402`, `stellar`, `budget`)                                 | Depth of risk analysis and practicality of opportunities           |
| `eval-code-01`     | `agent` / `code-bot`                | `code-prompt-v1.0.0`     | `claude-haiku-4-5-20251001`  | 200–3500 chars, fenced code block, tokens (`TransactionBuilder`, `Operation.payment`, `Networks.TESTNET`, `async function`), balanced delimiters, explanatory prose | Correct `@stellar/stellar-sdk` usage and secret handling           |

## Baseline Results (`EVALUATION_SUITE_VERSION = 1.0.0`)

- **Suite Version**: `1.0.0`
- **Total Cases**: `6` (`6 passed`, `0 failed`)
- **Total Automated Checks**: `49` (`49 passed`, `0 failed`)
- **Automated Pass Rate / Score**: `1.0` (`100/100`)
- **Deliberately Incomplete Fixture Verification**: All `6` negative fixtures in
  `DELIBERATELY_INCOMPLETE_FIXTURES` fail automated structural checks and trigger
  `baselineComparison.status = "regression_detected"`.

## Process for Accepting Intentional Prompt, Model, or Quality Changes

When intentionally modifying an agent prompt template, default model ID, or output structure:

1. **Bump the Revision Identifier**:
   - Update `AGENT_PROMPT_REVISIONS` in `src/agents/services.js` and `PROMPT_REVISIONS` /
     `MODEL_REVISIONS` in `src/agents/quality-eval.js` (or `PLANNING_PROMPT_REVISION` in
     `src/agents/orchestrator.js`).
   - If adding or tightening benchmark cases, increment `EVALUATION_SUITE_VERSION`.
2. **Update Expected Properties & Fixtures**:
   - Adjust `expectedProperties` and `baselineFixtureOutput` in `OFFLINE_EVALUATION_SET` to reflect
     the new structural contract, and ensure `DELIBERATELY_INCOMPLETE_FIXTURES` still exercises
     failure paths.
3. **Run Offline Determinism & Regression Verification**:
   - Run `node tests/offline-eval-set.test.js` twice and confirm both runs produce identical
     `revisions.revisionDigest` and scoring output.
4. **Complete Human Judgment Review**:
   - Generate the Markdown report via `formatQualityEvaluationReport(runOfflineQualityEvaluation())`
     and verify every item under `Human Judgment Criteria (Manual Review Required)` in the pull
     request description.
5. **Update Checked-In Baseline**:
   - Update `EVALUATION_BASELINE_SUMMARY` in `src/agents/quality-eval.js` and the baseline table in
     this document so future runs compare against the newly accepted baseline.

## Optional Cost-Controlled Live Evaluation

Live model evaluation is strictly opt-in and never runs during standard `npm test` or CI runs. To
evaluate live model outputs under explicit cost caps:

```javascript
import { runLiveQualityEvaluation } from './src/agents/quality-eval.js'

const liveReport = await runLiveQualityEvaluation({
  allowLiveModelCalls: true,
  maxCases: 6,
  maxTotalTokens: 4000,
  maxEstimatedUsd: 0.05,
  generateOutput: async (evalCase) => {
    // Call live provider and return { text, tokens, estimatedUsd }
  },
})
```
