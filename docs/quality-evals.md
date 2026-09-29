# Agent output quality evaluations

A checked-in benchmark for the _content_ the agents return — the part the existing suites (API,
payments, budget, admission queue) do not look at. It answers one question: when a prompt, a model
or an agent changes, did the shape and the stated constraints of the output change too?

- Case set: [`eval/quality-set.json`](../eval/quality-set.json)
- Checks: [`src/eval/quality-checks.js`](../src/eval/quality-checks.js)
- Report: [`src/eval/quality-report.js`](../src/eval/quality-report.js)
- Runner: [`src/eval/run-quality-eval.js`](../src/eval/run-quality-eval.js)
- Baseline report: [`eval/baseline.json`](../eval/baseline.json)
- Captured outputs: [`eval/fixtures/`](../eval/fixtures)

## What a case is

Each case names the task the platform really routes, the agent/phase that answers it, and a list of
**structural success properties** — the parts a machine can decide the same way twice:

| Kind                                        | Decides                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| `section-headings`                          | the requested sections exist (so an answer is navigable)   |
| `contains-all` / `contains-any`             | required vocabulary or facts are present                   |
| `excludes-all`                              | filler, self-narration, internal jargon, placeholders      |
| `regex-all` / `regex-any`                   | a statement is quantified, code is asynchronous, and so on |
| `word-count`                                | the answer is substantive but still a briefing             |
| `bullet-count` / `bullet-word-count`        | list constraints were honoured, not paraphrased            |
| `json-shape`                                | structured answers parse and carry the required keys       |
| `code-fence-count` / `code-fence-max-lines` | runnable code, one block, small enough to review           |

Cases also carry `humanReview` questions. Those are printed in the report but **never scored** —
tone, usefulness and correctness are judgement calls, and pretending a regex decides them would be
the fastest way to make this suite worthless.

## Running it

```bash
npm run eval:quality                          # score eval/fixtures/baseline, print the Markdown report
npm run eval:quality -- --format json          # machine-readable report
npm run eval:quality -- --out /tmp/eval        # write quality-report.json + quality-report.md
npm run eval:quality -- --fixtures eval/fixtures/incomplete   # the deliberately broken captures
npm run eval:quality -- --check-baseline       # exit 1 when a result moved away from the baseline
npm run eval:quality -- --write-baseline       # accept the current results as the new baseline
```

The offline path needs **no keys, no wallets and no network** — outputs are read from files. The run
is deterministic: the report contains no timestamps and uses stable key ordering, so running it
twice produces byte-identical files (`--out` twice and compare the hashes is exactly what the test
suite asserts). A changed report therefore always means a changed result.

Exit codes: `0` all automated checks pass, `1` at least one check failed or the baseline drifted,
`2` the run could not start (malformed set, bad arguments).

## Baseline results

Committed baseline: [`eval/baseline.json`](../eval/baseline.json), produced from
`eval/fixtures/baseline` with the models currently registered in `src/agents/services.js`.

| Case                                     | Agent    | Automated checks |
| ---------------------------------------- | -------- | ---------------- |
| `research-oss-licence-tradeoffs`         | research | 4/4              |
| `summary-release-notes-for-stakeholders` | summary  | 4/4              |
| `analysis-cloud-cost-drivers`            | analysis | 4/4              |
| `code-retry-with-backoff`                | code     | 5/5              |

Total: **17/17** across 4 cases. The report records the revision it describes:

- `setRevision` — hash of the case set (tasks, properties, terms);
- `promptRevisions[caseId]` — hash of one case's task and properties;
- `modelRevision` — the model ids the run was bound to, read from the single model registry
  (`AGENT_MODELS`), e.g. `research=claude-haiku-4-5-…`.

The deliberately incomplete captures in `eval/fixtures/incomplete` exist to prove the checks can
fail: they score **5/17** and the report names the reason for each failure
(`missing section(s): Recommendation`, `0 pattern(s) matched (needed 2)`,
`contains disallowed: TODO`, …). A suite that cannot fail is a suite that measures nothing.

## Accepting an intentional quality change

1. Change the prompt, model or agent behaviour.
2. Capture the new output into the relevant fixture file under `eval/fixtures/` (or run `--live`,
   below, to capture it directly).
3. Run `npm run eval:quality -- --check-baseline`. The report lists exactly what moved
   (`result changed: <case>/<property> pass -> FAIL`, `set revision changed: …`).
4. Decide, per difference, whether it is an improvement. If yes, run
   `npm run eval:quality -- --write-baseline` and include the new `eval/baseline.json` **and** the
   updated fixture in the same pull request, with one line in the PR body explaining each accepted
   change. If no, fix the change instead.
5. `npm test` fails while the committed baseline disagrees with the fixtures, so a silent quality
   drift cannot be merged.

Adding a case is the same loop: extend `eval/quality-set.json`, add
`eval/fixtures/baseline/<case-id>.txt`, regenerate the baseline. Keeping the set small and
non-sensitive matters more than covering everything — these are prompts anyone can read.

## Optional live evaluation (cost-controlled)

Live runs spend real tokens, so they are opt-in and cannot be triggered by a test run:

```bash
ANTHROPIC_API_KEY=… EVAL_LIVE_CONFIRM=4 npm run eval:quality -- --live --format md
```

- `EVAL_LIVE_CONFIRM` must state how many cases the operator accepts being billed for; the runner
  refuses when the selection is larger than that number.
- `--max-cases N` narrows the run to the first N cases, so a spot check costs one call.
- Nothing in CI uses `--live`; the offline fixtures are the regression gate.
- Outputs captured live can be saved as fixtures to turn a spot check into a permanent case.
