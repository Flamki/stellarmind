# Agent output quality evaluation

A small, versioned, offline evaluation set for the agents (issue #154). It tells a reviewer, in a
reviewable report, whether a prompt or model change made agent output structurally worse. It runs
with no API key, no wallet and no network.

## What it is and is not

- **Automated structural checks** (machine-scored): required sections, counts, figures kept, valid
  code syntax, valid plans, plans within budget. Deterministic, so they can gate CI.
- **Human judgment** (never scored by the tool): whether an answer is true, useful or well written.
  Each case lists questions for a reviewer, and verdicts are recorded by hand.

A passing report means the structure is intact. It does not mean the answers are good.

## Layout

| Path                       | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `evals/cases.v1.json`      | The versioned set: cases, properties, human-review questions   |
| `evals/fixtures/<case>/`   | `pass.txt` reference output and `incomplete-*.txt` bad outputs |
| `evals/reviews.v1.json`    | Human verdicts, recorded by hand                               |
| `evals/baseline/`          | Committed baseline report (`report.json`, `report.md`)         |
| `evals/lib/`               | Loader, checks, report builder, optional live runner           |
| `evals/run.js`             | Command line entry point                                       |
| `tests/eval-suite.test.js` | Tests for the suite itself                                     |

## Case format

Each case defines the task, the agent and phase, and concrete success properties.

```json
{
  "id": "summary-budget-memo",
  "agent": "summary-bot",
  "phase": "execute",
  "task": "Summarize this memo ...",
  "properties": [
    {
      "id": "three_sentences",
      "description": "Exactly 3 sentences",
      "check": "sentence_count",
      "args": { "min": 3, "max": 3 }
    }
  ],
  "humanReview": ["Does the summary keep the decision and its reason?"],
  "fixtures": {
    "pass": "pass.txt",
    "negative": [
      {
        "file": "incomplete-two-sentences.txt",
        "note": "Only two sentences",
        "expectFail": ["three_sentences"]
      }
    ]
  }
}
```

- `phase` is `execute` for the four worker agents and `plan` for the `orchestrator`.
- Plan cases need `context.budget` (USDC) and are checked with the real `parsePlanResponse`,
  `validatePlan` and registry prices.
- Every case needs at least one **incomplete fixture**. `expectFail` lists exactly which properties
  it must break, so a check that drifts (stops failing, or fails for a new reason) fails the suite.

### Check catalog

| Group     | Checks                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text      | `not_empty`, `ends_cleanly`, `word_count`, `sentence_count`, `contains_all`, `contains_any`, `not_contains`, `matches`, `not_matches`, `max_word_ratio_of_input` |
| Structure | `headings`, `section_bullets`                                                                                                                                    |
| Code      | `code_block`, `js_syntax` (parsed with `vm.Script`, never executed)                                                                                              |
| Plans     | `plan_valid`, `plan_subtasks`, `plan_agents`, `plan_within_budget`, `plan_input_mentions`                                                                        |

## Running

```bash
npm run eval          # score reference + incomplete outputs and compare with the baseline
npm run test:eval     # tests for the suite (also part of npm test)
node evals/run.js --out /tmp/report   # write a report somewhere else
```

Exit code `0` means healthy and matching the baseline, `1` a failure, `2` a usage error.

## Reading the report

The report (`evals/baseline/report.md`) has:

1. **Revisions under evaluation**: the model and prompt revision of each agent, taken from the code
   (`promptRevision` is the same `sha256:` digest recorded in run provenance, see
   [architecture.md](architecture.md#output-provenance-model-and-prompt-153)). The planner prompt is
   inline in `orchestrator.js` and has no revision yet.
2. **Automated structural checks (machine-scored)**: per case, properties passed and incomplete
   outputs rejected.
3. **Human judgment (not scored by this tool)**: review status per case and the open questions.

Reports contain no timestamps or absolute paths and use code-point ordering and LF line endings, so
two runs (and Windows and Linux checkouts) produce identical bytes.

## Accepting an intentional quality change

The committed baseline is the record of expected quality. `npm run eval` fails when it differs from
a fresh run, for example after a prompt edit, a model change, or a changed expectation.

1. Make the change (prompt, model, case or fixture).
2. Run `npm run eval`. Read the failure: it names the differing baseline file.
3. If the change is intended, run `npm run eval:accept` and commit the updated `evals/baseline/`.
4. In the PR, explain why the new revision or expectation is acceptable. Reviewers read the baseline
   diff.
5. If a reference output now fails a property, or an incomplete output is no longer rejected, the
   suite is unhealthy and `eval:accept` refuses. Fix the output or the property first.
6. Bump `version` in `cases.v1.json` when the meaning of a case changes, so older human reviews go
   stale.

## Recording human review

Add an entry to `evals/reviews.v1.json` after reading the real output for a case:

```json
{
  "caseId": "summary-budget-memo",
  "reviewer": "github-handle",
  "reviewedAt": "2026-01-31",
  "evalSetVersion": "1.0.0",
  "promptRevision": "sha256:0dd510a132bb174b",
  "verdict": "accept"
}
```

`verdict` is `accept` or `needs-work`. A review whose `evalSetVersion` or `promptRevision` no longer
matches is reported as `stale`. Human verdicts never change the automated score.

## Optional live evaluation

Live evaluation calls the real models and costs money, so it is separate and off by default.

```bash
EVAL_LIVE=1 ANTHROPIC_API_KEY=... npm run eval:live -- --cases research-http-402,code-chunk-array
```

| Control                                               | Default | Meaning                           |
| ----------------------------------------------------- | ------- | --------------------------------- |
| `EVAL_LIVE=1`                                         | off     | Required opt-in                   |
| `--max-cases` / `EVAL_LIVE_MAX_CASES`                 | 4       | Most cases to run                 |
| `--max-output-tokens` / `EVAL_LIVE_MAX_OUTPUT_TOKENS` | 2400    | Worst-case output tokens reserved |

- The worst-case `max_tokens` of each case is reserved before it runs, so the cap cannot be
  exceeded.
- The run stops at the first provider error.
- Demo or fallback answers are never scored as live results.
- Planning cases are skipped (they would need wallet-backed planning).
- Reports go to `evals/reports/` (git-ignored). They record the actual model and prompt revision and
  are never compared with the offline baseline.

## Baseline results

Eval set `stellarmind-agent-quality` 1.0.0, 12 cases.

| Measure                                 | Result |
| --------------------------------------- | ------ |
| Properties passing on reference outputs | 90/90  |
| Incomplete outputs rejected as expected | 25/25  |
| Human reviews recorded                  | 0/12   |

## Limitations

- Structure only. Truth, relevance and tone need a human.
- Reference outputs are hand-written, so the baseline does not measure real model behavior.
- Code is syntax-checked, never executed.
- The planner prompt has no revision yet.
